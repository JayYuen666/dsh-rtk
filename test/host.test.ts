// host.ts 的配置面与默认导出：十四项终表、解析语义、依赖清单与「不做」清单。
//
// 期望值全部写死在这里，不从 `configSchema({})` 反推——从实现派生的期望值在实现与期望
// 一起改错时仍会全绿，那就不是门禁了。
//
// 两条与计划假设不同、已实测的 schemastery 行为（都写进断言，不让它只活在注释里）：
//   1. **volatile 字段解析出来是引用不是值**（`Volatile<T>`，形如 `{ get() }` 加一个
//      `Symbol(cosmokit.volatile.write)`），所以读默认值必须过 `.get()`；
//   2. **未知键不会被丢弃**：cordis 只走 `Config["~standard"].validate()`（`cordis/lib/index.js`
//      的 `resolveConfig`），而 schemastery 那条适配器调的是 `Schema.resolve(value, this, {})`，
//      `strict` 缺省 false，object 解析器随即 `merge(result, data)` 把未知键并了回去。
//      也就是说「schema 是白名单」这句在 0.2.x 上不成立——真正的约束是 TS 类型与
//      `apply` 只读已知字段，不是运行期过滤。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
// 导入时改名：schema 的值名是 `Config`（首字母大写），直接在用例里 `Config({...})` 调用
// 会被 `eslint(new-cap)` 判成「大写开头只能当构造函数」。真源仍是同一个导出的值。
import plugin, { Config as configSchema } from "../host.ts";

/** spec 的十四项终表（九个 volatile + 五个部署级）。 */
const DEFAULTS = {
  enabled: false,
  // 数组与联合字面量都写显式类型：schema 的输入面要的是可变数组与那条联合，
  // 而 `as const` 交出来的是只读元组（类型上装不进去，运行期却没有区别）。
  enabledForms: ["prefix"] as ("prefix" | "pipe")[],
  denyCommands: [] as string[],
  enabledFilters: ["cargo-test", "pytest", "ctest"] as string[],
  minBytes: 256,
  minGainRatio: 0.95,
  stdoutCapBytes: 64_000,
  warnHint: true,
  rewriteHostEnv: "",
  pipeTimeoutMs: 3000,
  rewriteTimeoutMs: 2000,
  rewriteCacheSize: 256,
  vitestMaxMajor: 5,
  logFilterMode: "off" as "off" | "on",
};

/** 九个 volatile 字段名（卡片可改的那一批）。 */
const VOLATILE_KEYS = [
  "enabled",
  "enabledForms",
  "denyCommands",
  "enabledFilters",
  "minBytes",
  "minGainRatio",
  "stdoutCapBytes",
  "warnHint",
  "rewriteHostEnv",
] as const;

/**
 * 把解析结果里的一个字段读成纯值。
 *
 * volatile 字段解析出来是 `Volatile<T>` 引用，非 volatile 是裸值——这个差别是官方
 * `.volatile()` 的语义，不是本包自选，所以顺手把它写成断言（见「volatile 与普通值」那条），
 * 读值这一步则统一在这里收口。
 */
function readField(parsed: Record<string, unknown>, key: string): unknown {
  const slot = parsed[key];
  return typeof slot === "object" && slot !== null && "get" in slot
    ? (slot as { get: () => unknown }).get()
    : slot;
}

describe("config 默认值", () => {
  it("十四项逐项等于终表", () => {
    const parsed = configSchema(DEFAULTS) as unknown as Record<string, unknown>;
    for (const [key, want] of Object.entries(DEFAULTS)) {
      assert.deepEqual(readField(parsed, key), want, key);
    }
  });

  it("空配置也能解析（每一项都有默认）", () => {
    const parsed = configSchema({}) as unknown as Record<string, unknown>;
    assert.equal(readField(parsed, "enabled"), false);
    assert.deepEqual(readField(parsed, "enabledForms"), ["prefix"]);
    assert.deepEqual(readField(parsed, "enabledFilters"), ["cargo-test", "pytest", "ctest"]);
    assert.equal(readField(parsed, "rewriteHostEnv"), "");
    assert.equal(readField(parsed, "vitestMaxMajor"), 5);
    assert.equal(readField(parsed, "logFilterMode"), "off");
  });

  it("volatile 是引用（要 .get()），部署级是裸值：这个差别决定 apply 里的读法", () => {
    const parsed = configSchema({}) as unknown as Record<string, unknown>;
    for (const key of VOLATILE_KEYS) {
      const slot = parsed[key];
      assert.equal(typeof slot, "object", `${key} 应是 Volatile 引用`);
      assert.equal(typeof (slot as { get?: unknown }).get, "function", `${key} 应带 get()`);
    }
    // 只过滤、不用 continue：工作区把 no-continue 判成 error（脚本侧才有豁免）。
    const deployOnly = Object.keys(DEFAULTS).filter(
      (key) => !(VOLATILE_KEYS as readonly string[]).includes(key),
    );
    for (const key of deployOnly) {
      assert.equal(typeof parsed[key] === "object", false, `${key} 是部署级字段，应是裸值`);
    }
  });

  it("显式给的值会盖过默认（volatile 也能在装载期收到值）", () => {
    const parsed = configSchema({
      enabled: true,
      enabledForms: ["prefix", "pipe"],
      minGainRatio: 0.5,
    }) as unknown as Record<string, unknown>;
    assert.equal(readField(parsed, "enabled"), true);
    assert.deepEqual(readField(parsed, "enabledForms"), ["prefix", "pipe"]);
    assert.equal(readField(parsed, "minGainRatio"), 0.5);
  });

  it("enabledForms 只收 prefix / pipe：拼错的形态必须在装载期炸，不能静默降级", () => {
    // 故意越过类型面：这条钉的正是**运行期**还会不会再拦一次。
    assert.throws(() =>
      configSchema({ enabledForms: ["rewrite"] as unknown as ("prefix" | "pipe")[] }),
    );
  });

  it("minGainRatio 越界在装载期炸（压缩比是 0~1 的比例，不是百分数）", () => {
    assert.throws(() => configSchema({ minGainRatio: 95 }));
  });

  it("prefixCommands 已不存在（v1 自建前缀表时代的字段）", () => {
    assert.equal(Object.hasOwn(configSchema({}), "prefixCommands"), false);
  });

  it("未知键不被运行期过滤（schemastery 非严格解析；真正的约束是 TS 类型与 apply 的读法）", () => {
    // 这条钉的是**行为真相**而不是理想：cordis 只调 `~standard.validate`，那条适配器
    // 走 `Schema.resolve(value, this, {})`（strict 缺省 false），object 解析器 merge 了
    // 原始入参，未知键于是留在结果里。写成「被丢弃」会让测试对着假象绿。
    const parsed = configSchema({ unknownThing: 1 }) as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(parsed, "unknownThing"), true);
    // 但已知字段照样被 schema 归一，两者互不影响。
    assert.equal(readField(parsed, "vitestMaxMajor"), 5);
  });
});

describe("默认导出", () => {
  it("inject 覆盖本插件全部宿主服务依赖", () => {
    assert.deepEqual(
      plugin.inject.toSorted(),
      ["settings", "storageDomain", "subprocess", "tools", "workingDirectory"].toSorted(),
    );
  });

  it("config 与具名导出一致（宿主读的是默认导出那一份）", () => {
    assert.equal(plugin.Config, configSchema);
  });

  it("不注册模型工具、不注入 systemPrompt、不挂 guard（spec 的「不做」清单）", () => {
    assert.equal(Object.hasOwn(plugin, "tools"), false);
    assert.equal(Object.hasOwn(plugin, "systemPrompt"), false);
    assert.equal(Object.hasOwn(plugin, "guard"), false);
  });

  it("apply 是函数（装配入口在位）", () => {
    assert.equal(typeof plugin.apply, "function");
  });
});
