// client 产物的三道门：能构建、与源码同步（指纹）、卡片字段覆盖 host schema。
//
// 前两条在 describe 里跑断言，后两条由夹具登记自己的 it()——所以它们的调用点必须是
// **顶层 await**：裸调用会被 vitest 判成「setup 没进 hook」，挪进 describe 或 beforeAll
// 又会让登记落在收集期之外，那条用例被静默丢掉（实测过：门禁从此不再跑，而套件照绿）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildClient, buildClientFiles } from "../build-client.mjs";
import { declareClientFreshness } from "./client-freshness.ts";
import { declareSchemaCoverage } from "./schema-coverage.ts";

describe("client 产物", () => {
  it("产物带包名 id；槽位键与 $mount 包名在源码声明里同源", async () => {
    const body = await buildClient();
    assert.ok(body.includes('"@jayyuen66/dsh-rtk"'));
    const entry = readFileSync(new URL("../src/client-entry.ts", import.meta.url), "utf8");
    assert.match(entry, /export const BUNDLE_PKG = "@jayyuen66\/dsh-rtk";/u);
    const stats = readFileSync(new URL("../src/stats-reader.ts", import.meta.url), "utf8");
    assert.match(stats, /export const PACKAGE_NAME = "@jayyuen66\/dsh-rtk";/u);
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
      /inject\(\s*[`"']settings\.section[`"']\s*,/u,
      /inject\(\s*[`"']settings\.section\.icon[`"']\s*,/u,
      /navLabel/u,
    ]) {
      assert.match(body, needle, `产物里找不到 ${String(needle)}`);
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

  it("shared 客户端行被外置，且 manifest 与 patch 同步登记", async () => {
    const body = await buildClient();
    assert.match(body, /require\([`"']@jayyuen66\/dsh-plugin-shared\/client[`"']\)/u);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dsh?: { client?: { external?: unknown } };
    };
    assert.deepEqual(pkg.dsh?.client?.external, ["@jayyuen66/dsh-plugin-shared/client"]);
    const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
    assert.match(patch, /^\s*-\s+id:\s*dsh-plugin-shared\s*$/mu);
    assert.match(patch, /^\s+name:\s*"@jayyuen66\/dsh-plugin-shared"\s*$/mu);
    assert.match(patch, /必须保持开启/u);
  });

  it("平台模块 primitives 被外置（内联会给同一页面装第二份 Modal）", async () => {
    // `@deepseek-ai/dsh-client-ui-primitives` 是宿主 PLATFORM_MODULES 里的平台模块。它一旦被
    // 内联进本卡，页面上就有两份 primitives：`Modal` 的 `useModalLayer` 各自维护自己的层级栈，
    // Escape 只关得掉自己那份，而焦点回归会跳到另一个栈里记的元素上。这条门禁钉的是产物面。
    const body = await buildClient();
    assert.match(
      body,
      /require\([`"']@deepseek-ai\/dsh-client-ui-primitives[`"']\)/u,
      "primitives 没被外置：产物里找不到对它的 require",
    );
    // 反向：整份组件库不该出现在产物里。
    assert.ok(!body.includes("acknowledgement"), "primitives 的实现被内联进产物了");
  });

  it("包内 chunk：ECharts 单独一件产物，入口用字面量 require.async 引用它", async () => {
    // 这一条盯的是「ECharts 真的不在入口里」。判据分三段，缺任一段都会让某个失败形态静默：
    // ① 两件产物都在，且 chunk 那件确实带着 Apache 许可头（ECharts 自己 dist 顶部是普通块注释，
    //    `comments:{legal:true}` 只保 `/*!`，所以这段横幅是我们手写进 chunk 源里的）；
    // ② 入口里 `require.async` 的实参是**字面量**：宿主按这个串算 chunkId，模板串在构建期
    //    就被 shared 的 assertChunksReferenced 拦下了，但拦下的时机在打包后，所以这里再钉一次；
    // ③ 入口产物里不能出现 ECharts 的痕迹，否则「点开才下载」是一句空话。
    const artifacts = await buildClientFiles();
    const byName = new Map(artifacts.map((artifact) => [artifact.fileName, artifact.text]));
    const entry = byName.get("client.js");
    const chunk = byName.get("client.insights-echarts.js");
    assert.ok(entry !== undefined, "入口产物缺失");
    assert.ok(chunk !== undefined, "chunk 产物缺失");
    assert.ok(chunk.includes("Apache ECharts"), "chunk 里找不到 ECharts 的许可横幅");
    assert.match(entry, /require\.async\(\s*[`"']\.\/client\.insights-echarts\.js[`"']\s*\)/u);
    // chunk 外壳要带 `chunk:` 位：宿主按它把 factory 注册成 `<包名>/<文件名>` 而不是覆盖入口。
    assert.match(chunk, /^\s*chunk:\s*"client\.insights-echarts\.js",$/mu);
    assert.ok(!entry.includes("Apache ECharts"), "ECharts 被打进入口产物了");
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
