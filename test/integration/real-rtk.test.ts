// test/integration/real-rtk.test.ts —— 真实 rtk CLI 回路。
//
// 这条回路的价值：前面的夹具再真，rtk 那一腿仍是按用例写死的回执。这里让插件真的 spawn
// 本机那支 `rtk`，用**它自己的输出**验证协议（rewrite 的 rc=3 也算改写、pipe 的过滤结果被采用）。
// 开关 `DSH_RTK_TEST_MODE`：fake = 一律跳过，real = 必须有真 rtk（缺了当场红），
// 缺省 auto = 装了就跑、没装就跳过。探针放在 beforeAll 里：缺件只会跳过或判红，不会在
// 收集阶段挂住整个 vitest 进程（见 probeRealRtk 的注释）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, assert, beforeAll, beforeEach, describe, it } from "vitest";

import { pipelineToml } from "../../lib/rtk-hook.ts";
import { prepareHookConfig, resolveHookPaths } from "../../lib/rtk-paths.ts";
import type { SpillStoreStub } from "./host-stack.ts";

import {
  makeCleanups,
  probeRealRtk,
  realSubprocess,
  rtkTestMode,
  spillStub,
  startPipeHost,
  startPrefixHost,
} from "./host-stack.ts";

const mode = rtkTestMode();

const CARGO_TEST = "cargo test";
const BUILD_SCRIPT = "./scripts/build.sh";
const COMPOUND = "cd /tmp && cargo test";
const ALREADY_RTK = "rtk cargo test";
const PASSTHROUGH = "echo hi";
const REWRITTEN_RECORD = "prefix-rewritten";
const CARGO_FAILURE_LOG =
  "   Compiling sample v0.1.0\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.71s\n     Running unittests src/lib.rs\n\nrunning 2 tests\ntest tests::ok ... ok\ntest tests::bad ... FAILED\n\nfailures:\n\n---- tests::bad stdout ----\n\nthread 'tests::bad' panicked at src/lib.rs:8:16:\nassertion `left == right` failed: sum must match\n  left: 4\n right: 5\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\nfailures:\n    tests::bad\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nerror: test failed, to rerun pass `--lib`";
const RAW = `running 1 test\ntest result: ok. 1 passed; 0 failed\n${"log line\n".repeat(40)}[exit code: 0]`;

const exec = (): Record<string, unknown> => ({
  callId: "real-call-1",
  name: "bash",
  arguments: { command: CARGO_TEST },
  signal: new AbortController().signal,
});

/** 从 PostToolDecision 里取结果面正文（成功支的 value.stdout.text）。 */
const stdoutText = (decision: unknown): string => {
  if (typeof decision !== "object" || decision === null) {
    return "";
  }
  const { value } = decision as { value?: unknown };
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const { stdout } = value as { stdout?: unknown };
  if (typeof stdout !== "object" || stdout === null) {
    return "";
  }
  const { text } = stdout as { text?: unknown };
  return typeof text === "string" ? text : "";
};

describe("真实 rtk CLI 回路", () => {
  let version: string | undefined;

  beforeAll(async () => {
    version = await probeRealRtk();
    if (mode === "real" && version === undefined) {
      throw new Error(
        "DSH_RTK_TEST_MODE=real 但 PATH 上没有 rtk：先 brew install rtk，或把开关设成 fake / auto",
      );
    }
  });

  beforeEach(({ skip }) => {
    if (mode === "fake" || version === undefined) {
      skip(mode === "fake" ? "DSH_RTK_TEST_MODE=fake" : "PATH 上没有 rtk");
    }
  });

  const cleanups = makeCleanups();

  afterAll(() => {
    cleanups.drain();
  });

  it("真 rtk 的 rewrite 被认成改写：遮蔽层执行的确实是 rtk 改写后的命令", async () => {
    const subprocess = realSubprocess();
    const host = await startPrefixHost({ subprocess });
    try {
      const shadow = host.withAgent("sess-real");
      await shadow.execute({ command: CARGO_TEST }, exec());
      const [spawn] = subprocess.spawns;
      assert.ok(spawn !== undefined);
      assert.deepEqual(spawn.argv, ["rtk", "rewrite", CARGO_TEST]);
      assert.equal(host.fake.received.length, 1);
      const executed = host.fake.received[0] ?? "";
      // 只钉"真 CLI 判成改写、插件照它执行"这个方向：具体词形随 rtk 升级变，所以不断言字面量。
      assert.ok(executed.startsWith("rtk "), `实际执行的命令是 ${executed}`);
      assert.ok(executed.includes(CARGO_TEST));
      assert.ok(
        host.prefixRecords.some((record) => record.kind === REWRITTEN_RECORD),
        "改写成功要落一条 prefix-rewritten 账",
      );
    } finally {
      await host.disposeFiber();
    }
  });

  it("真 rtk 的复合命令改写被整条采用：只给承载输出的那一段加前缀", async () => {
    const subprocess = realSubprocess();
    const host = await startPrefixHost({ subprocess });
    try {
      const shadow = host.withAgent("sess-compound");
      await shadow.execute({ command: COMPOUND }, exec());
      const [spawn] = subprocess.spawns;
      assert.ok(spawn !== undefined);
      assert.deepEqual(spawn.argv, ["rtk", "rewrite", COMPOUND]);
      assert.equal(host.fake.received.length, 1);
      const executed = host.fake.received[0] ?? "";
      assert.ok(executed.startsWith("cd /tmp && "), `实际执行的命令是 ${executed}`);
      assert.ok(executed.includes("rtk "), `实际执行的命令是 ${executed}`);
      assert.ok(
        host.prefixRecords.some((record) => record.kind === REWRITTEN_RECORD),
        "复合命令改写成功也要落 prefix-rewritten 账",
      );
    } finally {
      await host.disposeFiber();
    }
  });

  it("真 rtk 的 pipe 过滤结果被采用：正文变短、结论行与 marker 都还在", async () => {
    const subprocess = realSubprocess();
    const host = startPipeHost({ subprocess, spillStore: spillStub(), pipeTimeoutMs: 3000 });
    try {
      const out = await host.run(RAW, { command: CARGO_TEST });
      assert.equal(out.piped, 1);
      const [spawn] = subprocess.spawns;
      assert.ok(spawn !== undefined);
      assert.deepEqual(spawn.argv, ["rtk", "pipe", "-f", "cargo-test"]);
      const text = stdoutText(out.decision);
      assert.ok(text.includes("test result: ok"), `压缩结果是 ${text}`);
      assert.ok(text.length < RAW.length);
      assert.ok(text.includes("[exit code: 0]"), "marker 必须由 reassemble 补回来");
    } finally {
      host.dispose();
    }
  });

  it("真 rtk 的清理链被采用：hook 路径把连续重复行折成计数，正文变短", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "rtk-real-hook-"));
    cleanups.push(sandbox);
    const env = { HOME: sandbox, USERPROFILE: sandbox, DSH_HOME: sandbox };
    const paths = resolveHookPaths(env);
    const configDir = prepareHookConfig(paths, pipelineToml());
    assert.ok(configDir !== undefined);
    const hook = {
      configDir,
      home: paths.home,
      dbPath: paths.dbPath,
      recallDb: path.join(sandbox, "recall.db"),
    };
    const subprocess = realSubprocess();
    const store: SpillStoreStub = {
      saved: [],
      saveText: (input: unknown) => {
        const { content } = input as { content?: unknown };
        const text = typeof content === "string" ? content : "";
        return Promise.resolve({
          locator: "/tmp/dsh-spill/real-hook.log",
          bytes: Buffer.byteLength(text, "utf8"),
          retrievalHint: "grep this path",
        });
      },
    };
    const host = startPipeHost({
      filters: ["hook"],
      hook: () => hook,
      spillStore: store,
      subprocess,
      // 真 rtk 的进程启动在 Windows 上可能超过 300ms；台架缺省那档是给内存桩用的。
      pipeTimeoutMs: 3000,
    });
    const noisy = Array.from({ length: 200 }).fill("[WARN] duplicate warning line").join("\n");
    try {
      const out = await host.run(noisy, { command: BUILD_SCRIPT });
      assert.equal(
        (out.decision as { readonly kind?: string } | undefined)?.kind,
        "accept",
        "hook 路径没有接受决定（fail-open 时这里会是 undefined）",
      );
      assert.equal(host.hookCalls(), 1);
      assert.equal(out.piped, 0);
      const text = stdoutText(out.decision);
      assert.ok(text.length < noisy.length, "压缩结果必须比原文短");
      assert.match(
        text,
        /\[x\d+\]/u,
        `rtk 的 dedup 计数标记要留在正文里，实际输出：${text.slice(0, 300)}`,
      );
      assert.ok(
        host.hookStdin().includes('"tool_name":"Bash"'),
        "载荷必须用 Claude 认的 tool_name",
      );
    } finally {
      host.dispose();
    }
  });

  it("真 rtk 的失败摘要被采用：rtk 的 FAILURES 计数由插件补一句对账", async () => {
    const subprocess = realSubprocess();
    const host = startPipeHost({ subprocess, spillStore: spillStub(), pipeTimeoutMs: 3000 });
    try {
      const out = await host.run(CARGO_FAILURE_LOG, { command: CARGO_TEST });
      assert.equal(out.piped, 1);
      const [spawn] = subprocess.spawns;
      assert.ok(spawn !== undefined);
      assert.deepEqual(spawn.argv, ["rtk", "pipe", "-f", "cargo-test"]);
      const text = stdoutText(out.decision);
      assert.ok(text.includes("FAILURES (3):"), `压缩结果是 ${text}`);
      assert.ok(text.includes("this run has 1 failing tests"), "题头后的对账句必须在");
      assert.ok(text.includes("test result: FAILED"));
      assert.ok(Buffer.byteLength(text, "utf8") < Buffer.byteLength(CARGO_FAILURE_LOG, "utf8"));
    } finally {
      host.dispose();
    }
  });

  it("真 rtk 对已是 rtk 形态的命令不再改写：一次 rewrite 都不 spawn，原命令照发", async () => {
    const subprocess = realSubprocess();
    const host = await startPrefixHost({ subprocess });
    try {
      const shadow = host.withAgent("sess-already");
      await shadow.execute({ command: ALREADY_RTK }, exec());
      assert.equal(subprocess.spawns.length, 0, "already-rtk 这条闸门必须在 spawn 之前");
      assert.equal(host.fake.received.length, 1);
      assert.equal(host.fake.received[0], ALREADY_RTK);
      assert.ok(!host.prefixRecords.some((record) => record.kind === REWRITTEN_RECORD));
    } finally {
      await host.disposeFiber();
    }
  });

  it("真 rtk 拒改的命令原样执行：rc=1 不是错误，是「这条不认识」", async () => {
    const subprocess = realSubprocess();
    const host = await startPrefixHost({ subprocess });
    try {
      const shadow = host.withAgent("sess-passthrough");
      await shadow.execute({ command: PASSTHROUGH }, exec());
      const [spawn] = subprocess.spawns;
      assert.ok(spawn !== undefined);
      assert.deepEqual(spawn.argv, ["rtk", "rewrite", PASSTHROUGH]);
      assert.equal(host.fake.received.length, 1);
      assert.equal(host.fake.received[0], PASSTHROUGH);
      assert.ok(!host.prefixRecords.some((record) => record.kind === REWRITTEN_RECORD));
    } finally {
      await host.disposeFiber();
    }
  });
});
