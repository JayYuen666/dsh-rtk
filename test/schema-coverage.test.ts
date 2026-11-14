// volatile 集合的正面断言（卡片侧的字段覆盖门在 build-client.test.ts）。
//
// 这条与卡片那道门方向相反：这边钉「哪些字段**是** volatile」，卡片那边钉「每个 volatile
// 都有控件」。两边都写死期望值——漏标一个 volatile 只会让卡片少一格而一声不响，只有这张表能抓。
//
// 文件名带 `.test.ts` 后缀，与同目录的复制式夹具 `schema-coverage.ts` 区分开：那个是门禁
// 实现（被 build-client.test.ts import），这一份才是断言。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
// 与 host.test.ts 同一理由改名：`Config` 是大写开头的值，直接调用会撞 `eslint(new-cap)`。
import { Config as configSchema } from "../host.ts";

/** 卡片可改的九个字段（标了 `.volatile()`）。 */
const VOLATILE = [
  "denyCommands",
  "enabled",
  "enabledFilters",
  "enabledForms",
  "minBytes",
  "minGainRatio",
  "rewriteHostEnv",
  "stdoutCapBytes",
  "warnHint",
] as const;

/** 非 volatile（改 cordis.yml 的 config: 后重启）。 */
const RESTART_ONLY = [
  "logFilterMode",
  "pipeTimeoutMs",
  "rewriteCacheSize",
  "rewriteTimeoutMs",
  "vitestMaxMajor",
] as const;

describe("volatile 集合", () => {
  it("两个集合不重叠且并集等于全部十四项", () => {
    const all = [...VOLATILE, ...RESTART_ONLY].toSorted();
    assert.equal(all.length, 14);
    assert.equal(new Set(all).size, 14);
    assert.deepEqual(all, Object.keys(configSchema({})).toSorted());
  });

  it("volatile 九项 + 部署级五项 = 十四项（卡片 allowUnbound 的补集恰好是那五项）", () => {
    // 两边数量相加必须等于 14：多一项要么卡片少一格，要么这门少认一个字段。
    assert.equal(VOLATILE.length + 5, 14);
    assert.equal(RESTART_ONLY.length, 5);
  });
});
