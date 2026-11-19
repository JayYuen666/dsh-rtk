// lib/insights-page-logic.ts 单测：页面状态、请求形状、图上放什么、表格怎么格式化。
//
// 这一层是 DOM-free 的（只有 import type 与 lib 内的纯函数），所以可以在这里把「切页签会不会
// 重置窗口」「稀疏时退不退回柱状」「分母为 0 时显示 0% 还是空」这些事逐条钉住，而不需要渲染。
//
// 期望值一律自己写死，不从实现里那几张常量表派生：从被测的表推期望，两边一起错就一起绿。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import type {
  Availability,
  FormToday,
  LastEvent,
  SeriesPoint,
  Suggestion,
  Totals,
} from "../lib/insights-shape.ts";
import { localDayKey } from "../lib/time-buckets.ts";
import {
  GRANULARITIES,
  INITIAL_STATE,
  PANEL_ID,
  PANEL_ORDER,
  RANGE_DAYS,
  availabilityKeyOf,
  cardKpiRowsOf,
  cellsOf,
  chartLabelsOf,
  chartModeOf,
  dataStartOf,
  granularityKeyOf,
  hasLatencyOf,
  isEmptyWindow,
  kpiRowsOf,
  lastEventLineOf,
  latencyLabelKeyOf,
  latencyLineOf,
  rangeKeyOf,
  recentTitleKeyOf,
  requestOf,
  rtkSelfLinesOf,
  savedValuesOf,
  savingsValuesOf,
  suggestionLineOf,
  suggestionLinesOf,
  withForm,
  withGranularity,
  withRange,
} from "../lib/insights-page-logic.ts";

const TODAY = "2026-11-15";
const YESTERDAY = "2026-11-14";
const CARGO = "cargo test";
/** 反复出现的过滤器名（`sonarjs(no-duplicate-string)` 数到三次就红）。 */
const CARGO_FILTER = "cargo-test";
/** rtk 账本里 `MIN(timestamp)` 的形状：RFC3339 UTC，带时分秒与 `Z`（不是单纯的日期）。 */
const LEDGER_START = "2026-10-27T04:00:00.000Z";

/** 一天的序列点：只填这一条用例关心的那几个数，其余给 0。 */
function point(key: string, savedTokens: number, savingsPct: number): SeriesPoint {
  return {
    key,
    commands: 10,
    bashCalls: 10,
    attempts: 4,
    compressed: 3,
    originalTokens: 1000,
    compressedTokens: 1000 - savedTokens,
    savedTokens,
    savingsPct,
    coveragePct: 30,
  };
}

/** 六项总量：每一项都能一眼认出是哪一个（值互不相同），顺序错了就对不上。 */
const TOTALS: Totals = {
  bashCalls: 120,
  attempts: 40,
  compressed: 12,
  originalTokens: 5000,
  compressedTokens: 1000,
  savedTokens: 4000,
  savingsPct: 80,
  coveragePct: 10,
  successPct: 30,
  latencyAvgMs: 12,
  latencyMaxMs: 340,
};

const OK_AVAILABILITY: Availability = { prefix: "ok", pipe: "ok", reasons: [] };

/** 一条事件：只改这一个字段时用 `{...}` 覆盖。 */
const EVENT: LastEvent = {
  ts: 1,
  form: "pipe",
  status: "compressed",
  reason: "success",
  commandFamily: CARGO,
  filter: CARGO_FILTER,
  workdir: "/repo",
  sizeBucket: "small",
};

describe("页面状态", () => {
  it("首屏是改写形态 + 7 天 + 按日，且请求逐字搬这三位", () => {
    assert.deepEqual(INITIAL_STATE, { form: "prefix", rangeDays: 7, granularity: "day" });
    assert.deepEqual(requestOf(INITIAL_STATE), {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
  });

  it("切换任一位只动那一位（切页签不重置时间轴）", () => {
    const wide = withRange(withGranularity(INITIAL_STATE, "week"), 30);
    assert.deepEqual(requestOf(wide), { form: "prefix", rangeDays: 30, granularity: "week" });
    // 换形态：窗口与粒度都留在原地——切页签时把它们重置，会让人以为数据没了。
    assert.deepEqual(requestOf(withForm(wide, "pipe")), {
      form: "pipe",
      rangeDays: 30,
      granularity: "week",
    });
  });

  it("三档窗口与三种粒度的取值就是 schema 里那几条", () => {
    assert.deepEqual([...RANGE_DAYS], [7, 30, 90]);
    assert.deepEqual([...GRANULARITIES], ["day", "week", "month"]);
  });

  it("侧栏与 main 面板共用一个 id，位次是一个正数", () => {
    assert.equal(PANEL_ID, "rtk");
    assert.equal(PANEL_ORDER, 20);
  });
});

describe("窗口与粒度的文案键", () => {
  it("三档窗口各有一个键（不共用一个「近 N 天」）", () => {
    assert.deepEqual(
      RANGE_DAYS.map((days) => rangeKeyOf(days)),
      ["range7", "range30", "range90"],
    );
  });

  it("三种粒度各有一个键", () => {
    assert.deepEqual(
      GRANULARITIES.map((granularity) => granularityKeyOf(granularity)),
      ["granularityDay", "granularityWeek", "granularityMonth"],
    );
  });
});

describe("图的形态与取数", () => {
  it("有节省的天少于 3 天就退回柱状（含 0 天）", () => {
    assert.equal(chartModeOf([]), "bars");
    assert.equal(chartModeOf([point(TODAY, 500, 50)]), "bars");
    assert.equal(chartModeOf([point(TODAY, 500, 50), point(YESTERDAY, 0, 0)]), "bars");
  });

  it("满 3 天有节省才画组合图", () => {
    assert.equal(
      chartModeOf([point("2026-11-13", 10, 1), point(YESTERDAY, 20, 2), point(TODAY, 30, 3)]),
      "combo",
    );
  });

  it("柱取节省 token、折线取节省率，横轴按粒度折成短标签", () => {
    const series = [point(YESTERDAY, 700, 70), point(TODAY, 300, 30)];
    assert.deepEqual([...savedValuesOf(series)], [700, 300]);
    assert.deepEqual([...savingsValuesOf(series)], [70, 30]);
    // 日 / 周只给 `MM-DD`，月给 `YYYY-MM`——一个季度内年份不变，写全会两两重叠。
    assert.deepEqual([...chartLabelsOf(series, "day")], ["11-14", "11-15"]);
    assert.deepEqual([...chartLabelsOf(series, "week")], ["11-14", "11-15"]);
    assert.deepEqual([...chartLabelsOf(series, "month")], [YESTERDAY, TODAY]);
  });

  it("卡片那格的百分比与量条同口径：负数印 0%，不与量条各说一套", () => {
    const rows = cardKpiRowsOf({
      prefix: {
        ...TOTALS,
        commands: 3,
        savedTokens: 0,
        savingsPct: -12,
        attempts: 3,
      },
      pipe: {
        ...TOTALS,
        commands: 0,
        savedTokens: 0,
        savingsPct: 0,
        attempts: 0,
      },
    });
    const [prefix] = rows;
    assert.ok(prefix !== undefined);
    assert.equal(prefix.savings, "0%");
    assert.equal(prefix.meterPct, 0);
  });
});

describe("kpi 行", () => {
  it("六项顺序固定，值是格式化后的串（组件不再判单位）", () => {
    const rows = kpiRowsOf(TOTALS, "pipe");
    assert.deepEqual(
      rows.map((row) => row.key),
      ["bashCalls", "attempts", "succeeded", "coverage", "saved", "savings"],
    );
    // 4000 走短写 → `4.0k`；百分比整数不带小数点。这两条都是显示口径，不是数据口径。
    assert.deepEqual(
      rows.map((row) => row.value),
      ["120", "40", "12", "10%", "4.0k", "80%"],
    );
  });

  it("只有前三格带整数原值：动画目标值不能从短写反解析", () => {
    const rows = kpiRowsOf(TOTALS, "pipe");
    // 前三格是次数（可数整数），组件拿 `count` 做数字滚动；
    // 后三格是百分比与短写 token，反解析 `4.0k` 回来只是近似，不给 `count`。
    assert.deepEqual(
      rows.map((row) => row.count),
      [120, 40, 12, undefined, undefined, undefined],
    );
    // 两项必须能对上：`count` 是动画的落点，`value` 是落定之后要显示的文本。
    assert.equal(String(rows[0]?.count), rows[0]?.value);
    assert.equal(String(rows[1]?.count), rows[1]?.value);
    assert.equal(String(rows[2]?.count), rows[2]?.value);
  });

  it("中间三格的文案按形态换词：改写说尝试/改写成功，压缩说命中/压缩成功", () => {
    const prefix = kpiRowsOf(TOTALS, "prefix");
    const pipe = kpiRowsOf(TOTALS, "pipe");
    assert.deepEqual(
      prefix.map((row) => row.labelKey),
      [
        "kpiBashCalls",
        "kpiAttemptsPrefix",
        "kpiSucceededPrefix",
        "kpiCoveragePrefix",
        "kpiSaved",
        "kpiSavings",
      ],
    );
    assert.deepEqual(
      pipe.map((row) => row.labelKey),
      [
        "kpiBashCalls",
        "kpiAttemptsPipe",
        "kpiSucceededPipe",
        "kpiCoveragePipe",
        "kpiSaved",
        "kpiSavings",
      ],
    );
    // 首末两格两种形态同一个指标，不许跟着改词。
    assert.equal(prefix[0]?.labelKey, pipe[0]?.labelKey);
    assert.equal(prefix[5]?.labelKey, pipe[5]?.labelKey);
  });

  it("延迟：改写只报平均，压缩报平均 / 最大", () => {
    assert.equal(latencyLineOf(TOTALS, "prefix"), "12 ms");
    assert.equal(latencyLineOf(TOTALS, "pipe"), "12 ms / 340 ms");
    assert.equal(latencyLabelKeyOf("prefix"), "latencyLabelPrefix");
    assert.equal(latencyLabelKeyOf("pipe"), "latencyLabelPipe");
  });

  it("没有延迟样本时整行不画：0 ms 会被读成「很快」，而它其实是「没量到」", () => {
    // 三种成因分开钉，它们都会让 `formatDuration` 给出 `0 ms`：
    //   ① 一次都没尝试过（attempts=0）；
    //   ② 试过但这一路不计时（pipe 的跳过事件不带 latency，两个延迟都是 0）；
    //   ③ 均值那格是 0 而峰值有值 —— 这仍然算量到了，不能连峰值一起吞掉。
    assert.equal(hasLatencyOf({ ...TOTALS, attempts: 0 }), false);
    assert.equal(hasLatencyOf({ ...TOTALS, attempts: 5, latencyAvgMs: 0, latencyMaxMs: 0 }), false);
    assert.equal(hasLatencyOf({ ...TOTALS, latencyAvgMs: 0 }), true);
    assert.equal(hasLatencyOf(TOTALS), true);
  });
});

/** 一形态的今日读数：只填这条用例关心的数，其余给一个不会撞上被测字段的值。 */
function today(commands: number, savedTokens: number, savingsPct: number): FormToday {
  return { commands, savedTokens, savingsPct, compressed: 0, attempts: 0, coveragePct: 0 };
}

describe("设置卡的两格今日摘要", () => {
  it("顺序固定改写在前、压缩在后，不按启用形态过滤", () => {
    // 理由写在实现里：这两格报的是**记录**而不是**配置**。按 `enabledForms` 过滤的话，
    // 用户关掉压缩那一格就消失，看起来像「压缩没记过账」，其实只是没开。
    const rows = cardKpiRowsOf({ prefix: today(3, 100, 12.5), pipe: today(4, 200, 50) });
    assert.deepEqual(
      rows.map((row) => row.key),
      ["prefix", "pipe"],
    );
    assert.deepEqual(
      rows.map((row) => row.labelKey),
      ["todayPrefix", "todayPipe"],
    );
  });

  it("次数按个位写、token 走短写、百分比最多一位小数", () => {
    const rows = cardKpiRowsOf({ prefix: today(1500, 15_182, 61.76), pipe: today(6, 9341, 77.07) });
    // 1500 次不能折成 `1.5k`：次数是可数的，折了就没法跟「今天跑了几条」对上。
    assert.deepEqual(
      rows.map((row) => row.commands),
      ["1500", "6"],
    );
    assert.deepEqual(
      rows.map((row) => row.saved),
      ["15.2k", "9.3k"],
    );
    assert.deepEqual(
      rows.map((row) => row.savings),
      ["61.8%", "77.1%"],
    );
  });

  it("量条百分比取整并夹在 0~100（脏数据不把条推出格子）", () => {
    const rows = cardKpiRowsOf({ prefix: today(1, 1, 61.76), pipe: today(1, 1, 0) });
    assert.equal(rows[0]?.meterPct, 62);
    assert.equal(rows[1]?.meterPct, 0);
    // 账本里 `savings_pct` 是可正可负的比率，负数与超 100 都得夹住。
    const dirty = cardKpiRowsOf({ prefix: today(1, 1, -12.4), pipe: today(1, 1, 180) });
    assert.equal(dirty[0]?.meterPct, 0);
    assert.equal(dirty[1]?.meterPct, 100);
  });

  it("今天这条形态没被用过时判 idle，不印三个 0", () => {
    // 真机反馈原话「没有的就不要显示避免误导」：0 会被读成「跑了但一分钱没省」。
    const rows = cardKpiRowsOf({ prefix: today(0, 0, 0), pipe: today(0, 0, 0) });
    assert.deepEqual(
      rows.map((row) => row.idle),
      [true, true],
    );
  });

  it("有次数就没省下也照常报数：那是「跑了但没省」，与没跑过是两件事", () => {
    const rows = cardKpiRowsOf({ prefix: today(0, 0, 0), pipe: today(5, 0, 0) });
    assert.deepEqual(
      rows.map((row) => row.idle),
      [true, false],
    );
  });

  it("省下但次数为 0 也算有记录（账本可能只补了 token 那一格）", () => {
    const rows = cardKpiRowsOf({ prefix: today(0, 700, 40), pipe: today(0, 0, 0) });
    assert.deepEqual(
      rows.map((row) => row.idle),
      [false, true],
    );
  });
});

describe("可用性与数据起始", () => {
  it("两形态都 ok 才不提示", () => {
    assert.equal(availabilityKeyOf(OK_AVAILABILITY), "ok");
    assert.equal(availabilityKeyOf({ ...OK_AVAILABILITY, pipe: "unavailable" }), "unavailable");
    assert.equal(availabilityKeyOf({ ...OK_AVAILABILITY, prefix: "readonly" }), "unavailable");
  });

  it("空库的起始日给空串（组件据此显示「还没有数据」）", () => {
    assert.equal(dataStartOf({ dataStart: null }), "");
    assert.equal(dataStartOf({ dataStart: TODAY }), TODAY);
  });

  it("rtk 账本给的 RFC3339 时间折成本地日，页面上不出现时分秒", () => {
    // 两支来源不同：pipe 侧本来就是 `YYYY-MM-DD`，prefix 侧是 `MIN(timestamp)` 的原样值。
    // 期望值不写死具体哪天——`localDayKey` 的时区就是跑测试这台机器的时区，写死日期等于
    // 把断言绑到 CI 的时区上；这里只钉「形状」与「不原样透出时间戳」两条。
    const folded = dataStartOf({ dataStart: LEDGER_START });
    assert.match(folded, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(!folded.includes("T"));
    assert.equal(localDayKey(Date.parse(LEDGER_START)), folded);
  });

  it("解析不了的值原样透出，不吞成空白", () => {
    assert.equal(dataStartOf({ dataStart: "not-a-date" }), "not-a-date");
  });
});

/** 页脚对账用例的最小回执：只带形态、可用性与那三个数。
 *
 *  放在模块作用域（而不是 describe 里）：写进 describe 会被
 *  `unicorn(consistent-function-scoping)` 要求提出去——它没捕获任何外层变量。 */
function selfOf(
  form: "prefix" | "pipe",
  rtkSelf: {
    readonly parseFailures: number;
    readonly recovered: number;
    readonly oversized: number;
    readonly recallEntries?: number;
    readonly recallBytes?: number;
  },
  prefix: Availability["prefix"] = "ok",
): {
  form: "prefix" | "pipe";
  availability: Availability;
  rtkSelf: {
    readonly parseFailures: number;
    readonly recovered: number;
    readonly oversized: number;
    readonly recallEntries: number;
    readonly recallBytes: number;
  };
} {
  return {
    form,
    availability: { ...OK_AVAILABILITY, prefix },
    rtkSelf: { recallEntries: 0, recallBytes: 0, ...rtkSelf },
  };
}

describe("页脚的 rtk 自账对账", () => {
  it("改写形态：解析失败数与回收率按比值算，两条都出", () => {
    // 3 次里救回 2 次 → 66.7%；期望值写死，不从 `formatPct` 反推。
    const lines = rtkSelfLinesOf(
      selfOf("prefix", { parseFailures: 3, recovered: 2, oversized: 4 }),
    );
    assert.deepEqual(
      lines.map((line) => line.messageKey),
      ["rtkSelfFailures", "rtkSelfOversized"],
    );
    assert.deepEqual(lines[0]?.values, { failures: "3", recovered: "2", rate: "66.7%" });
    assert.deepEqual(lines[1]?.values, { oversized: "4" });
  });

  it("两个数都是 0 时一句话都不出（页脚不该被「0 次」撑长）", () => {
    assert.deepEqual(
      rtkSelfLinesOf(selfOf("prefix", { parseFailures: 0, recovered: 0, oversized: 0 })),
      [],
    );
  });

  it("只有超限行时只出那一条", () => {
    const lines = rtkSelfLinesOf(
      selfOf("prefix", { parseFailures: 0, recovered: 0, oversized: 7 }),
    );
    assert.deepEqual(
      lines.map((line) => line.messageKey),
      ["rtkSelfOversized"],
    );
  });

  it("压缩形态不问这两句：它的分子分母来自插件自己的表", () => {
    // 给非 0 的数也不许出——这一条正是「口径混起来」的守门人。
    assert.deepEqual(
      rtkSelfLinesOf(selfOf("pipe", { parseFailures: 3, recovered: 2, oversized: 4 })),
      [],
    );
  });

  it("账本不可用时不问：读不到不是「一次都没失败」", () => {
    assert.deepEqual(
      rtkSelfLinesOf(selfOf("prefix", { parseFailures: 3, recovered: 2, oversized: 4 }, "missing")),
      [],
    );
    assert.deepEqual(
      rtkSelfLinesOf(
        selfOf("prefix", { parseFailures: 3, recovered: 2, oversized: 4 }, "readonly"),
      ),
      [],
    );
  });

  it("recall 那条按条数与磁盘占用出，字节走 1024 进制", () => {
    // 期望串写死：`2048 B` 必须是 `2.0 KB` 而不是 `2 KB`——`formatBytes` 只在字节档不带小数，
    // 其余两档都保留一位，否则同一列里 `1 KB` 与 `1.5 KB` 对齐不了。
    const lines = rtkSelfLinesOf(
      selfOf("prefix", {
        parseFailures: 0,
        recovered: 0,
        oversized: 0,
        recallEntries: 12,
        recallBytes: 2048,
      }),
    );
    assert.deepEqual(
      lines.map((line) => line.messageKey),
      ["rtkSelfRecall"],
    );
    assert.deepEqual(lines[0]?.values, { entries: "12", size: "2.0 KB" });
  });

  it("recall 库里一条都没有时不提它（还没折过东西）", () => {
    // 与上面两条的判据不同：它不看窗口，所以「0 条」是「这个功能还没用过」而不是
    // 「这一屏没有」——页脚多一句「0 条」只会让人以为漏了配置。
    assert.deepEqual(
      rtkSelfLinesOf(
        selfOf("prefix", {
          parseFailures: 0,
          recovered: 0,
          oversized: 0,
          recallEntries: 0,
          recallBytes: 4096,
        }),
      ),
      [],
    );
  });

  it("三种信号同时存在时按失败、超限、recall 的次序排", () => {
    const lines = rtkSelfLinesOf(
      selfOf("prefix", {
        parseFailures: 1,
        recovered: 1,
        oversized: 2,
        recallEntries: 3,
        recallBytes: 1024,
      }),
    );
    assert.deepEqual(
      lines.map((line) => line.messageKey),
      ["rtkSelfFailures", "rtkSelfOversized", "rtkSelfRecall"],
    );
  });

  it("全部救回时回收率是 100%，不是空串", () => {
    // `formatPct` 对整数不补小数位（`100` → `100%`），所以这里写 `100%` 而不是 `100.0%`。
    const lines = rtkSelfLinesOf(
      selfOf("prefix", { parseFailures: 2, recovered: 2, oversized: 0 }),
    );
    assert.deepEqual(lines[0]?.values, { failures: "2", recovered: "2", rate: "100%" });
  });
});

/** 只取 status 键：四种结局各对应一条文案键。 */
function statusKeyOfEvent(status: LastEvent["status"]): string {
  return lastEventLineOf({ ...EVENT, status })?.status ?? "missing";
}

describe("最近一条事件", () => {
  it("四种结局各有自己的键", () => {
    assert.equal(statusKeyOfEvent("compressed"), "lastCompressed");
    assert.equal(statusKeyOfEvent("skipped"), "lastSkipped");
    assert.equal(statusKeyOfEvent("rewritten"), "lastRewritten");
    assert.equal(statusKeyOfEvent("failed"), "lastFailed");
  });

  it("null 表示窗口内一次都没有", () => {
    assert.equal(lastEventLineOf(null), undefined);
  });

  it("空家族兜成 unknown，其余字段原样带走", () => {
    assert.deepEqual(lastEventLineOf({ ...EVENT, commandFamily: "" }), {
      status: "lastCompressed",
      tone: "ok",
      family: "unknown",
      reason: "success",
      size: "small",
      templateKey: "whyLastPlain",
    });
  });

  it("成功那两支用短模板（reason 只是把 status 再说一遍），跳过与失败保留原因", () => {
    // 「已改写 · cargo test · rewritten · 输入 medium」里 status 与 reason 说的是同一件事，
    // 印出来像卡住了；跳过与失败的原因才真的带信息（too-small / guard:…）。
    assert.equal(lastEventLineOf({ ...EVENT, status: "compressed" })?.templateKey, "whyLastPlain");
    assert.equal(lastEventLineOf({ ...EVENT, status: "rewritten" })?.templateKey, "whyLastPlain");
    assert.equal(lastEventLineOf({ ...EVENT, status: "skipped" })?.templateKey, "whyLast");
    assert.equal(lastEventLineOf({ ...EVENT, status: "failed" })?.templateKey, "whyLast");
  });

  it("没量到字节时把「输入规模」整段省掉，不印成「输入 unknown」", () => {
    // 改写形态量的是指令本身，`dsh_last_events.size_bucket` 因此恒为 `unknown`。真机上
    // 「最近一次改写」那一行曾显示「已改写 · git status · 输入 unknown」——一个没见过这串
    // 字的人只会以为统计坏了。没量到就说没量到，占位词不算数。
    const unsized: LastEvent = { ...EVENT, sizeBucket: "unknown" };
    assert.equal(
      lastEventLineOf({ ...unsized, status: "rewritten" })?.templateKey,
      "whyLastPlainNoSize",
    );
    assert.equal(
      lastEventLineOf({ ...unsized, status: "compressed" })?.templateKey,
      "whyLastPlainNoSize",
    );
    assert.equal(lastEventLineOf({ ...unsized, status: "skipped" })?.templateKey, "whyLastNoSize");
    assert.equal(lastEventLineOf({ ...unsized, status: "failed" })?.templateKey, "whyLastNoSize");
  });

  it("结局带色调：成功绿、跳过黄、失败红（跳过不是失败，它代表策略在按规则工作）", () => {
    assert.equal(lastEventLineOf({ ...EVENT, status: "compressed" })?.tone, "ok");
    assert.equal(lastEventLineOf({ ...EVENT, status: "rewritten" })?.tone, "ok");
    assert.equal(lastEventLineOf({ ...EVENT, status: "skipped" })?.tone, "skip");
    assert.equal(lastEventLineOf({ ...EVENT, status: "failed" })?.tone, "fail");
  });

  it("标题按形态分：改写看「最近一次改写」，压缩看「最近一次压缩」", () => {
    assert.equal(recentTitleKeyOf("prefix"), "recentTitlePrefix");
    assert.equal(recentTitleKeyOf("pipe"), "recentTitlePipe");
  });
});

describe("建议", () => {
  // 建议只带参数（`params`），句子由界面的语言包拼——所以这两个夹具里没有中文。
  const WARN: Suggestion = {
    kind: "low-yield-filter",
    key: "filter:cargo-test",
    severity: "warn",
    params: { filter: CARGO_FILTER, days: 7, attempts: 6, compressed: 6, savingsPct: 12 },
  };
  const INFO: Suggestion = {
    kind: "potential-filter",
    key: "filter:git-status",
    severity: "info",
    params: { filter: "git-status", days: 30, matches: 5 },
  };

  it("severity 只影响样式（warn 才标红）", () => {
    assert.equal(suggestionLineOf(WARN).warn, true);
    assert.equal(suggestionLineOf(INFO).warn, false);
  });

  it("只把出现的参数带进模板：缺席的键不落成 undefined", () => {
    // 模板里 `{filter}` 缺值会印成字面量 `{filter}`，所以「缺席」必须真的缺席，
    // 而不是带一个 `undefined` 进占位符替换。
    assert.deepEqual(suggestionLineOf(INFO).values, {
      filter: "git-status",
      days: 30,
      matches: 5,
    });
    assert.deepEqual(suggestionLineOf(WARN).values, {
      filter: CARGO_FILTER,
      days: 7,
      attempts: 6,
      compressed: 6,
      savingsPct: "12%",
    });
  });

  it("按家族给的与什么都不给的，各自只带自己那几位", () => {
    // 模板里每个占位符都得有值，所以「没给」必须真的不带这一位——带 `undefined`
    // 进替换会印成字面量 `{family}`。
    assert.deepEqual(
      suggestionLineOf({
        kind: "low-yield-command",
        key: "family:cargo",
        severity: "warn",
        params: { family: CARGO, days: 7, attempts: 9, savingsPct: 5 },
      }).values,
      { family: CARGO, days: 7, attempts: 9, savingsPct: "5%" },
    );
    assert.deepEqual(
      suggestionLineOf({
        kind: "potential-filter",
        key: "filter:none",
        severity: "info",
        params: {},
      }).values,
      {},
    );
  });

  it("一组建议保持原顺序，不重排", () => {
    assert.deepEqual(
      suggestionLinesOf([INFO, WARN]).map((line) => line.key),
      [INFO.key, WARN.key],
    );
  });
});

describe("明细行的数值单元", () => {
  it("压缩形态四列都格式化，0 写 0 而不是空", () => {
    assert.deepEqual(
      cellsOf({ commands: 12, savedTokens: 4000, savingsPct: 80, coveragePct: 10 }, "pipe"),
      { commands: "12", saved: "4.0k", savings: "80%", coverage: "10%" },
    );
    assert.deepEqual(
      cellsOf({ commands: 0, savedTokens: 0, savingsPct: 0, coveragePct: 0 }, "pipe"),
      {
        commands: "0",
        saved: "0",
        savings: "0%",
        coverage: "0%",
      },
    );
  });

  it("次数按个位写，不折成 k（那是 token 量的写法）", () => {
    const cells = cellsOf(
      { commands: 1500, savedTokens: 1500, savingsPct: 50, coveragePct: 0 },
      "pipe",
    );
    assert.equal(cells.commands, "1500");
    assert.equal(cells.saved, "1.5k");
  });

  it("改写形态没有覆盖率这一列：给 undefined，而不是一个会被读成 0% 的值", () => {
    const cells = cellsOf(
      { commands: 12, savedTokens: 4000, savingsPct: 80, coveragePct: 0 },
      "prefix",
    );
    assert.equal(cells.coverage, undefined);
    assert.equal(cells.saved, "4.0k");
  });
});

describe("空窗口判据", () => {
  it("一次调用都没有才算空；只要有过调用就不是", () => {
    assert.equal(isEmptyWindow({ ...TOTALS, bashCalls: 0, attempts: 0, savedTokens: 0 }), true);
    // 有调用但没省下任何 token：不是空窗口，那是「一直在试但没收益」，必须照常显示。
    assert.equal(isEmptyWindow({ ...TOTALS, bashCalls: 3, attempts: 3, savedTokens: 0 }), false);
    assert.equal(isEmptyWindow(TOTALS), false);
  });
});
