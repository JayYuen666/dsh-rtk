// B 形态（`tools/post-execute`）的统计埋点矩阵。
//
// 与 `post-execute.test.ts` 的分工：那边钉的是**压缩行为**（压不压、喂什么、拼回来什么形状），
// 这边钉的是**读面**（每一格跳过都记了哪一条记录、带没带 filter / 原始量 / 延迟）。
//
// 判据全部落在 `PipeHost.pipeRecords` 这个收件箱上：它是 `PipeDeps.insights.recordPipe` 的
// 原样入参，中间没有任何一层改写形状——所以「记的字段对不对」与「记录时机对不对」是同一件事。
import assert from "node:assert/strict";

import { describe, it } from "vitest";

import type { PipeRecord } from "../lib/insights-shape.ts";
import { startPipeHost } from "./integration/host-stack.ts";

/** 假 `rtk pipe` 的产出：远小于输入，且不宣称任何成功（否则会被「伪造成功」护栏拦下）。 */
const PIPED = "cargo test: 1 passed";

/** 一段像 cargo test 的原始输出：带结构标记、带 marker、尾巴有日志行可压。 */
const RAW = `running 1 test\ntest result: ok. 1 passed; 0 failed\n${"log line\n".repeat(40)}[exit code: 0]`;

/** 同一个回执的「太短」版本：够短、但形态仍然像 cargo test。 */
const SHORT_RAW = "running 1 test\ntest result: ok.[exit code: 0]";

/** 像 cargo test 但形态预检过不去的一段（没有任何 cargo 结构标记）。 */
const SHAPELESS_RAW = `random text\n${"log line\n".repeat(40)}[exit code: 0]`;

/** 表里登记过、但默认不启用的 filter（用来验 potential 那一路）。 */
const DISABLED_FILTER_COMMAND = "git status --short";

/** 一条命令家族（复用于多处断言，抽常量以过 `sonarjs/no-duplicate-string`）。 */
const CARGO_FAMILY = "cargo test";

/** 记录的种类标签：断言里反复出现，抽出来才不会被判「重复字面量」。 */
const KIND_BASH_CALL = "pipe-bash-call";
const KIND_SKIP = "pipe-skip";
const KIND_SUCCESS = "pipe-success";
const KIND_POTENTIAL = "potential";

/** 取第 `index` 条记录并断言它的 kind（一次收窄，后面不用写可选链）。 */
function recordAt(records: readonly PipeRecord[], index: number, kind: string): PipeRecord {
  const record = records[index];
  assert.ok(
    record !== undefined,
    `第 ${String(index)} 条记录不存在（共 ${String(records.length)} 条）`,
  );
  assert.equal(record.kind, kind);
  return record;
}

/** 取唯一一条跳过记录的原因。 */
function onlySkipReason(records: readonly PipeRecord[]): string {
  const skips = records.filter((record) => record.kind === KIND_SKIP);
  assert.equal(skips.length, 1, `期望恰好一条 pipe-skip，实际 ${String(skips.length)} 条`);
  const [only] = skips;
  assert.ok(only !== undefined);
  assert.equal(only.kind, KIND_SKIP);
  return only.reason;
}

describe("b 形态的统计埋点", () => {
  it("超过 10MB 的候选在定价之前就被拒：原因为 too-large", async () => {
    // 上界这一条只能靠真造一段超大输出来走到：它是「先判长度、再算可见面与 token」那一步的
    // 唯一出口，而这一步的收益是**不为注定被扔掉的输出做完整定价**。
    const huge = `running 1 test\n${"log line\n".repeat(1_250_000)}[exit code: 0]`;
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(huge);
    assert.equal(onlySkipReason(host.pipeRecords), "too-large");
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("压成功记一条 pipe-success：家族、filter、两侧字节与 token、非负延迟都在", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    await host.run(RAW);
    assert.deepEqual(
      host.pipeRecords.map((record) => record.kind),
      [KIND_BASH_CALL, KIND_SUCCESS],
    );
    const success = recordAt(host.pipeRecords, 1, KIND_SUCCESS);
    assert.equal(success.kind, KIND_SUCCESS);
    assert.equal(success.filter, "cargo-test");
    assert.equal(success.commandFamily, CARGO_FAMILY);
    // 原始量按**可见面**（正文 + marker）算：那是模型压缩前实际读到的那一段。
    assert.equal(success.originalBytes, Buffer.byteLength(RAW, "utf8"));
    assert.equal(success.originalTokens, Math.ceil(Buffer.byteLength(RAW, "utf8") / 4));
    assert.ok(success.compressedBytes < success.originalBytes);
    assert.equal(success.savedTokens, success.originalTokens - success.compressedTokens);
    // 延迟是量出来的数，不是占位：假 pipe 不 sleep，所以只判它是个非负整数。
    assert.ok(Number.isInteger(success.latencyMs) && success.latencyMs >= 0);
    host.dispose();
  });

  it("命中的 filter 没启用时记 potential，跳过原因是 no-filter", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const out = await host.run(SHAPELESS_RAW, { command: DISABLED_FILTER_COMMAND });
    // potential 走的是另一条记录支（它只写 potential_filters 表），所以这里两条记录的用户不同：
    // 一条潜在机会 + 一条「这次没压」。
    assert.deepEqual(
      host.pipeRecords.map((record) => record.kind),
      [KIND_BASH_CALL, KIND_POTENTIAL, KIND_SKIP],
    );
    const potential = recordAt(host.pipeRecords, 1, KIND_POTENTIAL);
    assert.ok(potential.kind === KIND_POTENTIAL);
    assert.equal(potential.filter, "git-status");
    assert.equal(potential.matches, 1);
    // 潜在机会的日期必须是**本地日**（面板按本地日分桶，UTC 日会让东八区的跨零点数据错一天）。
    assert.match(potential.day, /^\d{4}-\d{2}-\d{2}$/u);
    assert.equal(onlySkipReason(host.pipeRecords), "no-filter");
    assert.equal(out.piped, 0);
    host.dispose();
  });

  it("太短 / 形态不符 / 太大 / 没正文：四种跳过各记自己的原因", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, minBytes: () => 1 });
    // 太短：把阈值抬到比这条还高。
    await host.run(SHORT_RAW);
    const shortHost = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      minBytes: () => 10_000,
    });
    await shortHost.run(RAW);
    assert.equal(onlySkipReason(shortHost.pipeRecords), "too-small");
    // 形态不符：长度够、但没有任何 cargo 结构标记。
    await host.run(SHAPELESS_RAW);
    assert.equal(onlySkipReason(host.pipeRecords), "shape-mismatch");
    // 没有可压正文：background 回执连 pipe 都不 spawn。
    const background = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const backgroundOut = await background.run({ kind: "background", jobId: "j1" });
    assert.equal(onlySkipReason(background.pipeRecords), "no-output");
    assert.equal(backgroundOut.piped, 0);
    host.dispose();
    shortHost.dispose();
    background.dispose();
  });

  it("护栏拒时记 guard:<原因>，且带上原始量与延迟", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: RAW + RAW } });
    await host.run(RAW);
    const reason = onlySkipReason(host.pipeRecords);
    assert.ok(reason.startsWith("guard:"), reason);
    const skip = recordAt(host.pipeRecords, 1, KIND_SKIP);
    assert.ok(skip.kind === KIND_SKIP);
    // 护栏是**渲染之后**才判的：这时已经 spawn 过，所以原始量与延迟都该有值。
    assert.equal(skip.originalBytes, Buffer.byteLength(RAW, "utf8"));
    assert.ok(skip.latencyMs !== undefined);
    assert.equal(skip.filter, "cargo-test");
    host.dispose();
  });

  it("rtk pipe 回非 0 记 pipe-failed（不是静默放行）", async () => {
    const host = startPipeHost({ pipe: { exitCode: 1, stdout: "" } });
    await host.run(RAW);
    assert.equal(onlySkipReason(host.pipeRecords), "pipe-failed");
    host.dispose();
  });

  it("结构拒绝与已改写各记一条：这两条都在「连 pipe 都不试」那一侧", async () => {
    const structural = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    const structuralOut = await structural.run(RAW, { command: "cargo test -- --nocapture" });
    assert.equal(onlySkipReason(structural.pipeRecords), "structural-reject");
    assert.equal(structuralOut.piped, 0);

    const rewritten = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      forms: () => ["prefix", "pipe"],
    });
    rewritten.rewrittenCalls.mark("call-1");
    const rewrittenOut = await rewritten.run(RAW, { callId: "call-1" });
    assert.equal(onlySkipReason(rewritten.pipeRecords), "already-rewritten");
    assert.equal(rewrittenOut.piped, 0);
    structural.dispose();
    rewritten.dispose();
  });

  it("下游换了值 / 结果是错误 / 不是 shell：前两种各记一格，最后一种不记", async () => {
    const downstream = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    await downstream.run(RAW, {
      next: () => ({ kind: "accept", value: { sentinel: "downstream" } }),
    });
    assert.equal(onlySkipReason(downstream.pipeRecords), "downstream-value");

    const blocked = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    await blocked.run(RAW, {
      next: () => ({ kind: "block", feedback: [{ type: "text", text: "no" }] }),
    });
    // 「被拦」与「被替换」是两件事：前者说明有条规则不让它跑，后者说明有人在改结果。
    // 折成同一个 reason 之后，跳过原因榜会把被拦的次数算进被替换里。
    assert.equal(onlySkipReason(blocked.pipeRecords), "downstream-block");

    const errored = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    await errored.run(RAW, { isError: true });
    assert.equal(onlySkipReason(errored.pipeRecords), "error");

    const otherTool = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    await otherTool.run(RAW, { name: "read" });
    // 非 shell 工具**一条都不记**：它既不加分母，也不该在「跳过原因」里占一行——那不是
    // 读者能改的东西（早先记成 `not-shell` 的结果是「最近一次压缩」显示成一句无意义的跳过）。
    assert.deepEqual(otherTool.pipeRecords, []);
    blocked.dispose();
    downstream.dispose();
    errored.dispose();
    otherTool.dispose();
  });

  it("开关关着 / 形态不含 pipe / 版本太低：一条都不记", async () => {
    const off = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, enabled: () => false });
    const prefixOnly = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      forms: () => ["prefix"],
    });
    const unsupported = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      supported: () => false,
    });
    const hosts = [off, prefixOnly, unsupported];
    const outs = await Promise.all(hosts.map((host) => host.run(RAW)));
    for (const [index, host] of hosts.entries()) {
      assert.deepEqual(host.pipeRecords, []);
      assert.equal(outs[index]?.piped, 0);
      host.dispose();
    }
  });

  it("统计写面抛错不影响压缩：记录丢失、结果照压", async () => {
    const host = startPipeHost({
      pipe: { exitCode: 0, stdout: PIPED },
      insights: {
        recordPipe: (): void => {
          throw new Error("insights-boom");
        },
      },
    });
    const out = await host.run(RAW);
    // 压缩本身是成功的：埋点是旁路，不该把「帮忙」变成「毁掉这次调用」。
    assert.equal((out.decision as { kind?: unknown }).kind, "accept");
    assert.equal(out.piped, 1);
    host.dispose();
  });

  it("内部异常记一条 pipe-internal，其余交给下游决定", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED }, throwInListener: true });
    const out = await host.run(RAW);
    assert.deepEqual(out.decision, { kind: "accept" });
    assert.equal(onlySkipReason(host.pipeRecords), "pipe-internal");
    // 分母已经记过（它在抛错之前落），所以断言恰是「分母 + 内部异常」两条。
    assert.deepEqual(
      host.pipeRecords.map((record) => record.kind),
      [KIND_BASH_CALL, KIND_SKIP],
    );
    host.dispose();
  });

  it("工作目录落进记录：模型给的 workdir 优先于会话 cwd", async () => {
    const host = startPipeHost({ pipe: { exitCode: 0, stdout: PIPED } });
    // 模型按调用传绝对 workdir：`run` 把它放进 `exec.arguments.workdir`。
    await host.run(RAW, { args: { command: "cargo test", workdir: "/tmp/model-workdir" } });
    const success = recordAt(host.pipeRecords, 1, KIND_SUCCESS);
    assert.ok(success.kind === KIND_SUCCESS);
    assert.equal(success.workdir, "/tmp/model-workdir");
    // 同一个 cwd 也是 spawn 的工作目录（两处若各解一次就会分叉）。
    assert.equal(host.pipeRecords.length, 2);
    host.dispose();
  });
});
