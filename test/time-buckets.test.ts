// lib/time-buckets.ts 单测：统计窗口与横轴刻度都按**本地**时间折桶。
//
// 关键事实：rtk 账本里的时间戳是 UTC（`to_rfc3339`），而用户问的是「今天省了多少」。
// 折桶必须在本地时区做，否则跨零点的数据会被分到两天，而界面上没有任何线索能解释。
// 期望值以 2026-11-15（周一为 9 号、周日为 15 号）为锚，逐条独立写明。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { localDayKey, localWeekKey, localMonthKey, windowStartDay } from "../lib/time-buckets.ts";

/** 2026-11-15 12:00 本地时间。 */
const ANCHOR = new Date(2026, 10, 15, 12).getTime();
/** 锚点那天的 00:00:00.000 与 23:59:59.999（同一本地日的两端）。 */
const DAY_FIRST_MS = new Date(2026, 10, 15, 0, 0, 0, 0).getTime();
const DAY_LAST_MS = new Date(2026, 10, 15, 23, 59, 59, 999).getTime();
/** 同一周的周一与周日（2026-11-09 / 2026-11-15）。 */
const WEEK_MONDAY = "2026-11-09";
const WEEK_SUNDAY = "2026-11-15";
/** 下一周的周一（2026-11-16）。 */
const NEXT_MONDAY = "2026-11-16";

describe("localDayKey", () => {
  it("本地日期补零成 YYYY-MM-DD", () => {
    assert.equal(localDayKey(ANCHOR), WEEK_SUNDAY);
    assert.equal(localDayKey(new Date(2026, 0, 5, 0).getTime()), "2026-01-05");
  });

  it("当天 00:00 与 23:59 是同一天", () => {
    assert.equal(localDayKey(DAY_FIRST_MS), WEEK_SUNDAY);
    assert.equal(localDayKey(DAY_LAST_MS), WEEK_SUNDAY);
  });
});

describe("localWeekKey", () => {
  it("周一为首，周日归到前一个周一", () => {
    assert.equal(localWeekKey(WEEK_SUNDAY), WEEK_MONDAY);
    assert.equal(localWeekKey(NEXT_MONDAY), NEXT_MONDAY);
    assert.equal(localWeekKey("2026-11-22"), NEXT_MONDAY);
  });

  it("跨月时给出上月最后一周的周一", () => {
    assert.equal(localWeekKey("2026-12-01"), "2026-11-30");
  });
});
describe("localMonthKey", () => {
  it("取前七位", () => {
    assert.equal(localMonthKey(WEEK_SUNDAY), "2026-11");
  });
});

describe("windowStartDay", () => {
  it("含今天，所以回退 rangeDays-1 天", () => {
    assert.equal(windowStartDay(7, ANCHOR), WEEK_MONDAY);
    assert.equal(windowStartDay(30, ANCHOR), "2026-10-17");
    assert.equal(windowStartDay(90, ANCHOR), "2026-08-18");
  });

  it("今天当天算窗口第一天", () => {
    assert.equal(windowStartDay(7, DAY_FIRST_MS + 1), WEEK_MONDAY);
    assert.equal(windowStartDay(7, DAY_LAST_MS), WEEK_MONDAY);
  });
});
