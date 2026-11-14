// lib/rewrite-cache.ts 单测：命中、缓存「原样」结论、超容量逐出最久未用、get 刷新新鲜度。
//
// 这一层存在的原因是**成本**：`rtk rewrite` 是每条 bash 命令的固定支出（node spawnSync
// 20 次均值 54.2ms），而 agent 循环里 `git status` / `cargo test` 会反复跑同一条命令。
// 缓存的是**结论**（含「这次不改写」），所以一条坏命令也只 spawn 一次。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRewriteCache } from "../lib/rewrite-cache.ts";
import type { RewriteAttempt } from "../lib/rewrite.ts";

const REWRITTEN: RewriteAttempt = { kind: "rewritten", command: "rtk cargo test" };
const ORIGINAL: RewriteAttempt = { kind: "original", reason: "no-rewrite" };

/** 一条普通命令串：多数用例只关心「同一个 key 上写读」的语义，不关心命令本身。 */
const CARGO_TEST = "cargo test";

describe("createRewriteCache 读写", () => {
  it("未写过 undefined", () => {
    assert.equal(createRewriteCache(2).get(CARGO_TEST), undefined);
  });

  it("写过命中同一对象", () => {
    const cache = createRewriteCache(2);
    cache.set(CARGO_TEST, REWRITTEN);
    assert.equal(cache.get(CARGO_TEST), REWRITTEN);
  });

  it("缓存「原样」结论", () => {
    const cache = createRewriteCache(2);
    cache.set("fd .", ORIGINAL);
    assert.deepEqual(cache.get("fd ."), ORIGINAL);
  });

  it("同 key 覆盖不涨条数", () => {
    const cache = createRewriteCache(1);
    cache.set(CARGO_TEST, REWRITTEN);
    cache.set(CARGO_TEST, ORIGINAL);
    assert.deepEqual(cache.get(CARGO_TEST), ORIGINAL);
    assert.equal(cache.get("未写过的键"), undefined);
  });
});

describe("createRewriteCache 逐出", () => {
  it("超容量逐出最久未用", () => {
    const cache = createRewriteCache(2);
    cache.set("alpha", REWRITTEN);
    cache.set("beta", REWRITTEN);
    cache.set("gamma", REWRITTEN);
    assert.equal(cache.get("alpha"), undefined);
    assert.equal(cache.get("beta"), REWRITTEN);
    assert.equal(cache.get("gamma"), REWRITTEN);
  });

  it("get 刷新新鲜度", () => {
    const cache = createRewriteCache(2);
    cache.set("alpha", REWRITTEN);
    cache.set("beta", REWRITTEN);
    cache.get("alpha");
    cache.set("gamma", REWRITTEN);
    assert.equal(cache.get("alpha"), REWRITTEN);
    assert.equal(cache.get("beta"), undefined);
  });

  it("容量一也能一直只留最新一条", () => {
    const cache = createRewriteCache(1);
    cache.set("alpha", REWRITTEN);
    cache.set("beta", REWRITTEN);
    assert.equal(cache.get("alpha"), undefined);
    assert.equal(cache.get("beta"), REWRITTEN);
  });
});

describe("createRewriteCache 容量", () => {
  it("size 报容量（配置值）不是条数", () => {
    const cache = createRewriteCache(256);
    cache.set(CARGO_TEST, REWRITTEN);
    assert.equal(cache.size, 256);
  });

  it("0 与非有限值抬到 1、小数截断", () => {
    assert.equal(createRewriteCache(0).size, 1);
    assert.equal(createRewriteCache(-5).size, 1);
    assert.equal(createRewriteCache(Number.NaN).size, 1);
    assert.equal(createRewriteCache(3.9).size, 3);
  });
});
