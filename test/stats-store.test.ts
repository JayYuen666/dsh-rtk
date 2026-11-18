// test/stats-store.test.ts —— 旧累计账本的**只读**入口。
//
// 这一层只依赖「拿声明换句柄、再读一张表」，所以测试用同形替身而不是真起 storage hub：
// 断言的是**四种「没有」的分辨**、谁 open 谁 close、以及异常路径也把名字还回去。
// 真后端的 roundtrip 由「已发布产物」回路覆盖。
//
// 受影响的公共面（本轮改造）：`lib/stats-store.ts` 的导出从「累加 + 投影 + 延迟 store」收窄为
// `SUMMARY_KEY` / `legacyStatsDomain` / `LegacyStatsTable` / `LegacyStatsDomain` /
// `LegacyStatsFacility` / `LegacyStatsHost` / `loadLegacyAccumulator`；旧累计账本的落盘形状
// （`LEGACY_ACCUMULATOR_SCHEMA` / `LegacyAccumulator` / `EMPTY_LEGACY_ACCUMULATOR`）搬去了
// `lib/legacy-stats.ts`，`lib/stats-shape.ts` 只剩命名空间常量与 `statsStatusSchema`。
// 同步范围：本文件（整份重写）、`test/stats-shape.test.ts`（已裁剪）、`test/card-logic.test.ts`
// （删 `chartBarsOf` 段）、`test/integration/host-stack.ts`（去 `stats` 收件箱）、
// `test/apply.test.ts`（去 `makeCountRewrite` 与 storageDomain 必需位）、`test/host.test.ts`
// （inject 名单）、`test/build-host.test.ts`（旧域标签断言）；文档面 `README` 双语与
// `docs/DETAIL*.md` 在 Task 12 同步。
//
// 用户指令原文（m05053）：「Task 11 与 Task 12 都应该落实」。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { EMPTY_LEGACY_ACCUMULATOR } from "../lib/legacy-stats.ts";
import type { LegacyAccumulator } from "../lib/legacy-stats.ts";
import { SUMMARY_KEY, legacyStatsDomain, loadLegacyAccumulator } from "../lib/stats-store.ts";
import type { LegacyStatsDomain, LegacyStatsFacility } from "../lib/stats-store.ts";

/** 表里存着的那一份账本：命令数取非零值，好让「读到了」与「读到空的」当场分开。 */
const STORED: LegacyAccumulator = {
  ...EMPTY_LEGACY_ACCUMULATOR,
  commands: 7,
  originalBytes: 700,
  compressedBytes: 70,
  byForm: { prefix: 3, pipe: 4 },
};

/** 记一次 close 的调用次数（每次 open 都要配一次 close，所以按次数断言而不是布尔）。 */
interface Closes {
  count: number;
}

/**
 * 造一个存储设施替身。
 *
 * `open` 的三种结局各有用例：给一句柄、直接抛、给一个读表时就抛的句柄——后者是「后端坏了」
 * 的真实形状，而它最容易被写成「open 成功就算读到了」。
 */
function facilityOf(
  options: {
    readonly stored?: LegacyAccumulator | undefined;
    readonly openError?: Error | undefined;
    readonly readError?: Error | undefined;
  } = {},
): { readonly facility: LegacyStatsFacility; readonly closes: Closes } {
  const closes: Closes = { count: 0 };
  const domain: LegacyStatsDomain = {
    table: () => ({
      get: (): LegacyAccumulator | undefined => {
        if (options.readError !== undefined) {
          throw options.readError;
        }
        return options.stored;
      },
    }),
    close: () => {
      closes.count += 1;
      return Promise.resolve();
    },
  };
  return {
    closes,
    facility: {
      open: () =>
        options.openError === undefined
          ? Promise.resolve(domain)
          : Promise.reject(options.openError),
    },
  };
}

/** 空表的 `get`：空表就是「没有这条记录」（与 `test/apply.test.ts` 的同名桩同形）。 */
const noRecord = (): undefined => void 0;

/** 宿主面的最小替身：只回答 `storageDomain` 这一个名字。 */
function hostOf(value: unknown): { readonly get: (name: string) => unknown } {
  return {
    get: (name: string): unknown => (name === "storageDomain" ? value : undefined),
  };
}

describe("legacyStatsDomain 的持久面身份", () => {
  it("域名与版本逐字沿用旧版：改它就读不到旧文件", () => {
    // 这两位的取值不是风格问题——宿主按名字找落盘文件，而 `compatibleVersions` 决定版本 1
    // 的旧记录在 open 时是被接受还是被丢弃。
    assert.equal(legacyStatsDomain.name, "rtk_stats");
    assert.equal(legacyStatsDomain.version, 2);
    assert.equal(SUMMARY_KEY, "summary");
  });
});

describe("loadLegacyAccumulator：四种「没有」", () => {
  it("宿主没有 storageDomain 服务时给 null（只问了这一个名字）", async () => {
    const asked: string[] = [];
    const result = await loadLegacyAccumulator({
      get: (name: string): unknown => {
        asked.push(name);
        return undefined;
      },
    });
    assert.equal(result, null);
    // 服务缺席是「这个部署没有存储面」，不是故障：调用点不该看到一次 open。
    assert.deepEqual(asked, ["storageDomain"]);
  });

  it("宿主连 get 都没有时也给 null（半栈夹具的形状）", async () => {
    assert.equal(await loadLegacyAccumulator({}), null);
  });

  it("服务在但形状不对（没有 open）时给 null，不是硬转一句柄", async () => {
    // 表工厂本身不参与判定（本层只问 `open` 在不在），所以给它一个不回任何值的空体。
    assert.equal(await loadLegacyAccumulator(hostOf({ table: () => ({ get: noRecord }) })), null);
    assert.equal(await loadLegacyAccumulator(hostOf(5)), null);
    assert.equal(await loadLegacyAccumulator(hostOf(null)), null);
  });

  it("服务在、表里没有记录时给 null", async () => {
    const { facility } = facilityOf();
    assert.equal(await loadLegacyAccumulator(hostOf(facility)), null);
  });
});

describe("loadLegacyAccumulator：读到与关掉", () => {
  it("读到那一份账本原样交回，并且读完就关域（谁 open 谁 close）", async () => {
    const { facility, closes } = facilityOf({ stored: STORED });
    const result = await loadLegacyAccumulator(hostOf(facility));
    assert.deepEqual(result, STORED);
    // 关得越早越好：同名域重复 open 会抛 `already-open`，而这份账本此后不再被任何人使用。
    assert.equal(closes.count, 1);
  });

  it("open 抛错时要抛给调用方（sink 会 warn 一句），不能吞成 null", async () => {
    // 吞掉的话，「后端坏了」与「从没写过」在页面上长得一模一样。
    const { facility } = facilityOf({ openError: new Error("backend offline") });
    await assert.rejects(async () => loadLegacyAccumulator(hostOf(facility)), /backend offline/u);
  });

  it("读表抛错时也把名字还回去（finally），并且照样抛给调用方", async () => {
    const { closes, facility } = facilityOf({ readError: new Error("table corrupt") });
    await assert.rejects(async () => loadLegacyAccumulator(hostOf(facility)), /table corrupt/u);
    // 少了这道 finally，下一次装配会撞一条与真实故障无关的 `already-open`。
    assert.equal(closes.count, 1);
  });
});
