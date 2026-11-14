// lib/shape-precheck.ts 单测：在花一次 spawn 之前拦掉「把 pytest 输出喂给 cargo filter」这类错配。
//
// 判据是形态 token 必须是该工具**独有**的结构标记。`passed` / `FAILED` 这类通用词不能用：
// 真 cargo 输出也含 `passed`，那样 cargo 输出会通过 pytest 的预检，预检等于没做。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { shapeMatches } from "../lib/shape-precheck.ts";

const CODE = "@dataclass\nclass UserModel:\n    name: str\n\ndef f():\n    return 1\n";
const CARGO = "running 2 tests\ntest a ... ok\ntest result: ok. 2 passed; 0 failed\n";
const CARGO_COMPILE_FAIL = "error[E0308]: mismatched types\n --> src/lib.rs:10:9\n";
const PYTEST =
  "==== test session starts ====\nplatform darwin -- Python 3.14\nrootdir: /x\n==== 2 passed in 0.1s ====\n";
const PYTEST_ZERO =
  "==== test session starts ====\nplatform darwin\n==== no tests ran in 0.01s ====\n";
const VITEST = "Test Files  1 passed (1)\n     Tests  2 passed (2)\n";
const CTEST = "Test #1: alpha ...   Passed\n100% tests passed, 0 tests failed out of 1\n";
// 单条用例的输出没有汇总行——此时唯一的结构标记就是 `Test #`，它必须自己能顶住。
const CTEST_ONE = "Test #3: beta ...   Passed    0.01 sec\n";

const CARGO_FILTER = "cargo-test";

describe("代码文本零命中", () => {
  it("三个默认 filter 都不匹配源码", () => {
    for (const filter of [CARGO_FILTER, "pytest", "ctest"]) {
      assert.equal(shapeMatches(filter, CODE), false, filter);
    }
  });
});

describe("真输出各自匹配", () => {
  it("cargo 测试输出", () => {
    assert.equal(shapeMatches(CARGO_FILTER, CARGO), true);
  });

  it("cargo 编译失败输出", () => {
    assert.equal(shapeMatches(CARGO_FILTER, CARGO_COMPILE_FAIL), true);
  });

  it("pytest 输出", () => {
    assert.equal(shapeMatches("pytest", PYTEST), true);
  });

  it("pytest 零收集输出（一行用例都没有）", () => {
    assert.equal(shapeMatches("pytest", PYTEST_ZERO), true);
  });

  it("vitest 输出", () => {
    assert.equal(shapeMatches("vitest", VITEST), true);
  });

  it("ctest 输出", () => {
    assert.equal(shapeMatches("ctest", CTEST), true);
  });

  it("ctest 单条用例输出（没有汇总行）", () => {
    assert.equal(shapeMatches("ctest", CTEST_ONE), true);
  });
});

describe("九格交叉错配全不匹配", () => {
  it("cargo 输出不匹配其余三个", () => {
    for (const filter of ["pytest", "vitest", "ctest"]) {
      assert.equal(shapeMatches(filter, CARGO), false, filter);
    }
  });

  it("pytest 输出不匹配其余三个", () => {
    for (const filter of [CARGO_FILTER, "vitest", "ctest"]) {
      assert.equal(shapeMatches(filter, PYTEST), false, filter);
    }
  });

  it("vitest 输出不匹配其余三个", () => {
    for (const filter of [CARGO_FILTER, "pytest", "ctest"]) {
      assert.equal(shapeMatches(filter, VITEST), false, filter);
    }
  });
});

describe("未登记不预检", () => {
  it("tsc / log / 未知 filter 一律放行", () => {
    assert.equal(shapeMatches("tsc", CODE), true);
    assert.equal(shapeMatches("log", CODE), true);
    assert.equal(shapeMatches("nope", ""), true);
  });
});
