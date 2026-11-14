// positive-int.ts 单测：容量归一的两端。
//
// 这一格单独存在的理由是「非有限值会让有界容器永不逐出」——两个消费方（LRU 缓存与去重
// 账本）都靠它，任一处自己抄一份就会漏改。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { positiveInt } from "../lib/positive-int.ts";

describe("positiveInt", () => {
  it("正整数原样返回", () => {
    assert.equal(positiveInt(256), 256);
  });

  it("小数向下取整", () => {
    assert.equal(positiveInt(2.9), 2);
  });

  it("0 与负数抬到 1", () => {
    assert.equal(positiveInt(0), 1);
    assert.equal(positiveInt(-5), 1);
  });

  it("非有限值退到 1（NaN 参与比较恒为 false，会让逐出永不发生）", () => {
    assert.equal(positiveInt(Number.NaN), 1);
    assert.equal(positiveInt(Number.POSITIVE_INFINITY), 1);
  });
});
