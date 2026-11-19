// test/integration/real-data.test.ts —— 真实数据面：大 cargo 失败输出与真 git 仓库的大 log。
// 数据在测试现场生成（cargo 编译一个 15 个失败测试的 crate、git fast-import 一个 120 提交的仓库），
// 再经真 rtk CLI 与官方 LocalSpillStore 走完整条 pipe 流水线。期望值取自 rtk 与 cargo 的真实输出，
// 不从本包实现推导；没有 cargo / rtk 的机器按 DSH_RTK_TEST_MODE 的既有口径跳过。
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, beforeAll, beforeEach, describe, it } from "vitest";

import {
  makeCleanups,
  probeRealRtk,
  realSubprocess,
  rtkTestMode,
  startPipeHost,
} from "./host-stack.ts";

const cleanups = makeCleanups();

const mode = rtkTestMode();

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runProcess = (
  argv: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
): Promise<RunResult> =>
  // oxlint-disable-next-line promise/avoid-new -- spawn 只能靠事件回调收束，没有内置 Promise 形态
  new Promise((resolve, reject) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(options.input);
  });

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
};

/** 一个编译得动、15 个测试全失败的 crate：每个失败测试打印 250 行，stdout 远超内联预算。 */
const writeCargoCrate = (dir: string): void => {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "Cargo.toml"),
    ["[package]", 'name = "bigfail"', 'version = "0.1.0"', 'edition = "2021"', ""].join("\n"),
  );
  const lines = ["pub fn add(a: i32, b: i32) -> i32 { a + b }"];
  for (let i = 1; i <= 15; i += 1) {
    lines.push(
      `#[test] fn fails_${String(
        i,
      )}() { for k in 0..250 { println!("line {:05} of failing test ${String(
        i,
      )}", k); } assert_eq!(add(1, 1), 3, "test ${String(i)}"); }`,
    );
  }
  writeFileSync(path.join(dir, "src", "lib.rs"), `${lines.join("\n")}\n`);
};

const cargoFailureOutput = async (): Promise<string> => {
  const dir = tempDir("rtk-real-cargo-");
  writeCargoCrate(dir);
  const result = await runProcess(["cargo", "test", "--offline"], { cwd: dir });
  assert.equal(result.status, 101, `cargo test 有失败测试时应退 101：${result.stderr}`);
  assert.ok(
    result.stdout.includes("running 15 tests"),
    `cargo 没有跑出 15 个测试：${result.stderr}`,
  );
  return result.stdout;
};

const gitLogOutput = async (): Promise<string> => {
  const dir = tempDir("rtk-real-git-");
  const init = await runProcess(["git", "init", "-q", "-b", "main"], { cwd: dir });
  assert.equal(init.status, 0, init.stderr);
  for (const argv of [
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- 两条 config 写同一个 .git/config，并发会抢锁
    const configured = await runProcess(["git", ...argv], { cwd: dir });
    assert.equal(configured.status, 0, configured.stderr);
  }
  const stream: string[] = [];
  for (let i = 1; i <= 120; i += 1) {
    stream.push("commit refs/heads/main");
    stream.push(`committer T <t@t> ${String(1_600_000_000 + i)} +0000`);
    stream.push("data <<EOM");
    stream.push(`commit ${String(i)}: change ${String(i)}`);
    stream.push("EOM");
    stream.push(`M 644 inline file-${String(i)}.txt`);
    stream.push("data <<EOM");
    stream.push(`content ${String(i)}`);
    stream.push("EOM");
  }
  const imported = await runProcess(["git", "fast-import", "--quiet"], {
    cwd: dir,
    input: `${stream.join("\n")}\n`,
  });
  assert.equal(imported.status, 0, imported.stderr);
  const log = await runProcess(["git", "log", "--oneline"], { cwd: dir });
  assert.equal(log.status, 0, log.stderr);
  assert.equal(log.stdout.trim().split("\n").length, 120, "git log 应有 120 个提交");
  return log.stdout;
};

interface DecisionView {
  readonly kind?: string;
  readonly value?: Record<string, unknown>;
  readonly additionalContexts?: readonly {
    readonly content?: readonly { readonly text?: string }[];
  }[];
}

const decisionOf = (out: { readonly decision: unknown }): DecisionView | undefined =>
  out.decision as DecisionView | undefined;

const stdoutTextOf = (value: Record<string, unknown>): string => {
  const { stdout } = value;
  assert.ok(typeof stdout === "object" && stdout !== null, "回执没有 stdout");
  const { text } = stdout as Record<string, unknown>;
  assert.equal(typeof text, "string", "stdout.text 不是字符串");
  return text as string;
};

const noticeTextOf = (decision: DecisionView): string =>
  (decision.additionalContexts ?? [])
    .flatMap((block) => (block.content ?? []).map((part) => part.text ?? ""))
    .join("\n");

const spillFileOf = (root: string): string => {
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((name) =>
    name.endsWith(".txt"),
  );
  assert.equal(files.length, 1, "官方 spill 后端应写且只写一个 .txt");
  return path.join(root, files[0] ?? "");
};

const hashesOf = (source: string): ReadonlySet<string> => {
  const matched = source.match(/[0-9a-f]{7,40}/gu);
  if (matched === null) {
    return new Set<string>();
  }
  return new Set(matched);
};

const assertSpillHeld = (root: string, original: string): string => {
  const file = spillFileOf(root);
  assert.equal(readFileSync(file, "utf8"), original, "spill 文件必须与压缩前原文逐字相同");
  assert.equal(
    statSync(file).size,
    Buffer.byteLength(original, "utf8"),
    "spill 字节数必须等于原文",
  );
  if (process.platform !== "win32") {
    // NTFS 没有 POSIX 权限位，`mode` 在 win32 上不表达 owner-only。
    assert.equal(statSync(file).mode % 0o1000, 0o600, "spill 文件必须是 owner-only");
  }
  return file;
};

describe("真 cargo 大输出：失败题头对账与原文落盘", () => {
  let skipReason: string | undefined;

  beforeAll(async () => {
    const version = await probeRealRtk();
    if (mode === "real" && version === undefined) {
      throw new Error(
        "DSH_RTK_TEST_MODE=real 但 PATH 上没有 rtk：先 brew install rtk，或把开关设成 fake / auto",
      );
    }
    if (mode === "fake" || version === undefined) {
      skipReason = mode === "fake" ? "DSH_RTK_TEST_MODE=fake" : "PATH 上没有 rtk";
      return;
    }
    const cargoProbe = await runProcess(["cargo", "--version"], { cwd: tmpdir() }).catch(
      () => null,
    );
    if (cargoProbe?.status !== 0) {
      skipReason = "PATH 上没有 cargo";
    }
  });

  beforeEach(({ skip }) => {
    if (skipReason !== undefined) {
      skip(skipReason);
    }
  });

  it("15 个失败测试的 113KB stdout：rtk 压缩、题头补对账、官方 spill 保存全文", async () => {
    const original = await cargoFailureOutput();
    const spillRoot = tempDir("rtk-spill-cargo-");
    const subprocess = realSubprocess();
    const host = startPipeHost({ spillRoot, subprocess, pipeTimeoutMs: 3000 });
    try {
      const out = await host.run(original, { command: "cargo test", callId: "call-cargo" });
      assert.equal(out.piped, 1, "真 rtk pipe 应被调用一次");
      assert.deepEqual(subprocess.spawns[0]?.argv, ["rtk", "pipe", "-f", "cargo-test"]);
      const decision = decisionOf(out);
      assert.equal(decision?.kind, "accept");
      assert.ok(decision?.value !== undefined, "接受的 decision 没有 value");
      const text = stdoutTextOf(decision.value);
      assert.match(text, /FAILURES \(\d+\):/u);
      assert.equal((original.match(/^---- .+ stdout ----$/gmu) ?? []).length, 15);
      assert.ok(
        text.includes("this run has 15 failing tests"),
        "失败题头下必须补上真实失败测试数的对账",
      );
      assert.ok(Buffer.byteLength(text, "utf8") < Buffer.byteLength(original, "utf8"));
      const spillFile = assertSpillHeld(spillRoot, original);
      assert.ok(noticeTextOf(decision).includes(spillFile), "取回路径必须写进 additionalContexts");
    } finally {
      host.dispose();
      cleanups.drain();
    }
  }, 120_000);
});

describe("真 git 仓库的大 log：丢 hash 时走放宽 + 原文落盘", () => {
  let skipReason: string | undefined;

  beforeAll(async () => {
    const version = await probeRealRtk();
    if (mode === "real" && version === undefined) {
      throw new Error(
        "DSH_RTK_TEST_MODE=real 但 PATH 上没有 rtk：先 brew install rtk，或把开关设成 fake / auto",
      );
    }
    if (mode === "fake" || version === undefined) {
      skipReason = mode === "fake" ? "DSH_RTK_TEST_MODE=fake" : "PATH 上没有 rtk";
    }
  });

  beforeEach(({ skip }) => {
    if (skipReason !== undefined) {
      skip(skipReason);
    }
  });

  it("120 提交的 git log 被 rtk 折叠掉 hash：插件必须落 spill 并在正文写出取回路径", async () => {
    const original = await gitLogOutput();
    const spillRoot = tempDir("rtk-spill-git-");
    const subprocess = realSubprocess();
    const host = startPipeHost({
      filtersOf: () => ["git-log", "cargo-test", "pytest"],
      spillRoot,
      subprocess,
      pipeTimeoutMs: 3000,
    });
    try {
      const out = await host.run(original, { command: "git log", callId: "call-git" });
      assert.equal(out.piped, 1, "真 rtk pipe 应被调用一次");
      assert.deepEqual(subprocess.spawns[0]?.argv, ["rtk", "pipe", "-f", "git-log"]);
      const decision = decisionOf(out);
      assert.equal(decision?.kind, "accept");
      assert.ok(decision?.value !== undefined, "接受的 decision 没有 value");
      const text = stdoutTextOf(decision.value);
      assert.ok(text.startsWith("这一段删掉了 "), "丢了 hash 的压缩体必须带放宽说明");
      assert.ok(text.includes("[+"), "rtk 的折叠标记应保留");
      assert.ok(Buffer.byteLength(text, "utf8") < Buffer.byteLength(original, "utf8"));
      const spillFile = assertSpillHeld(spillRoot, original);
      assert.ok(text.includes(spillFile), "放宽说明里的取回路径必须与 spill 文件一致");
      assert.ok(
        hashesOf(text).size < hashesOf(original).size,
        "这是丢 hash 的用例，压缩体应少 hash",
      );
    } finally {
      host.dispose();
      cleanups.drain();
    }
  }, 120_000);
});
