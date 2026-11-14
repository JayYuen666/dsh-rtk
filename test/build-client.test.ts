// client 产物的三道门：能构建、与源码同步（指纹）、卡片字段覆盖 host schema。
//
// 前两条在 describe 里跑断言，后两条由夹具登记自己的 it()——所以它们的调用点必须是
// **顶层 await**：裸调用会被 vitest 判成「setup 没进 hook」，挪进 describe 或 beforeAll
// 又会让登记落在收集期之外，那条用例被静默丢掉（实测过：门禁从此不再跑，而套件照绿）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildClient } from "../build-client.mjs";
import { declareClientFreshness } from "./client-freshness.ts";
import { declareSchemaCoverage } from "./schema-coverage.ts";

describe("client 产物", () => {
  it("包含 BUNDLE_PKG 与 PACKAGE_NAME 两个字面量（槽位键与 $mount 包名同源）", async () => {
    const body = await buildClient();
    assert.ok(body.includes('"@jayyuen66/dsh-rtk"'));
    // 至少两处：verifyName 那两道核对分别读 BUNDLE_PKG 与 PACKAGE_NAME 的声明。
    assert.ok((body.match(/"@jayyuen66\/dsh-rtk"/gu) ?? []).length >= 2);
  });

  it("产物里带着设置页一级分区的三条注册（分区 + 图标 + 导航名）", async () => {
    // 这三个串是「分区真的注册了」在产物面上的唯一证据：本包的 client-entry 是纯浏览器入口
    // （vitest 的覆盖率分母刻意排除它），node 侧没有可驱动的 apply，所以判据只能落在产物上。
    // 缺一条的症状各不相同：少 `settings.section` 是设置页根本没这一页；少
    // `settings.section.icon` 是页在、图标始终是默认齿轮；少 `navLabel` 是导航行空白
    // （`label` 是 thunk，取不到键时不会报错，只是没有字）。
    const body = await buildClient();
    // 断的是**注册调用**而不是裸槽名：`name: "settings.section.icon"` 这一行在注册体里也出现，
    // 只搜槽名的话「inject 那一侧被改坏」仍然通过（变异测试实测过这一条假阴性）。
    for (const needle of [
      'inject("settings.section",',
      'inject("settings.section.icon",',
      "navLabel",
    ]) {
      assert.ok(body.includes(needle), `产物里找不到 ${needle}`);
    }
  });

  it("react 被外置（运行时内联进产物会让页面出现第二份 React）", async () => {
    const body = await buildClient();
    assert.ok(
      body.includes('require("react")') ||
        body.includes('from"react"') ||
        body.includes('from "react"'),
    );
    assert.ok(!body.includes("useState=function"), "react 运行时被内联进产物了");
  });
});

await declareClientFreshness(import.meta.url);
await declareSchemaCoverage(import.meta.url, {
  allowUnbound: [
    {
      field: "pipeTimeoutMs",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：pipe 超时随仓库规模调整，不是用户可调项",
    },
    {
      field: "rewriteTimeoutMs",
      reason: "非 volatile 部署值（cordis.yml config: 改）：rtk rewrite 超时，改大可容忍更慢的机器",
    },
    {
      field: "rewriteCacheSize",
      reason: "非 volatile 部署值（cordis.yml config: 改）：结论缓存容量，内存预算项",
    },
    {
      field: "vitestMaxMajor",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：vitest 版本门控上界，跟着 rtk 修好 vitest 5 之后抬",
    },
    {
      field: "logFilterMode",
      reason: "非 volatile 部署值（cordis.yml config: 改）：诊断日志开关，默认 off",
    },
  ],
});
