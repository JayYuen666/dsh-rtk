// lib/stats-shape.ts 单测：三份 schema 的字段集与接受/拒绝面，以及命名空间常量的跨产物同源。
//
// 为什么单独有这份（而不是只经由 stats-store / stats-reader 间接覆盖）：
//
//   1. `statsStatusSchema` 是宿主与客户端**各自打包**的两份产物之间唯一的形状契约。宿主多交
//      一位、客户端不认识，线上只表现为卡片少一句话——`supported` 就是这么漏掉过一次（那时
//      schema 只有四字段，卡片被迫用 `rtkVersion === null` 猜「没装」还是「太旧」）。
//      宿主少交一位，客户端 `parseOrThrow` 会当场点名。两个方向都要有钉在 schema 上的用例。
//
//   2. `RTK_STATS_NAMESPACE` 在 `lib/stats-shape.ts` 与 `src/stats-reader.ts` 各有一份字面量
//      （两份产物独立打包，无法跨产物 import），计划里把「改这里必须同步那边」写成人工纪律。
//      人工纪律没有门禁——所以这里拿 descriptor 的名称去比常量，改漏一边当场红。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  EMPTY_ACCUMULATOR,
  RTK_STATS_NAMESPACE,
  statsAccumulatorSchema,
  statsStatusSchema,
  statsSummarySchema,
  summarize,
} from "../lib/stats-shape.ts";
import type { StatsStatus } from "../lib/stats-shape.ts";
import { STATS_DESCRIPTORS } from "../src/stats-reader.ts";

/** 这些字面量在用例里各出现多次，提成常量（`sonarjs(no-duplicate-string)` 数到三次就红）。 */
const RTK_PATH = "/opt/homebrew/bin/rtk";
const RTK_VERSION = "rtk 1.2.0";
const PREFIX_FORM = "prefix";
const STATUS_FIELD = "supported";

/** 一份形状完整的运行时状态。各用例只改动它关心的那一位，避免每条重抄五个字段。 */
function statusOf(overrides: Partial<StatsStatus> = {}): StatsStatus {
  return {
    rtkPath: RTK_PATH,
    rtkVersion: RTK_VERSION,
    supported: true,
    enabled: true,
    forms: [PREFIX_FORM],
    ...overrides,
  };
}

/** 取拒绝路径，方便断言「红在哪一位」而不是只断言「红了」。 */
function issuePaths(value: unknown): string[] {
  const parsed = statsStatusSchema.safeParse(value);
  assert.equal(parsed.success, false, `本该被拒，却通过了：${JSON.stringify(value)}`);
  return parsed.error.issues.map((issue) => issue.path.join("."));
}

describe("statsStatusSchema 字段集", () => {
  it("恰好五个字段（多一位少一位都要改这份期望，别让字段集悄悄漂）", () => {
    assert.deepEqual(Object.keys(statsStatusSchema.shape).toSorted(), [
      "enabled",
      "forms",
      "rtkPath",
      "rtkVersion",
      "supported",
    ]);
  });

  it("完整形状原样通过（parse 不增不改）", () => {
    const status = statusOf();
    assert.deepEqual(statsStatusSchema.parse(status), status);
  });

  it("supported 三态都接受：true / false / null", () => {
    for (const supported of [true, false, null]) {
      assert.equal(
        statsStatusSchema.parse(statusOf({ supported })).supported,
        supported,
        `supported=${String(supported)} 不该被拒`,
      );
    }
  });

  it("rtkPath 与 rtkVersion 允许 null（探不到时的两种落点）", () => {
    const parsed = statsStatusSchema.parse(statusOf({ rtkPath: null, rtkVersion: null }));
    assert.equal(parsed.rtkPath, null);
    assert.equal(parsed.rtkVersion, null);
  });
});

describe("statsStatusSchema 拒绝面", () => {
  it("少 supported 一位就拒，且点名 supported", () => {
    // 四字段形状 = 上一版宿主产物。客户端产物先发、宿主后升（或反过来）时，这一格会真的出现。
    const fourFields = {
      rtkPath: RTK_PATH,
      rtkVersion: RTK_VERSION,
      enabled: true,
      forms: [PREFIX_FORM],
    };
    assert.deepEqual(issuePaths(fourFields), [STATUS_FIELD]);
  });

  it("supported 用字符串冒充 boolean 也拒", () => {
    assert.deepEqual(issuePaths({ ...statusOf(), supported: "true" }), [STATUS_FIELD]);
  });

  it("enabled 非 boolean、forms 非字符串数组都拒", () => {
    assert.deepEqual(issuePaths({ ...statusOf(), enabled: "yes" }), ["enabled"]);
    assert.deepEqual(issuePaths({ ...statusOf(), forms: [1] }), ["forms.0"]);
  });
});

describe("statsStatusSchema 的未知键", () => {
  it("多出来的字段被剥掉（不是被拒）——宿主加字段不会打红旧客户端，但也传不到卡片", () => {
    const parsed = statsStatusSchema.parse({ ...statusOf(), futureField: 1 });
    assert.equal(Object.hasOwn(parsed, "futureField"), false);
  });
});

describe("命名空间在宿主与客户端两侧同源", () => {
  it("每条 descriptor 的 namespace / service 都等于 RTK_STATS_NAMESPACE", () => {
    assert.ok(STATS_DESCRIPTORS.length > 0);
    for (const descriptor of STATS_DESCRIPTORS) {
      assert.equal(descriptor.namespace, RTK_STATS_NAMESPACE, `${descriptor.id} 的 namespace 漂了`);
      assert.equal(descriptor.service, RTK_STATS_NAMESPACE, `${descriptor.id} 的 service 漂了`);
    }
  });
});

describe("落盘形状与投影形状的分工", () => {
  it("派生值只在投影里：落盘 schema 的多余键被剥掉", () => {
    const parsed = statsAccumulatorSchema.parse({
      ...EMPTY_ACCUMULATOR,
      savedBytes: 10,
      savingsPct: 50,
    });
    assert.equal(Object.hasOwn(parsed, "savedBytes"), false);
    assert.equal(Object.hasOwn(parsed, "savingsPct"), false);
  });

  it("负数统计被拒（bytes 与 commands 都不可能是负的）", () => {
    for (const field of ["commands", "originalBytes", "compressedBytes"] as const) {
      const parsed = statsAccumulatorSchema.safeParse({ ...EMPTY_ACCUMULATOR, [field]: -1 });
      assert.equal(parsed.success, false, `${field} 收下了 -1`);
    }
  });

  it("存量账本没有 token 两列时，topFilters 的占比是 0 而不是 NaN", () => {
    // 域版本 ≤2 的记录里每条 filter 的 savedTokens 都是 0、总 originalTokens 也是 0。
    // 除下去是 NaN，而 NaN 会被卡片原样打进 style 宽度（`width: NaN%`）——浏览器静默忽略，
    // 症状是柱子一根都看不见，且没有任何东西会报错。所以这一格必须单独钉。
    const summary = summarize({
      ...EMPTY_ACCUMULATOR,
      commands: 1,
      originalBytes: 200,
      compressedBytes: 100,
      byFilter: { "cargo-test": { commands: 1, savedBytes: 100, savedTokens: 0 } },
    });
    assert.deepEqual(
      summary.topFilters.map((row) => row.sharePct),
      [0],
    );
    assert.equal(summary.topFilters.length, 1);
  });

  it("topFilters 的占比是各 filter 在总节省 token 中的份额，合计 100%", () => {
    // 分母必须是「总节省 token」（originalTokens - compressedTokens），不是总原文 token。
    // 后者会让所有 filter 的占比之和等于整体节省率，读起来像分布但实际是贡献率。
    const summary = summarize({
      ...EMPTY_ACCUMULATOR,
      originalTokens: 1000,
      compressedTokens: 600,
      byFilter: {
        "cargo-test": { commands: 1, savedBytes: 10, savedTokens: 300 },
        grep: { commands: 1, savedBytes: 10, savedTokens: 100 },
      },
    });
    assert.deepEqual(
      summary.topFilters.map((row) => [row.filter, row.sharePct]),
      [
        ["cargo-test", 75],
        ["grep", 25],
      ],
    );
  });

  it("topFilters 按 savedTokens 降序，且最多 6 条", () => {
    // 只验排序与截断这两件事：卡片拿它直接画柱子，顺序错就是「第二大的柱子更长」。
    const byFilter = Object.fromEntries(
      ["f1", "f2", "f3", "f4", "f5", "f6", "f7"].map((filter, index) => [
        filter,
        { commands: 1, savedBytes: 10, savedTokens: index * 10 },
      ]),
    );
    const summary = summarize({
      ...EMPTY_ACCUMULATOR,
      originalTokens: 1000,
      compressedTokens: 500,
      byFilter,
    });
    assert.deepEqual(
      summary.topFilters.map((row) => row.filter),
      ["f7", "f6", "f5", "f4", "f3", "f2"],
    );
  });

  it("summarize 的输出能过投影 schema（两处口径不会分叉）", () => {
    const summary = summarize({
      ...EMPTY_ACCUMULATOR,
      commands: 1,
      originalBytes: 200,
      compressedBytes: 100,
    });
    const parsed = statsSummarySchema.parse(summary);
    assert.deepEqual(parsed, summary);
  });
});
