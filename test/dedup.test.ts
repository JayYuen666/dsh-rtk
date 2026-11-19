// lib/dedup.ts 单测：两个压缩形态同开时，别把同一次调用压两遍。
//
// 关键事实：`tools/post-execute` 里 `exec.arguments.command` 是**模型原始参数**，不受遮蔽影响。
// 所以 C 形态把 `cargo test` 改写成 `rtk cargo test` 之后，B 监听器看到的命令仍然是
// `cargo test`——两形态同开时同一条命令会被压两次。去重靠的是 callId 一次性账本。
//
// 第二个关键事实（0.2.2 起）：账本记的是**改写后的命令**。「被改写过」不等于「已经被压过」
// ——`rtk read` 的 `--level` 默认 `none`，逐字节透传。所以让路判据要按改写产物分辨。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRewrittenCalls, isVerbatimRewrite, shouldSkipPipe } from "../lib/dedup.ts";

const BOTH_FORMS = ["prefix", "pipe"];
const PIPE_ONLY = ["pipe"];

/** 真的在压的改写产物：cargo test 被 rtk 接管后输出只剩关键行。 */
const RTK_CARGO_TEST = "rtk cargo test";
/** 逐字节透传的改写产物：`rtk read` 默认 `--level none`。 */
const RTK_READ_LOG = "rtk read build.log";

describe("shouldSkipPipe 三态", () => {
  it("双形态 + 本次调用被 C 改写过 → 跳过", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1", RTK_CARGO_TEST);

    assert.equal(shouldSkipPipe({ callId: "call-1" }, BOTH_FORMS, calls), true);
  });

  it("双形态 + 本次调用没被改写 → 不跳过", () => {
    const calls = createRewrittenCalls(8);

    assert.equal(shouldSkipPipe({ callId: "call-1" }, BOTH_FORMS, calls), false);
  });

  it("仅 pipe → 不跳过（没有 C 在压，跳过就是白丢一档收益）", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1", RTK_CARGO_TEST);

    assert.equal(shouldSkipPipe({ callId: "call-1" }, PIPE_ONLY, calls), false);
  });

  it("双形态 + 别的调用被改写过 → 不跳过", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1", RTK_CARGO_TEST);

    assert.equal(shouldSkipPipe({ callId: "call-2" }, BOTH_FORMS, calls), false);
  });

  it("同一条命令并发两条调用不互相污染（callId 键的理由）", () => {
    // 若拿命令串做键，这两条会互相消费掉对方的账。
    const calls = createRewrittenCalls(8);
    calls.mark("a", RTK_CARGO_TEST);
    calls.mark("b", RTK_CARGO_TEST);

    assert.equal(shouldSkipPipe({ callId: "a" }, BOTH_FORMS, calls), true);
    assert.equal(shouldSkipPipe({ callId: "b" }, BOTH_FORMS, calls), true);
    assert.equal(shouldSkipPipe({ callId: "c" }, BOTH_FORMS, calls), false);
  });
});

describe("shouldSkipPipe 与透传式改写", () => {
  it("改写成 `rtk read <日志>` → 不跳过：rtk 一个字节都没压，窗口还有机会", () => {
    // 这是 0.2.2 修掉的那条漏收益：`cat build.log` 被前缀层改写成 `rtk read build.log`，
    // 而 `rtk read` 默认 `--level none` 逐字节透传（实测 22,390 B 进、22,390 B 出）。
    // 早退在这里等于把本包窗口能砍掉的那部分白丢。
    const calls = createRewrittenCalls(8);
    calls.mark("call-1", RTK_READ_LOG);

    assert.equal(shouldSkipPipe({ callId: "call-1" }, BOTH_FORMS, calls), false);
  });

  it("透传式改写也照样消费账本：同一条调用不会被反复问", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1", RTK_READ_LOG);
    shouldSkipPipe({ callId: "call-1" }, BOTH_FORMS, calls);

    assert.equal(calls.consume("call-1"), undefined);
  });

  it("改写成带切窗参数的 `rtk read` → 跳过：那一次 rtk 真的在压", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1", "rtk read build.log --head-lines 10");

    assert.equal(shouldSkipPipe({ callId: "call-1" }, BOTH_FORMS, calls), true);
  });

  it("仅 pipe 时透传式改写也不跳过（这条判据根本轮不到）", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1", RTK_READ_LOG);

    assert.equal(shouldSkipPipe({ callId: "call-1" }, PIPE_ONLY, calls), false);
  });
});

describe("isVerbatimRewrite", () => {
  it("`rtk read <目标>` 逐字节透传", () => {
    assert.equal(isVerbatimRewrite(RTK_READ_LOG), true);
    assert.equal(isVerbatimRewrite("rtk read /tmp/a.log /tmp/b.log"), true);
    // `-n` 只加行号，内容还是原文。
    assert.equal(isVerbatimRewrite("rtk read -n build.log"), true);
  });

  it("带切窗或改档参数的 `rtk read` 不再透传", () => {
    for (const shaped of [
      "rtk read build.log --head-lines 50",
      "rtk read build.log --tail-lines 200",
      "rtk read -m 50 build.log",
      "rtk read --max-lines=50 build.log",
      "rtk read -l aggressive build.log",
      "rtk read --level aggressive build.log",
    ]) {
      assert.equal(isVerbatimRewrite(shaped), false, shaped);
    }
  });

  it("别的改写目标都不是透传（它们真的在压）", () => {
    for (const pressing of [
      RTK_CARGO_TEST,
      "rtk git status",
      "rtk git diff HEAD~1",
      "rtk ls -la",
      "rtk grep -rn foo .",
      "rtk vitest run",
    ]) {
      assert.equal(isVerbatimRewrite(pressing), false, pressing);
    }
  });

  it("前缀形似 `rtk read` 但不是它（`rtk readme`、`rtk readX`）不算", () => {
    // 判据锚在词边界上：`rtk\s+read(?:\s|$)` 要求 read 之后是空白或串尾。
    assert.equal(isVerbatimRewrite("rtk readme build.log"), false);
    assert.equal(isVerbatimRewrite("rtk reader"), false);
  });

  it("前后空白不影响判定", () => {
    assert.equal(isVerbatimRewrite(`  ${RTK_READ_LOG}  `), true);
  });
});

describe("createRewrittenCalls", () => {
  it("记过就能消费，且拿回的是改写后的命令", () => {
    const calls = createRewrittenCalls(4);
    calls.mark("x", RTK_CARGO_TEST);

    assert.equal(calls.consume("x"), RTK_CARGO_TEST);
  });

  it("读后即删：第二次消费 undefined", () => {
    const calls = createRewrittenCalls(4);
    calls.mark("x", RTK_CARGO_TEST);
    calls.consume("x");

    assert.equal(calls.consume("x"), undefined);
  });

  it("没记过则消费 undefined", () => {
    const calls = createRewrittenCalls(4);

    assert.equal(calls.consume("y"), undefined);
  });

  it("重复 mark 同一条不占两格，且后写的命令覆盖先写的", () => {
    const calls = createRewrittenCalls(2);
    calls.mark("a", "rtk read a.log");
    calls.mark("a", RTK_CARGO_TEST);
    calls.mark("b", RTK_CARGO_TEST);

    assert.equal(calls.consume("a"), RTK_CARGO_TEST);
    assert.equal(calls.consume("b"), RTK_CARGO_TEST);
  });

  it("超容量丢最旧（仅兜底，不承担正确性）", () => {
    const calls = createRewrittenCalls(2);
    calls.mark("a", RTK_CARGO_TEST);
    calls.mark("b", RTK_CARGO_TEST);
    calls.mark("c", RTK_CARGO_TEST);

    assert.equal(calls.consume("a"), undefined);
    assert.equal(calls.consume("b"), RTK_CARGO_TEST);
    assert.equal(calls.consume("c"), RTK_CARGO_TEST);
  });

  it("容量给 NaN 时也抬到 1（NaN 会让逐出永不发生）", () => {
    const calls = createRewrittenCalls(Number.NaN);
    calls.mark("a", RTK_CARGO_TEST);
    calls.mark("b", RTK_CARGO_TEST);

    assert.equal(calls.consume("a"), undefined);
    assert.equal(calls.consume("b"), RTK_CARGO_TEST);
  });

  it("容量 0 抬到 1", () => {
    const calls = createRewrittenCalls(0);
    calls.mark("a", RTK_CARGO_TEST);

    assert.equal(calls.consume("a"), RTK_CARGO_TEST);
  });

  it("空串 callId 不记", () => {
    const calls = createRewrittenCalls(2);
    calls.mark("", RTK_CARGO_TEST);

    assert.equal(calls.consume(""), undefined);
  });
});
