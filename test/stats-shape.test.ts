// lib/stats-shape.ts 单测：运行时状态 schema 的字段集与接受/拒绝面，以及命名空间常量的跨产物同源。
//
// 为什么单独有这份（而不是只经由 stats-reader 间接覆盖）：
//
//   1. `statsStatusSchema` 是宿主与客户端**各自打包**的两份产物之间唯一的形状契约。宿主多交
//      一位、客户端不认识，线上只表现为卡片少一句话——`supported` 就是这么漏掉过一次（那时
//      schema 只有四字段，卡片被迫用 `rtkVersion === null` 猜「没装」还是「太旧」）。
//      宿主少交一位，客户端 `parseOrThrow` 会当场点名。两个方向都要有钉在 schema 上的用例。
//
//   2. `RTK_STATS_NAMESPACE` 在 `lib/stats-shape.ts` 与 `src/stats-reader.ts` 各有一份字面量
//      （两份产物独立打包，无法跨产物 import），计划里把「改这里必须同步那边」写成人工纪律。
//      人工纪律没有门禁——所以这里拿 descriptor 的名称去比常量，改漏一边当场红。
//
// 旧累计账本的落盘形状搬去了 `lib/legacy-stats.ts`（Insights 之后它只剩迁移输入这一种用途），
// 它的形状断言连同「只读一次」的语义一起在 `test/stats-store.test.ts` 里。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { RTK_STATS_NAMESPACE, statsStatusSchema } from "../lib/stats-shape.ts";
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

describe("命名空间常量本身", () => {
  it("是 camelCase 的 rtkStats：线上路径 /api/rtkStats/<method> 就是它拼出来的", () => {
    assert.equal(RTK_STATS_NAMESPACE, "rtkStats");
  });
});
