// B 形态（`tools/post-execute`）的集成测试。
//
// 半栈直调监听器：不用 mock 本包的 `runRtkPipe` / `guardCompressed`——那样测的是桩，
// 测不出「谁先判、谁后判」这类顺序缺陷。判据只有两个可观察量：假 pipe 被 spawn 了几次、
// 喂进去的 stdin 是哪一段。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, it } from "vitest";

import { startPipeHost } from "./integration/host-stack.ts";
import type { SpillStoreStub } from "./integration/host-stack.ts";

/** 假 spill locator：有路径形状，好让「提示里必须出现它」这条断言有意义。 */
const SPILL_LOCATOR = "/tmp/dsh-spill/session-probe/bash-7f2c.txt";

/** 假 `rtk pipe` 的产出：远小于输入，且不宣称任何成功（否则会被「伪造成功」护栏拦下）。 */
const PIPED = "cargo test: 1 passed";

/** 一段像 cargo test 的原始输出：带结构标记、带 marker、尾巴有日志行可压。 */
const RAW = `running 1 test\ntest result: ok. 1 passed; 0 failed\n${"log line\n".repeat(40)}[exit code: 0]`;

/** 取 accept 决定里的 value（判据需要它的形状，测试里收窄比断言短）。 */
function acceptedValue(decision: unknown): Record<string, unknown> {
  const { value } = decision as { value?: unknown };
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

/** 取 `value.stdout.text`。 */
function stdoutText(decision: unknown): string {
  const { stdout } = acceptedValue(decision);
  assert.equal(typeof stdout, "object");
  assert.notEqual(stdout, null);
  const { text } = stdout as { text?: unknown };
  assert.equal(typeof text, "string");
  return text as string;
}

/** 全文提示那一块的最小形状（只断言本测试关心的三个位置）。 */
interface SpillContext {
  readonly content?: readonly { readonly text?: string }[];
  readonly source?: { readonly kind?: string; readonly form?: string };
}

/** 假 spill 存储：记下写进来的原文，回一句固定的取回提示。 */
function spillStub(): SpillStoreStub & { readonly saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    saveText: (
      input: unknown,
    ): Promise<{
      readonly locator: string;
      readonly bytes: number;
      readonly retrievalHint: string;
    }> => {
      const { content } = input as { content?: unknown };
      saved.push(typeof content === "string" ? content : "");
      // 两个字段刻意**不同**、且 retrievalHint 里不含路径——装出来的 `dsh-spill-local`
      // 就是这一形态（hint 是固定串）。只发 hint 时模型拿不到任何路径，这正是被测的那条缺陷。
      return Promise.resolve({
        locator: SPILL_LOCATOR,
        bytes: 1,
        retrievalHint: "Use read with offset/limit, or grep this path to search within it.",
      });
    },
  };
}

/** 会话头里的 cwd（两例共用：一例钉「服务缺席时读它」，一例钉「服务给了就不读它」）。 */
const HEADER_CWD = "/tmp/from-header";

/** 模型按调用指定的绝对 workdir：与会话 cwd 不同，才能证明它压过后者的两级兜底。 */
const MODEL_WORKDIR = "/tmp/model-workdir";

/** 本文件建过的临时目录：`afterAll` 一把清掉，避免每个用例自己管生命周期。 */
const created: string[] = [];

/** 建一个临时目录并登记（`vitest/require-hook` 不接受在 describe 体里直接写 setup）。 */
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rtk-pipe-"));
  created.push(dir);
  return dir;
}

describe("b 形态监听器", () => {
  afterAll(() => {
    for (const dir of created) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("foreground 成功：压缩后 accept(value)，退出码与 marker 都不动", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW);
    assert.equal((out.decision as { kind?: unknown }).kind, "accept");
    const value = acceptedValue(out.decision);
    assert.equal(value["exitCode"], 0);
    const text = stdoutText(out.decision);
    assert.ok(text.startsWith(PIPED));
    // marker 必须仍在末行：客户端用 `parseExitStatus` 锚 `$` 解析它。
    assert.ok(text.endsWith("[exit code: 0]"));
    assert.ok(Buffer.byteLength(text, "utf8") < Buffer.byteLength(RAW, "utf8"));
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("压成功时按 pipe 形态记一笔账（字节数是压缩前后，filter 是命中的那个）", async () => {
    // 这一条钉的是 spec §6 的记账口径。半栈的 stats 桩会原样收下 accumulate 的入参，
    // 判据因此是「收下的那一笔对不对」，不是「有没有人调过」——后者用一个空函数也能绿。
    const recorded: unknown[] = [];
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, recorded });
    const out = await host.run(RAW);
    const text = stdoutText(out.decision);
    assert.equal(recorded.length, 1);
    const [entry] = recorded as {
      readonly form?: unknown;
      readonly filter?: unknown;
      readonly originalBytes?: unknown;
      readonly compressedBytes?: unknown;
    }[];
    assert.ok(entry !== undefined);
    assert.equal(entry.form, "pipe");
    assert.equal(entry.filter, "cargo-test");
    // 原始字节取**可见面**：正文 +（有则）stderr 段 +（有则）marker —— 也就是模型压缩前
    // 实际会读到的那些字节，`RAW` 本身就是这个形状。压缩侧取拼回 marker 之前的正文。
    assert.equal(entry.originalBytes, Buffer.byteLength(RAW, "utf8"));
    assert.equal(
      entry.compressedBytes,
      Buffer.byteLength(text.replace(/\n\[exit code: 0\]$/u, ""), "utf8"),
    );
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("压在护栏上被拒时不记账（没压缩就没有节省可记）", async () => {
    const recorded: unknown[] = [];
    // 收益不足：pipe 回来的东西比原文还长，low-gain 会拒。
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: RAW + RAW }, recorded });
    const out = await host.run(RAW);
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(recorded.length, 0);
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("background / promoted 回执原样：没有可压的正文，连 pipe 都不 spawn", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const receipts = [
      { kind: "background", jobId: "j1" },
      { kind: "promoted", jobId: "j1" },
    ];
    const outs = await Promise.all(receipts.map((receipt) => host.run(receipt)));
    for (const out of outs) {
      assert.deepEqual(out.decision, { kind: "accept" });
      assert.equal(out.piped, 0);
    }
    host.dispose();
  });

  it("失败结果原样：给 isError 结果换 value 会抛 TypeError", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { isError: true });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(Object.hasOwn(out.decision as object, "value"), false);
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("下游已经换过 value → 不二次改写", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const downstream = { kind: "accept", value: { kind: "foreground", sentinel: "downstream" } };
    const out = await host.run(RAW, { next: () => downstream });
    assert.deepEqual(out.decision, downstream);
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("双形态同开、本次已被 C 改写过 → 跳过且读后即删", async () => {
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      forms: ["prefix", "pipe"],
    });
    host.rewrittenCalls.mark("call-1");
    const out = await host.run(RAW, { callId: "call-1" });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    // 读后即删：账本条目活不过一次调用。
    assert.equal(host.rewrittenCalls.consume("call-1"), false);
    host.dispose();
  });

  it("rtk pipe 回非 0 → 原样放行，但确实尝试过", async () => {
    const host = startPipeHost({ pipe: { exitCode: 1, stdout: "" } });
    const out = await host.run(RAW);
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("截断回执走 spill 全文：喂给 pipe 的 stdin 是全文而不是那段尾巴", async () => {
    const root = tempDir();
    const full = `${RAW}${"tail line\n".repeat(20)}`;
    const spillFile = path.join(root, "full.txt");
    writeFileSync(spillFile, full);
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { truncated: true, spillPath: spillFile });
    assert.equal(out.stdin, full);
    assert.equal((out.decision as { kind?: unknown }).kind, "accept");
    host.dispose();
  });

  it("spill 全文读不到 → 原样（宁可不压，也不按半截算收益）", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, {
      truncated: true,
      spillPath: path.join(tempDir(), "missing.txt"),
    });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("marker 与 [stderr] 段逐字节保留", async () => {
    // 正文要过 `minBytes`（半栈设 16）：短于它的输入按「不值得压」放行，那是另一条判据。
    const withStderr = `running 1 test\n${"log line\n".repeat(20)}[stderr]\nwarning: unused import\n[exit code: 0]`;
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(withStderr);
    const text = stdoutText(out.decision);
    assert.ok(text.includes("[stderr]\nwarning: unused import"));
    assert.ok(text.endsWith("[exit code: 0]"));
    host.dispose();
  });

  it("探到的 rtk 低于下限 → pipe 一次都不跑（版本门对 B 形态同样成立）", async () => {
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      supported: () => false,
    });
    const out = await host.run(RAW);
    assert.equal(out.piped, 0);
    assert.deepEqual(out.decision, { kind: "accept" });
    host.dispose();
  });

  it("持久 shell 回执带宿主截断提示 → 原样放行（那条尾巴没有取回通道，压了就是算错）", async () => {
    // 裸字符串形状没有 `spillPath`：压这段残缺尾巴会把收益算错（§2.9 的谎报）。
    const clipped = `running 1 test\ntest result: ok. 1 passed; 0 failed\n${"log line\n".repeat(40)}<response clipped><NOTE>To save on context only part of this file has been shown to you.</NOTE>\n[Command finished with exit code 0]`;
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(clipped, { bareString: true });
    assert.equal(out.piped, 0);
    assert.deepEqual(out.decision, { kind: "accept" });
    host.dispose();
  });

  it("持久 shell 回执没有截断提示 → 照常压（对照组，证明上面那条不是被形状本身拦下的）", async () => {
    const clean = `running 1 test\ntest result: ok. 1 passed; 0 failed\n${"log line\n".repeat(40)}[Command finished with exit code 0]`;
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(clean, { bareString: true });
    assert.equal(out.piped, 1);
    // 裸字符串形状换 value 时也是裸字符串（`reassemble` 的字符串分支）：marker 拼回去、正文换掉。
    assert.deepEqual(out.decision, {
      kind: "accept",
      value: `${PIPED}\n[Command finished with exit code 0]`,
    });
    host.dispose();
  });

  it("监听器内部抛异常不毁调用：退回下游决定", async () => {
    // 抛出点在桩的 `stats.accumulate` 上（这条链上必然走到的一步）；实现里不为它加分支。
    const lines: string[] = [];
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      throwInListener: true,
      log: (line) => {
        lines.push(line);
      },
    });
    const out = await host.run(RAW);
    assert.deepEqual(out.decision, { kind: "accept" });
    // 吃掉异常是对的（帮忙不该毁掉这次调用），但**完全无声**会让「为什么没压」只能靠猜。
    // 两条：先记这次压成了（acceptCompressed 的那行），再记它随后抛了。
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.includes("pipe cargo-test"), true, `诊断行不对：${String(lines[0])}`);
    assert.equal(lines[1]?.includes("internal error"), true, `诊断行不对：${String(lines[1])}`);
    host.dispose();
  });

  it("vitest filter 在 vitest 5 项目里不压（pipe 侧同样要过版本门控）", async () => {
    const project = path.join(tempDir(), "v5");
    mkdirSync(path.join(project, "node_modules", "vitest"), { recursive: true });
    writeFileSync(
      path.join(project, "node_modules", "vitest", "package.json"),
      JSON.stringify({ name: "vitest", version: "5.1.0" }),
    );
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      filters: ["vitest"],
    });
    const raw = `Test Files  1 failed (1)\nTests  1 failed | 1 passed (2)\n${"log\n".repeat(20)}[exit code: 1]`;
    const out = await host.run(raw, { command: "vitest run", cwd: project });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("收益不足（压完没有变小）→ 原样放行", async () => {
    // 假 pipe 回一段与输入等长的正文：`low-gain` 判据必须拒掉它。
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: RAW } });
    const out = await host.run(RAW);
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("伪造成功（输出宣称无错、输入里有失败痕迹）→ 原样放行", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: "No errors found" } });
    const raw = `running 1 test\ntest result: FAILED. 0 passed; 1 failed\n${"log line\n".repeat(40)}[exit code: 101]`;
    const out = await host.run(raw);
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("输入太短（低于 minBytes）→ 不 spawn", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run("running 1 test\n[exit code: 0]");
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("`minBytes` 按 UTF-8 字节算：13 个字符 / 21 个字节的中文输出要进 pipe", async () => {
    // 这条钉的是字节口径：`input.length` 会把它读成 13（低于半栈的 minBytes 16）而放行。
    // 模型可见面里混着中文测试名与 emoji，用字符数会让「看着够长」的输出被当成太短。
    const chinese = "failures:测试问题";
    assert.equal(chinese.length, 13);
    assert.equal(Buffer.byteLength(chinese, "utf8"), 21);
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(chinese);
    assert.equal(out.piped, 1);
    host.dispose();
  });

  /**
   * 四处 volatile 阈值的「运行期现读」。
   *
   * 早先它们被 `apply` 一次性快照进 `PipeOptions`，而 `apply` 只跑一次——卡片上改完、宿主写进
   * 配置、刷新后也还在，但监听器用的仍是装配那一刻的值。判据必须落在「同一台 host、两次调用
   * 之间改值」上：分别启动两台 host 对比，快照与现读给出一模一样的结果。
   */
  it("minBytes 运行期现读：中途抬高阈值，下一次同样长度的输出就不再压", async () => {
    let minBytes = 16;
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, minBytes: () => minBytes });
    const before = await host.run(RAW);
    assert.equal(before.piped, 1, "对照组：默认阈值下这条该压");
    minBytes = 100_000;
    const after = await host.run(RAW);
    assert.equal(after.piped, before.piped, "抬高 minBytes 之后仍然 spawn 了 pipe");
    assert.deepEqual(after.decision, { kind: "accept" });
    host.dispose();
  });

  it("minGainRatio 运行期现读：中途收紧到 0，下一次低收益的压缩就被护栏拒掉", async () => {
    // 0.95 → 0 的含义：压缩结果必须为 0 字节才算「有收益」，于是任何不空的产出都被判 low-gain。
    // 收成 0 而不是收成 1.1：schema 的上界是 1，越界值在真装配里根本进不来，测它等于测一个
    // 生产不可能出现的状态。
    let ratio = 0.95;
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, minGainRatio: () => ratio });
    const before = await host.run(RAW);
    assert.equal((before.decision as { kind?: unknown }).kind, "accept");
    assert.equal(Object.hasOwn(before.decision as object, "value"), true, "对照组：应当换过值");
    ratio = 0;
    const after = await host.run(RAW);
    assert.deepEqual(after.decision, { kind: "accept" }, "收紧收益阈值之后仍然换了值");
    host.dispose();
  });

  it("stdoutCapBytes 运行期现读：中途收紧上限，下一次压缩结果就被截尾", async () => {
    // `stdoutCapBytes` 卡的是**压缩后**交回模型的那一段正文（不是喂给 rtk 的输入），
    // 且截的是尾巴（`TextRetainer({kind:'tail'})`）。回填时 marker 一定要原样跟回来——
    // 退出状态就靠它，被截掉等于改了这条命令的成败。
    let cap = 64_000;
    const piped = "cargo test: 1 passed";
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: piped }, stdoutCapBytes: () => cap });
    const before = await host.run(RAW);
    assert.equal(stdoutText(before.decision), `${piped}\n[exit code: 0]`);
    cap = 6;
    const after = await host.run(RAW);
    assert.equal(stdoutText(after.decision), "passed\n[exit code: 0]");
    host.dispose();
  });

  it("enabledFilters 运行期现读：中途去掉 cargo-test，下一次就不 spawn", async () => {
    let filters: readonly string[] = ["cargo-test", "pytest"];
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, filtersOf: () => filters });
    const before = await host.run(RAW);
    assert.equal(before.piped, 1, "对照组：名单里有 cargo-test 时该压");
    filters = ["pytest"];
    const after = await host.run(RAW);
    assert.equal(after.piped, before.piped, "去掉 cargo-test 之后仍然 spawn 了 pipe");
    assert.deepEqual(after.decision, { kind: "accept" });
    host.dispose();
  });

  it("命令带详情意图 flag → 不 spawn（共用拒绝层，§4.2）", async () => {
    // 这条与「命令没命中 filter」是两件事：`cargo test -- --nocapture` 命中 cargo-test 这一行，
    // 差一点就在前置判据上被放行了。实测后果不是「少压一点」而是**整段证据消失**——
    // 189B 的 `DEBUG-VISIBLE-MARKER` 被 rtk 的 cargo-test filter 压成 37B 的
    // `cargo test: 1 passed`，标记出现 0 次。用户要细节时任何压缩都是背叛。
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { command: "cargo test -- --nocapture" });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("命令本身已以 rtk 开头 → 不 spawn（输出已被压过一遍，再压是压两次）", async () => {
    // 与上面那条同属共用拒绝层，理由不同：`rtk cargo test` 的输出已是 rtk 的压缩体，
    // 再喂 `rtk pipe -f cargo-test` 会把 `panicked at` 与 `left:/right:` 也一起吃掉
    // （实测 938B → 545B → 97B，两样全丢）。
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { command: "rtk cargo test" });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("复合命令在 pipe 层照压：只看输出，不执行命令", async () => {
    // 与上面两条反向的边界。`compound` 在前缀层必须拒（拆开改写会改语义），但 pipe 层
    // **刻意没有**把它搬过来：`cargo test && echo hi` 的输出照样是 libtest 形状，压它无损。
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { command: "cargo test && echo hi" });
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("首词不是测试命令的复合命令命中不了表（表每行锚 ^）", async () => {
    // `cd /tmp && cargo test` 的 stdout 确实该压，但 pipe 表判的是**首词**——`cd` 不是
    // cargo test 那一行的形状。这条钉住那个前提：表若哪天改成非锚定匹配就会变，届时
    // 要么补一条 `^(cd .* &&)` 的识别、要么明确接受漏压，不能悄悄改变语义。
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { command: "cd /tmp && cargo test" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("命令没命中或没启用的 filter → 不 spawn", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { command: "go test ./..." });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("形态预检不通过（cargo filter 收到 pytest 输出）→ 不 spawn", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(
      "test session starts\nplatform darwin\nrootdir: /tmp\n[exit code: 0]",
    );
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("原文落 spill：additionalContexts 里既有 locator 也有宿主的 retrievalHint", async () => {
    const store = spillStub();
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, spillStore: store });
    const out = await host.run(RAW);
    const { additionalContexts } = out.decision as {
      readonly additionalContexts: readonly SpillContext[];
    };
    assert.equal(additionalContexts.length, 1);
    assert.equal(store.saved.length, 1);
    // 落库的是**压缩前**的正文（不是压缩后的那一段）。
    const [saved] = store.saved;
    assert.equal(typeof saved, "string");
    assert.ok(String(saved).startsWith("running 1 test"));
    // 提示里必须有**路径本身**：宿主给的 retrievalHint 是固定串、不含 locator，
    // 只把它发出去的话模型看到「grep this path」却没有任何 path（旧实现就是这个形态）。
    const context = additionalContexts.at(0);
    // `assert.ok` 带断言签名，能收窄；`assert.equal` 不能，所以这一行不能省成 equal。
    assert.ok(context !== undefined);
    const notice = String(context.content?.at(0)?.text);
    assert.ok(notice.includes(SPILL_LOCATOR), `提示里没有 locator：${notice}`);
    assert.ok(notice.includes("grep this path"), `提示里没有宿主的 retrievalHint：${notice}`);
    const { source } = context;
    assert.ok(source !== undefined);
    assert.equal(source.kind, "rtk");
    assert.equal(source.form, "notice");
    host.dispose();
  });

  it("没有 spill 后端时 warn 一行：压缩照做，但模型手里没有取回通道", async () => {
    const warns: string[] = [];
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, warns });
    const out = await host.run(RAW);
    assert.equal((out.decision as { readonly kind?: string }).kind, "accept");
    // 在真宿主上第一次实测就是这么发现的：输出压掉了，模型却没有能读的路径。
    assert.equal(warns.length, 1);
    assert.equal(
      warns[0]?.includes("no retrieval path"),
      true,
      `warn 文案不对：${String(warns[0])}`,
    );
    host.dispose();
  });

  it("消息模板缺席时仍发 notice：正文退到裸 locator，压缩不因此作废", async () => {
    // 真宿主实测抓到过这一支：探针脚本的 messages 桩少了 spillLocation，于是
    // `undefined.replace(...)` 在 finishCompressed 里抛，被 decide 的 catch 吞掉 ——
    // 结果是「压成了、路径也说得出」的一次退化成「什么都没压」。装饰品的失败不该吃掉本体。
    const store = spillStub();
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      spillStore: store,
      messages: () => ({
        cargoTestWarnHint: "",
        spillSummary: "压缩前的完整输出已另存为文件",
        spillLocation: undefined as unknown as string,
      }),
    });
    const out = await host.run(RAW);
    const decision = out.decision as {
      readonly kind?: string;
      readonly additionalContexts?: readonly {
        readonly content?: readonly { readonly text?: string }[];
      }[];
    };
    assert.equal(decision.kind, "accept");
    const context = decision.additionalContexts?.at(0);
    assert.ok(context !== undefined);
    assert.equal(String(context.content?.at(0)?.text), SPILL_LOCATOR);
    host.dispose();
  });

  it("落库成功且诊断开着：诊断行写出 locator，且不 warn", async () => {
    const lines: string[] = [];
    const warns: string[] = [];
    const store = spillStub();
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      spillStore: store,
      log: (line: string): void => {
        lines.push(line);
      },
      warns,
    });
    await host.run(RAW);
    assert.equal(warns.length, 0);
    assert.ok(
      lines.some((line) => line.includes("spill: saved") && line.includes(SPILL_LOCATOR)),
      `诊断行里没有落库结果：${lines.join(" | ")}`,
    );
    host.dispose();
  });

  it("诊断日志：压成功时记一行（filter 与前后字节数）", async () => {
    const lines: string[] = [];
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      log: (line) => {
        lines.push(line);
      },
    });
    const out = await host.run(RAW);
    assert.equal((out.decision as { kind?: unknown }).kind, "accept");
    assert.equal(lines.length, 1);
    const line = String(lines[0]);
    assert.ok(line.includes("pipe cargo-test:"), line);
    assert.ok(line.includes("B ->"), line);
    host.dispose();
  });

  it("诊断日志：护栏拒时写出拒因（用户开这个开关通常就是为了问「为什么没压」）", async () => {
    const lines: string[] = [];
    // pipe 的产出比输入还长 → low-gain 判拒：收益不到 minGainRatio，压缩没有意义。
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: RAW + RAW },
      log: (line) => {
        lines.push(line);
      },
    });
    const out = await host.run(RAW);
    // 判拒 = 不改值（decision 仍是裸 accept），但日志里必须点名原因。
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(lines.length, 1);
    assert.ok(String(lines[0]).includes("pipe cargo-test: skipped (low-gain)"), String(lines[0]));
    host.dispose();
  });

  it("没装 spill 服务时照常压缩，只是不带全文提示", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW);
    assert.equal((out.decision as { kind?: unknown }).kind, "accept");
    assert.equal(Object.hasOwn(out.decision as object, "additionalContexts"), false);
    host.dispose();
  });

  it("没有会话身份时不落 spill：owner 是从 agent 取的，缺了就跳过这一步", async () => {
    const store = spillStub();
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, spillStore: store });
    const out = await host.run(RAW, { agent: null });
    assert.equal((out.decision as { kind?: unknown }).kind, "accept");
    // 照常压缩，只是没有全文提示——落 spill 需要 owner，owner 缺了就不写。
    assert.equal(store.saved.length, 0);
    assert.equal(Object.hasOwn(out.decision as object, "additionalContexts"), false);
    host.dispose();
  });

  it("没有 agent 时工作目录退到会话头里的 cwd，而不是 process.cwd()", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { cwd: HEADER_CWD, agent: null });
    // 三级兜底：先问 `workingDirectory.ensure`（要有 agent），再读 `session.header.cwd`，
    // 最后才是 process.cwd()。这一例钉的是第二级。
    assert.equal(out.cwd, HEADER_CWD);
    host.dispose();
  });

  it("有 agent 时工作目录取宿主服务给的那一个（会话头只是兜底）", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { cwd: HEADER_CWD });
    // 半栈的 ensure 回 process.cwd()：服务答了就用它，不去看 header。
    assert.equal(out.cwd, process.cwd());
    host.dispose();
  });

  it("模型按调用传的 workdir 压过会话 cwd（pipe 与宿主跑在同一目录）", async () => {
    // 宿主 tool-bash 按 `args.workdir` 跑命令；插件算 cwd 时不读它就会与「命令实际跑在哪」
    // 分叉，vitest 版本门也会从错的目录向上找 `node_modules/vitest`。
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, {
      args: { command: "cargo test", workdir: MODEL_WORKDIR },
      cwd: HEADER_CWD,
    });
    assert.equal(out.cwd, MODEL_WORKDIR);
    host.dispose();
  });

  it("模型传相对 workdir 时拼在会话 cwd 之后（与宿主同口径）", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, {
      args: { command: "cargo test", workdir: "pkgs/app" },
      agent: null,
      cwd: HEADER_CWD,
    });
    // 相对 workdir 是**原样追加**，不重写它内部的分隔符：宿主 `dsh-tool-bash` 的
    // `resolveWorkdir(modelWorkdir, sessionCwd)` 就是 `${sessionCwd}${sep}${modelWorkdir}`
    // 一句（`lib/index.js:296-300`），模型传 `pkgs/app` 它也只补中间那一个 sep。
    // 早先这条断言写成了两个 sep 都被替换，于是只在 Windows 上红——POSIX 下 `/` 恰好等于
    // sep，两种写法同形，把那处不一致盖住了。
    assert.equal(out.cwd, `${HEADER_CWD}${path.sep}pkgs/app`);
    host.dispose();
  });

  it("别的工具（不是 bash/pwsh）不归本层管", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(RAW, { name: "read" });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("参数不是对象 / 没有 command → 不 spawn（连 filter 都不查）", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const missing = await host.run(RAW, { args: null });
    const empty = await host.run(RAW, { command: "" });
    for (const out of [missing, empty]) {
      assert.deepEqual(out.decision, { kind: "accept" });
      assert.equal(out.piped, 0);
    }
    host.dispose();
  });

  it("回执里带非 JSON 值 → 原样放行（不给宿主契约之外的东西换值）", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    // 拆得出来（有 `kind:'foreground'` 与 `stdout.text`），但整体拼回去不是 JSON 值：
    // `reassemble` 会把 `extra` 一起展开，那里是个函数。
    const out = await host.run({
      kind: "foreground",
      extra: (): number => 1,
      stdout: { text: RAW },
    });
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("forms 不含 pipe 时整层不装", async () => {
    const host = startPipeHost({ forms: ["prefix"] });
    const out = await host.run(RAW);
    assert.equal(out.decision, undefined);
    assert.equal(out.piped, 0);
    host.dispose();
  });

  /**
   * 总开关对 B 形态的判据。
   *
   * 这条补的是一个**真宿主实测暴露过的缺陷**：`enabled:false` + `enabledForms:['prefix','pipe']`
   * 时 pipe 照样压缩（2878B → 1299B），因为 `installPostExecuteListener` 只判了 `forms`。
   * `enabled` 是 volatile 字段，用户在卡片上关掉它时监听器已经在栈上——所以判据必须落在
   * **每次判定**，而不是装配期。
   */
  it("enabled 为假时 pipe 一次都不跑（装配了监听器也不压）", async () => {
    const on = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const off = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, enabled: () => false });
    // 对照组：同一条输入在开关打开时必须压——否则「没压」可能只是别的前置判据拦住了。
    const before = await on.run(RAW);
    assert.equal(before.piped, 1);
    assert.ok(before.decision !== undefined);
    const after = await off.run(RAW);
    assert.deepEqual(after.decision, { kind: "accept" });
    assert.equal(after.piped, 0);
    on.dispose();
    off.dispose();
  });

  it("enabled 是运行期现读：中途关掉总开关，下一次调用立刻不压", async () => {
    // 用可变闭包模拟卡片上改 volatile 字段：同一台 host，两次调用之间把开关翻过去。
    // `piped` 是累计计数（不是本次调用的），所以判据是「第二次之后没有增长」。
    let enabled = true;
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, enabled: () => enabled });
    const before = await host.run(RAW);
    assert.equal(before.piped, 1);
    enabled = false;
    const after = await host.run(RAW);
    assert.deepEqual(after.decision, { kind: "accept" });
    assert.equal(after.piped, before.piped);
    host.dispose();
  });
});
