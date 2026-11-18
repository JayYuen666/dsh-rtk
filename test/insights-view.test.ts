// 视图模型的纯函数用例：补桶、图坐标、格式化。
//
// 期望值全部**独立写死**（锚点 2026-11-15 12:00 本地），不从实现里的 `windowKeys` 派生：
// 桶范围如果照抄被测代码，实现把「周从周日开始」写错时用例会跟着一起错。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { SeriesPoint } from "../lib/insights-shape.ts";
import {
  bucketLabel,
  chartGeometry,
  formatDuration,
  formatPct,
  formatTokens,
  isSparse,
  zeroFillSeries,
} from "../lib/insights-view.ts";

/** 2026-11-15 12:00 本地（周日）。周桶因此落在 11-09，月桶落在 2026-11。 */
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime();
const TODAY = "2026-11-15";
const WEEK_MONDAY = "2026-11-09";
const DAY_TENTH = "2026-11-10";
const DAY_ELEVENTH = "2026-11-11";
const MONTH = "2026-11";

/** 一个有点的桶：只有 key 与几个数，其余按面上为零补齐。 */
function point(key: string, overrides: Partial<SeriesPoint> = {}): SeriesPoint {
  return {
    key,
    commands: 0,
    bashCalls: 0,
    attempts: 0,
    compressed: 0,
    originalTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    savingsPct: 0,
    coveragePct: 0,
    ...overrides,
  };
}

describe("zeroFillSeries：补桶", () => {
  it("空 series 补满 7 天，按日升序、全是零", () => {
    const filled = zeroFillSeries([], 7, "day", NOW);
    assert.deepEqual(
      filled.map((row) => row.key),
      [WEEK_MONDAY, DAY_TENTH, DAY_ELEVENTH, "2026-11-12", "2026-11-13", "2026-11-14", TODAY],
    );
    for (const row of filled) {
      assert.equal(row.savedTokens, 0);
      assert.equal(row.savingsPct, 0, "分母为零时给 0，不是 NaN");
    }
  });

  it("只有一天的数据也补满 30 天，且那天的数原样落位", () => {
    const filled = zeroFillSeries([point(TODAY, { savedTokens: 700 })], 30, "day", NOW);
    assert.equal(filled.length, 30);
    assert.equal(filled.at(0)?.key, "2026-10-17", "窗口起点 = 今天回退 29 天");
    const today = filled.find((row) => row.key === TODAY);
    assert.ok(today !== undefined);
    assert.equal(today.savedTokens, 700);
    assert.equal(filled.filter((row) => row.savedTokens > 0).length, 1);
  });

  it("周粒度把窗口聚成 5 个桶（30 天从 10-17 起，含 10-12 那一周）", () => {
    const filled = zeroFillSeries([], 30, "week", NOW);
    assert.deepEqual(
      filled.map((row) => row.key),
      ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", WEEK_MONDAY],
    );
  });

  it("月粒度把 90 天聚成 4 个桶", () => {
    const filled = zeroFillSeries([], 90, "month", NOW);
    assert.deepEqual(
      filled.map((row) => row.key),
      ["2026-08", "2026-09", "2026-10", MONTH],
    );
  });

  it("同一桶的多行相加，比率按分子分母重算（不是把百分比求平均）", () => {
    // 两天各自 savingsPct 100% 与 50%，但合起来的比率由 100/400 与 200/400 决定：
    // 加权后是 75%，直接对 100 与 50 求平均会得到 75 这个**偶然相同**的数，
    // 所以下面再给一组权重明显不均的：800/1000 与 200/8000。
    const filled = zeroFillSeries(
      [
        point(DAY_TENTH, {
          originalTokens: 1000,
          compressedTokens: 200,
          savedTokens: 800,
          savingsPct: 80,
          bashCalls: 4,
          compressed: 2,
        }),
        point(DAY_ELEVENTH, {
          originalTokens: 8000,
          compressedTokens: 7800,
          savedTokens: 200,
          savingsPct: 2.5,
          bashCalls: 8,
          compressed: 1,
        }),
      ],
      7,
      "week",
      NOW,
    );
    const week = filled.find((row) => row.key === WEEK_MONDAY);
    assert.ok(week !== undefined);
    assert.equal(week.savedTokens, 1000);
    assert.equal(week.originalTokens, 9000);
    assert.equal(week.savingsPct, 11.11, "1000/9000 四舍五入到两位小数");
    assert.equal(week.bashCalls, 12);
    assert.equal(week.compressed, 3);
    assert.equal(week.coveragePct, 25);
  });

  it("窗口外的行被丢掉（保留期比窗口长时不能多出柱子）", () => {
    const filled = zeroFillSeries(
      [point("2026-06-01", { savedTokens: 999 }), point(TODAY, { savedTokens: 10 })],
      7,
      "day",
      NOW,
    );
    assert.equal(filled.length, 7);
    assert.equal(
      filled.some((row) => row.savedTokens === 999),
      false,
    );
  });

  it("service 交回整天键、页面要周粒度时再归一次（跨版本不出现同周四根柱）", () => {
    const filled = zeroFillSeries(
      [
        point(WEEK_MONDAY, { savedTokens: 100 }),
        point(DAY_TENTH, { savedTokens: 200 }),
        point(DAY_ELEVENTH, { savedTokens: 300 }),
      ],
      7,
      "week",
      NOW,
    );
    assert.deepEqual(
      filled.map((row) => row.key),
      [WEEK_MONDAY],
      "7 天窗口只覆盖 11-09 那一周",
    );
    assert.equal(filled.at(0)?.savedTokens, 600);
  });

  it("给了数据起始日就只补到那一天所在的桶为止（更早的「没有数据」不画成 0）", () => {
    // 窗口从 10-17 起，而账本 10-28 才有第一条：10-17 那一周与 10-19 那一周都该消失。
    // 留着它们会让读者看到「两根 0 高度的柱 + 一条从 0% 起跳的折线」，也就是把
    // 「这段时间没有数据」读成「那段时间一次都没省下」。
    const filled = zeroFillSeries([], 30, "week", NOW, "2026-10-28");
    assert.deepEqual(
      filled.map((row) => row.key),
      ["2026-10-26", "2026-11-02", WEEK_MONDAY],
      "起始日 10-28 落在 10-26 那一周，更早的两周被裁掉",
    );
  });

  it("起始日正好是窗口起点时一个桶都不裁（日粒度一个不差）", () => {
    const filled = zeroFillSeries([], 7, "day", NOW, WEEK_MONDAY);
    assert.equal(filled.length, 7);
    assert.equal(filled.at(0)?.key, WEEK_MONDAY);
  });

  it("起始日比窗口还早时也不裁：窗口是用户选的，不该被数据反向撑长", () => {
    const filled = zeroFillSeries([], 7, "day", NOW, "2026-01-01");
    assert.equal(filled.length, 7);
  });

  it("起始日不是 YYYY-MM-DD 时当没给：截断的串不该悄悄把整段窗口裁没了", () => {
    const filled = zeroFillSeries([], 7, "day", NOW, "2026-10-28T04:00:00.000Z");
    assert.equal(filled.length, 7, "RFC3339 由调用方先折成本地日，这里只认日键");
  });
});

describe("chartGeometry：归一化坐标", () => {
  const three = [
    point("a", { savedTokens: 0, savingsPct: 0 }),
    point("b", { savedTokens: 500, savingsPct: 50 }),
    point("c", { savedTokens: 1000, savingsPct: 25 }),
  ];

  it("x 等距铺开、首尾贴边，y 相对本图峰值", () => {
    const geometry = chartGeometry(three);
    assert.equal(geometry.maxTokens, 1000);
    assert.equal(geometry.maxPct, 50);
    assert.deepEqual(
      geometry.points.map((entry) => entry.x),
      [0, 50, 100],
    );
    assert.deepEqual(
      geometry.points.map((entry) => entry.yTokens),
      [0, 50, 100],
    );
    // 百分比那条线用得到它自己的峰值：50 是最大，25 是它的一半。
    assert.deepEqual(
      geometry.points.map((entry) => entry.yPct),
      [0, 100, 50],
    );
    assert.deepEqual(
      geometry.points.map((entry) => entry.key),
      ["a", "b", "c"],
    );
  });

  it("只有一个点时 x 给 50（画正中间），否则 0/0 是 NaN", () => {
    const geometry = chartGeometry([point("only", { savedTokens: 7 })]);
    assert.deepEqual(
      geometry.points.map((entry) => entry.x),
      [50],
    );
    assert.equal(geometry.points[0]?.yTokens, 100, "单点就是峰值");
  });

  it("全零不除：坐标给 0，峰值也给 0（不是 NaN 也不是 1）", () => {
    const geometry = chartGeometry([point("a"), point("b")]);
    assert.equal(geometry.maxTokens, 0);
    assert.equal(geometry.maxPct, 0);
    for (const entry of geometry.points) {
      assert.equal(entry.yTokens, 0);
      assert.equal(entry.yPct, 0);
    }
  });

  it("空数组给空点集与零峰值", () => {
    assert.deepEqual(chartGeometry([]), { maxTokens: 0, maxPct: 0, points: [] });
  });
});

describe("isSparse：点数不足时不要画趋势", () => {
  it("有值的天数少于 3 就是稀疏（两天的数据连线只是在暗示趋势）", () => {
    assert.equal(isSparse([]), true);
    assert.equal(isSparse([point("a", { savedTokens: 1 })]), true);
    assert.equal(isSparse([point("a", { savedTokens: 1 }), point("b", { savedTokens: 2 })]), true);
  });

  it("有值的天数达到 3 就不算稀疏——补出来的零桶不参与计数", () => {
    const series = [
      point("a", { savedTokens: 1 }),
      point("b"),
      point("c", { savedTokens: 2 }),
      point("d"),
      point("e", { savedTokens: 3 }),
    ];
    assert.equal(isSparse(series), false);
  });
});

describe("格式化", () => {
  it("token 短写：千位 k、百万位 M，各留一位小数", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(1234), "1.2k");
    assert.equal(formatTokens(1_000_000), "1.0M");
    assert.equal(formatTokens(1_234_567), "1.2M");
  });

  it("百分比：整数不带 .0，非整数留一位", () => {
    assert.equal(formatPct(0), "0%");
    assert.equal(formatPct(75), "75%");
    assert.equal(formatPct(62.5), "62.5%");
    assert.equal(formatPct(33.333), "33.3%");
  });

  it("耗时：一秒以下按毫秒取整，以上按秒留一位", () => {
    assert.equal(formatDuration(0), "0 ms");
    assert.equal(formatDuration(12.4), "12 ms");
    assert.equal(formatDuration(999), "999 ms");
    assert.equal(formatDuration(1000), "1.0 s");
    assert.equal(formatDuration(2500), "2.5 s");
  });
});

describe("桶标签", () => {
  it("月粒度保留年份，日与周只给 MM-DD（轴上没有跨年跨度）", () => {
    assert.equal(bucketLabel(MONTH, "month"), MONTH);
    assert.equal(bucketLabel(TODAY, "day"), "11-15");
    assert.equal(bucketLabel(WEEK_MONDAY, "week"), "11-09");
  });
});
