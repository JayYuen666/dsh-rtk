// lib/dedup.ts 单测：两个压缩形态同开时，别把同一次调用压两遍。
//
// 关键事实：`tools/post-execute` 里 `exec.arguments.command` 是**模型原始参数**，不受遮蔽影响。
// 所以 C 形态把 `cargo test` 改写成 `rtk cargo test` 之后，B 监听器看到的命令仍然是
// `cargo test`——两形态同开时同一条命令会被压两次。去重靠的是 callId 一次性账本。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRewrittenCalls, shouldSkipPipe } from "../lib/dedup.ts";

const BOTH_FORMS = ["prefix", "pipe"];
const PIPE_ONLY = ["pipe"];

describe("shouldSkipPipe 三态", () => {
  it("双形态 + 本次调用被 C 改写过 → 跳过", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1");

    assert.equal(shouldSkipPipe({ callId: "call-1" }, BOTH_FORMS, calls), true);
  });

  it("双形态 + 本次调用没被改写 → 不跳过", () => {
    const calls = createRewrittenCalls(8);

    assert.equal(shouldSkipPipe({ callId: "call-1" }, BOTH_FORMS, calls), false);
  });

  it("仅 pipe → 不跳过（没有 C 在压，跳过就是白丢一档收益）", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1");

    assert.equal(shouldSkipPipe({ callId: "call-1" }, PIPE_ONLY, calls), false);
  });

  it("双形态 + 别的调用被改写过 → 不跳过", () => {
    const calls = createRewrittenCalls(8);
    calls.mark("call-1");

    assert.equal(shouldSkipPipe({ callId: "call-2" }, BOTH_FORMS, calls), false);
  });

  it("同一条命令并发两条调用不互相污染（callId 键的理由）", () => {
    // 若拿命令串做键，这两条会互相消费掉对方的账。
    const calls = createRewrittenCalls(8);
    calls.mark("a");
    calls.mark("b");

    assert.equal(shouldSkipPipe({ callId: "a" }, BOTH_FORMS, calls), true);
    assert.equal(shouldSkipPipe({ callId: "b" }, BOTH_FORMS, calls), true);
    assert.equal(shouldSkipPipe({ callId: "c" }, BOTH_FORMS, calls), false);
  });
});

describe("createRewrittenCalls", () => {
  it("记过就能消费", () => {
    const calls = createRewrittenCalls(4);
    calls.mark("x");

    assert.equal(calls.consume("x"), true);
  });

  it("读后即删：第二次消费 false", () => {
    const calls = createRewrittenCalls(4);
    calls.mark("x");
    calls.consume("x");

    assert.equal(calls.consume("x"), false);
  });

  it("没记过则消费 false", () => {
    const calls = createRewrittenCalls(4);

    assert.equal(calls.consume("y"), false);
  });

  it("重复 mark 同一条不占两格", () => {
    const calls = createRewrittenCalls(2);
    calls.mark("a");
    calls.mark("a");
    calls.mark("b");

    assert.equal(calls.consume("a"), true);
    assert.equal(calls.consume("b"), true);
  });

  it("超容量丢最旧（仅兜底，不承担正确性）", () => {
    const calls = createRewrittenCalls(2);
    calls.mark("a");
    calls.mark("b");
    calls.mark("c");

    assert.equal(calls.consume("a"), false);
    assert.equal(calls.consume("b"), true);
    assert.equal(calls.consume("c"), true);
  });

  it("容量给 NaN 时也抬到 1（NaN 会让逐出永不发生）", () => {
    const calls = createRewrittenCalls(Number.NaN);
    calls.mark("a");
    calls.mark("b");

    assert.equal(calls.consume("a"), false);
    assert.equal(calls.consume("b"), true);
  });

  it("容量 0 抬到 1", () => {
    const calls = createRewrittenCalls(0);
    calls.mark("a");

    assert.equal(calls.consume("a"), true);
  });

  it("空串 callId 不记", () => {
    const calls = createRewrittenCalls(2);
    calls.mark("");

    assert.equal(calls.consume(""), false);
  });
});
