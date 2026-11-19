// test/prefix-insights.test.ts —— C 形态的统计埋点（spec §6 的 prefix 分账）。
//
// 判据只有一条：**哪几条 `PrefixRecord` 以什么顺序到达**。所以这里用半栈的真收件箱
// （`host.prefixRecords`），不 mock `createRewriter`/`runRtkRewrite`——埋点错位最典型的形态
// 就是「记录对了、时机错了」（例如 attempt 记在 spawn 之后、latency 记了两遍），
// 那只有跑真装配序才看得见。
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";

import type { PrefixRecord } from "../lib/insights-shape.ts";
import { installFakeRtk, makeCleanups, startPrefixHost } from "./integration/host-stack.ts";

const cleanups = makeCleanups();

const CARGO_TEST = "cargo test";
const RTK_CARGO_TEST = "rtk cargo test";
const GIT_STATUS = "git status";
const RTK_GIT_STATUS = "rtk git status";
const AWS_S3_LS = "aws s3 ls";
const AWS_FAMILY = "aws s3";
const NPM_RUN_LINT = "npm run lint";
const RTK_LINT = "rtk lint";

/** `PrefixRecord` 的五种判别位：写一次，四处引用（重复字面量本身没有信息量）。 */
const KIND_BASH_CALL = "prefix-bash-call";
const KIND_ATTEMPT = "prefix-attempt";
const KIND_REWRITTEN = "prefix-rewritten";
const KIND_OUTCOME = "prefix-outcome";
const KIND_GATE_SKIP = "prefix-gate-skip";

/** 一次 bash 调用的最小 exec（`callId` 是去重账本的键，`signal` 要被 AbortSignal.any 合并）。 */
const exec = (command: string): Record<string, unknown> => ({
  callId: "call-1",
  name: "bash",
  arguments: { command },
  signal: new AbortController().signal,
});

/** 记录种类序列：断言顺序用的最短表示。 */
const kindsOf = (records: readonly PrefixRecord[]): readonly string[] =>
  records.map((record) => record.kind);

/**
 * 取第 `index` 条，并当场收窄成 `kind`。
 *
 * 收窄一次之后，调用方就不必每条都写 `record.kind === "..." && record.xxx`——那种写法
 * 在断言失败时的可读性也很差（`false` 到底是「种类不对」还是「字段不对」看不出来）。
 */
function at(records: readonly PrefixRecord[], index: number, kind: string): PrefixRecord {
  const record = records[index];
  assert.ok(record !== undefined, `缺第 ${index} 条记录（共 ${records.length} 条）`);
  assert.equal(record.kind, kind, `第 ${index} 条的种类不是 ${kind}`);
  return record;
}

describe("c 形态：统计埋点", () => {
  afterAll(() => {
    cleanups.drain();
  });

  it("改写成功 → bash-call、attempt、rewritten 三条，且 latency 只落在 rewritten 上", async () => {
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost();
      await host.withAgent().execute({ command: CARGO_TEST }, exec(CARGO_TEST));
      assert.deepEqual(kindsOf(host.prefixRecords), [KIND_BASH_CALL, KIND_ATTEMPT, KIND_REWRITTEN]);
      const call = at(host.prefixRecords, 0, KIND_BASH_CALL);
      assert.equal(call.kind === KIND_BASH_CALL && call.commandFamily, CARGO_TEST);
      // bash-call 这一条的 workdir 恒为空串：它在记录形状里存在，但不参与任何聚合。
      assert.equal(call.kind === KIND_BASH_CALL && call.workdir, "");
      // attempt 只计次数：把 latency 也记在这里，store 的 latency_count 会翻倍。
      assert.deepEqual(Object.keys(at(host.prefixRecords, 1, KIND_ATTEMPT)), ["kind", "ts"]);
      const rewritten = at(host.prefixRecords, 2, KIND_REWRITTEN);
      assert.deepEqual(rewritten.kind === KIND_REWRITTEN && rewritten.families, [CARGO_TEST]);
      assert.ok(
        rewritten.kind === KIND_REWRITTEN && rewritten.latencyMs >= 0,
        "latency 必须是非负毫秒数",
      );
    } finally {
      rtk.restore();
    }
  });

  it("闸门跳过 → 只有 bash-call 与 gate-skip，一条 attempt 都没有", async () => {
    // `aws` 是内建拒绝表里**唯一**剩下的一条（退出码换含义：命令不存在时原生 127、rtk 回 1），
    // 闸门在 spawn 之前就拒。`git log` 之类不再被拒——它们的输出变短是缩略该做的事。
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_GIT_STATUS }]);
    try {
      const host = await startPrefixHost();
      await host.withAgent().execute({ command: AWS_S3_LS }, exec(AWS_S3_LS));
      assert.deepEqual(kindsOf(host.prefixRecords), [KIND_BASH_CALL, KIND_GATE_SKIP]);
      const skip = at(host.prefixRecords, 1, KIND_GATE_SKIP);
      assert.equal(skip.kind === KIND_GATE_SKIP && skip.reason, "deny-table");
      assert.equal(skip.kind === KIND_GATE_SKIP && skip.commandFamily, AWS_FAMILY);
      // 没 spawn 过：跳过是真的跳过，不是「跑了再丢结论」。
      assert.equal(rtk.spawned(), 0);
    } finally {
      rtk.restore();
    }
  });

  it("rtk 说没有等价改写（rc=1）→ outcome 记 no-rewrite，而不是失败", async () => {
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
    try {
      const host = await startPrefixHost();
      await host.withAgent().execute({ command: CARGO_TEST }, exec(CARGO_TEST));
      assert.deepEqual(kindsOf(host.prefixRecords), [KIND_BASH_CALL, KIND_ATTEMPT, KIND_OUTCOME]);
      const outcome = at(host.prefixRecords, 2, KIND_OUTCOME);
      assert.equal(
        outcome.kind === KIND_OUTCOME && outcome.outcome,
        "no-rewrite",
        "no-rewrite 是「这条命令 rtk 不认识」，不是失败",
      );
      assert.equal(outcome.kind === KIND_OUTCOME && outcome.reason, "no-rewrite");
    } finally {
      rtk.restore();
    }
  });

  it("改写结果过不了校验（npm run lint → rtk lint）→ outcome 记 verify-rejected", async () => {
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_LINT }]);
    try {
      const host = await startPrefixHost();
      await host.withAgent().execute({ command: NPM_RUN_LINT }, exec(NPM_RUN_LINT));
      assert.deepEqual(kindsOf(host.prefixRecords), [KIND_BASH_CALL, KIND_ATTEMPT, KIND_OUTCOME]);
      const outcome = at(host.prefixRecords, 2, KIND_OUTCOME);
      assert.equal(outcome.kind === KIND_OUTCOME && outcome.outcome, "verify-rejected");
      // 校验不过就不改写：转调的还是模型原来那条命令。
      assert.deepEqual(host.fake.received, [NPM_RUN_LINT]);
    } finally {
      rtk.restore();
    }
  });

  it("改写超时 → outcome 记 timeout（用户动作与 no-rewrite 完全不同）", async () => {
    // 假 rtk 拖 5s，而这一层把改写预算压到 300ms：结论只能是 timeout。
    const rtk = installFakeRtk(cleanups.dirs, [
      { exitCode: 3, stdout: RTK_CARGO_TEST, delayMs: 5000 },
    ]);
    try {
      const host = await startPrefixHost({ options: { rewriteTimeoutMs: 300 } });
      await host.withAgent().execute({ command: CARGO_TEST }, exec(CARGO_TEST));
      const outcome = at(host.prefixRecords, 2, KIND_OUTCOME);
      assert.equal(outcome.kind === KIND_OUTCOME && outcome.outcome, "timeout");
      assert.deepEqual(host.fake.received, [CARGO_TEST]);
    } finally {
      rtk.restore();
    }
  });

  it("复合命令两段都被改写 → families 收两段", async () => {
    const rtk = installFakeRtk(cleanups.dirs, [
      { exitCode: 3, stdout: `${RTK_GIT_STATUS} && ${RTK_CARGO_TEST}` },
    ]);
    try {
      const host = await startPrefixHost();
      const command = `${GIT_STATUS} && ${CARGO_TEST}`;
      await host.withAgent().execute({ command }, exec(command));
      const rewritten = at(host.prefixRecords, host.prefixRecords.length - 1, KIND_REWRITTEN);
      assert.deepEqual(rewritten.kind === KIND_REWRITTEN && rewritten.families, [
        GIT_STATUS,
        CARGO_TEST,
      ]);
    } finally {
      rtk.restore();
    }
  });

  it("读不到命令串也计一次 bash-call（family 落 unknown），之后原样转调", async () => {
    // 分母不能只收「形状正确」的调用：否则「模型发来的形状不对」这一整类会从覆盖率里消失。
    //
    // 这条用例验的是**埋点**，不验改写：所以它同样要装假 rtk。装配期门禁只剩
    // `findOnPath("rtk")`，PATH 上没有 rtk 时整层根本不装（`withAgent()` 直接抛
    // 「遮蔽层没有注册任何工具体」）。早先它没装，只是恰好跑在装了 rtk 的开发机上；
    // 夹具因此必须自足，不能依赖机器或 CI 上那支真 rtk。
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
    try {
      const host = await startPrefixHost();
      await host.withAgent().execute({ workdir: "/tmp" }, exec(CARGO_TEST));
      assert.deepEqual(kindsOf(host.prefixRecords), [KIND_BASH_CALL]);
      const call = at(host.prefixRecords, 0, KIND_BASH_CALL);
      assert.equal(call.kind === KIND_BASH_CALL && call.commandFamily, "unknown");
      // 命令串读不到 ⇒ 没有可改写的段，一次都不该 spawn。
      assert.equal(rtk.spawned(), 0);
    } finally {
      rtk.restore();
    }
  });

  it("总开关关着时一条都不记（那不是统计问题，而是这一层没开）", async () => {
    let open = false;
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost({ options: { enabled: () => open } });
      const tool = host.withAgent();
      await tool.execute({ command: CARGO_TEST }, exec(CARGO_TEST));
      assert.deepEqual(host.prefixRecords, []);
      assert.equal(rtk.spawned(), 0);
      open = true;
      await tool.execute({ command: CARGO_TEST }, exec(CARGO_TEST));
      assert.deepEqual(kindsOf(host.prefixRecords), [KIND_BASH_CALL, KIND_ATTEMPT, KIND_REWRITTEN]);
    } finally {
      rtk.restore();
    }
  });

  it("记账号自己抛错时，工具照常执行（统计坏了不该让命令失败）", async () => {
    const lines: string[] = [];
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost({
        log: (line) => {
          lines.push(line);
        },
        insights: {
          recordPrefix: () => {
            throw new Error("sink 坏了");
          },
        },
      });
      await host.withAgent().execute({ command: CARGO_TEST }, exec(CARGO_TEST));
      assert.deepEqual(host.fake.received, [RTK_CARGO_TEST], "改写与转调都照常");
      assert.ok(
        lines.some((line) => line.includes("insights: record failed")),
        "抛错要留一行日志，不能无声",
      );
    } finally {
      rtk.restore();
    }
  });
});
