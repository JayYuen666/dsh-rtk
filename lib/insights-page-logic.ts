// Insights 页的**纯逻辑**：状态怎么变、请求长什么样、图上放哪几个数。
//
// 这一层的存在理由和 `lib/card-logic.ts` 一样：把「能算对的」与「画出来的」分开，于是
// 切换页签、切窗口、判稀疏、格式化这些事可以脱离 React 断言，而组件里只剩挂载与事件。
// 这里不 import 任何 React，也不 import `src/` 下的东西（`lib/` 是宿主也会读的那一层）。
import type {
  Availability,
  FormToday,
  InsightsForm,
  InsightsRequest,
  LastEvent,
  SeriesPoint,
  StatsOverview,
  Suggestion,
  Totals,
} from "./insights-shape.ts";
import {
  bucketLabel,
  formatBytes,
  formatDuration,
  formatPct,
  formatTokens,
  isSparse,
} from "./insights-view.ts";
import { localDayKey } from "./time-buckets.ts";

/** `YYYY-MM-DD` 形态：pipe 侧本来就是日粒度，直接放行，不进 `Date.parse`。 */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

/** 左侧栏入口与 `main` 面板共用的 id。图标按同一个值对上，改一处必须两处一起改。 */
export const PANEL_ID = "rtk";
/** 侧栏里的位次：宿主已占 0/10，插件管理器 0，本页排 20。 */
export const PANEL_ORDER = 20;

/** 三个窗口与三种粒度：与 `InsightsRequestSchema` 的枚举逐字相同，类型也从这里推。 */
export const FORMS = ["prefix", "pipe"] as const;
export type FormOrder = (typeof FORMS)[number];
export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
export const GRANULARITIES = ["day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** 页面状态：一次请求的四个位（页面位置只由这四位决定）。 */
export interface ViewState {
  readonly form: InsightsForm;
  readonly rangeDays: RangeDays;
  readonly granularity: Granularity;
}

/** 首屏：改写形态 + 7 天 + 按日。选它是因为「昨天到今天」是新装用户唯一有数据的一段。 */
export const INITIAL_STATE: ViewState = { form: "prefix", rangeDays: 7, granularity: "day" };

/** 状态 → 请求。三个字段逐一搬过去，不夹带 UI 状态（`pending`/`stale` 不进线上）。 */
export function requestOf(state: ViewState): InsightsRequest {
  return { form: state.form, rangeDays: state.rangeDays, granularity: state.granularity };
}

/** 换形态。窗口与粒度保持不变：切换页签时把时间轴也重置，会让人以为数据没了。 */
export function withForm(state: ViewState, form: InsightsForm): ViewState {
  return { ...state, form };
}

/** 换窗口。粒度不动：7 天按月看是一个点，但那是用户自己选的组合，不该被悄悄改掉。 */
export function withRange(state: ViewState, rangeDays: RangeDays): ViewState {
  return { ...state, rangeDays };
}

/** 换粒度。 */
export function withGranularity(state: ViewState, granularity: Granularity): ViewState {
  return { ...state, granularity };
}

/** 图形态：稀疏（有节省的天少于 3 天）退回纯柱，不画假折线。 */
export type ChartMode = "bars" | "combo";

/** 判据只剩一件事：稀疏就退柱。空数据也走这条（0 天 < 3 天）。 */
export function chartModeOf(series: readonly SeriesPoint[]): ChartMode {
  return isSparse(series) ? "bars" : "combo";
}

/** 横轴标签：交给 `insights-view` 的桶名格式化，页面不自己切片。 */
export function chartLabelsOf(
  series: readonly SeriesPoint[],
  granularity: Granularity,
): readonly string[] {
  // 轴上写 `11-15` 而不是 `2026-11-15`：一个季度内年份不变，写全了会两两重叠。
  // 折法与 `bucketLabel` 同一处实现——两处各折一次，迟早有一处漏掉月度那支。
  return series.map((point) => bucketLabel(point.key, granularity));
}

/** 柱子：每一天（或每桶）省下的 token。 */
export function savedValuesOf(series: readonly SeriesPoint[]): readonly number[] {
  return series.map((point) => point.savedTokens);
}

/** 折线：节省率。稀疏时这张图不画，但它照样算出来给 tooltip 用。 */
export function savingsValuesOf(series: readonly SeriesPoint[]): readonly number[] {
  return series.map((point) => point.savingsPct);
}

/**
 * KPI 的文案键。
 *
 * 中间三项**按形态分叉**：改写形态的「尝试」是「问过 rtk 能不能改」，压缩形态的「尝试」是
 * 「命中了 filter」；两者的覆盖率分母也不同（前者除以 bash 调用，后者除以命中数分母仍是
 * bash 调用，但分子是压成的次数）。共用一句话会把两个不同的比率说成同一个指标。
 */
export type KpiLabelKey =
  | "kpiRewriteCount"
  | "kpiCompressedCount"
  | "kpiTrigger"
  | "kpiTriggerHint"
  | "kpiSaved"
  | "kpiSavings"
  | "kpiAverageLatency"
  | "kpiLatencyHintPrefix"
  | "kpiLatencyHintPipe"
  | "kpiSkipped"
  | "kpiSkippedHint";

/** 一格的涨跌标注：方向只决定着色，文案由调用方按粒度拼好（较前一日 ↑12%）。 */
export interface KpiDelta {
  readonly direction: "up" | "down";
  readonly text: string;
}
/** KPI 行的一项。`labelKey` 是文案键，`value` 已经格式化好——组件不再判单位。 */
export interface KpiRow {
  readonly key: string;
  readonly labelKey: KpiLabelKey;
  /** 数值下方的一行事实说明（设计稿的 `k-sub`）；与 `delta` 二选一。 */
  readonly subKey?: KpiLabelKey | undefined;
  readonly value: string;
  /** 单位后缀（`%` / `k` / `ms`）：设计稿里单位比数值小一档，单独交给 KpiTile。 */
  readonly unit?: string | undefined;
  /** 窗口内最后一个桶对前一个桶的涨跌（序列不足两桶/前置为 0/持平时缺省）。 */
  readonly delta?: KpiDelta;
  /**
   * 纯整数的原始值：只给前三格（次数类）填。
   *
   * 卡片那边用它播一次数字滚动（纯 CSS `@property` + `counter`，没有 JS 定时器）。
   * `value` 是对外文本，`count` 是动画的目标值——两个都留着而不是从 `value` 反解析：
   * `4.0k` 这种短写反解析回来是 4000，可 `1.5k` 是 1500 上下，反解析等于把近似当精确。
   */
  readonly count?: number;
}

/**
 * 把总量摊成 KPI 行。
 *
 * 分母为 0 时覆盖率给 `0%` 而不是 `—`：那是「一次都没试过」，不是「不知道」。六格两种形态
 * 一一对齐，唯中间三格的文案与语义按形态换（见 `KpiLabelKey`）。
 */
/** 把格式化串拆成「数值 + 小号单位」：设计稿 `.k-value small` 只给单位降一档。 */
type KpiCell = Pick<KpiRow, "value" | "unit">;
function kpiPctCell(raw: string): KpiCell {
  return { value: raw.slice(0, -1), unit: "%" };
}
function kpiTokenCell(raw: string): KpiCell {
  const unit = raw.at(-1);
  return unit === "k" || unit === "M" ? { value: raw.slice(0, -1), unit } : { value: raw };
}
function kpiDurationCell(raw: string): KpiCell {
  const [value = raw, unit] = raw.split(" ");
  return unit === undefined ? { value } : { value, unit };
}

/**
 * 洞察页 KPI 六格：改写/压缩次数、触发率、节省 token、节省率、平均耗时、跳过次数。
 * @param totals - 窗口内总量
 * @param form - prefix 或 pipe，只影响第一格的词与耗时说明
 * @returns 六项按设计稿顺序排列
 */
export function kpiRowsOf(totals: Totals, form: InsightsForm): readonly KpiRow[] {
  const prefix = form === "prefix";
  // 触发率 = 真正发出改写/命中 filter 的次数 / 全部 bash 调用。设计稿把「改写次数」
  // 与「触发率」分成两格：前者是成功数，后者是「有多少调用进入了这条链路」。
  const triggerPct = totals.bashCalls === 0 ? 0 : (totals.attempts / totals.bashCalls) * 100;
  return [
    {
      key: "rewrites",
      labelKey: prefix ? "kpiRewriteCount" : "kpiCompressedCount",
      value: String(totals.compressed),
      count: totals.compressed,
    },
    {
      key: "trigger",
      labelKey: "kpiTrigger",
      subKey: "kpiTriggerHint",
      ...kpiPctCell(formatPct(triggerPct)),
    },
    { key: "saved", labelKey: "kpiSaved", ...kpiTokenCell(formatTokens(totals.savedTokens)) },
    { key: "savings", labelKey: "kpiSavings", ...kpiPctCell(formatPct(totals.savingsPct)) },
    {
      key: "latency",
      labelKey: "kpiAverageLatency",
      subKey: prefix ? "kpiLatencyHintPrefix" : "kpiLatencyHintPipe",
      ...kpiDurationCell(
        totals.attempts > 0 && (totals.latencyAvgMs > 0 || totals.latencyMaxMs > 0)
          ? formatDuration(totals.latencyAvgMs)
          : "—",
      ),
    },
    {
      key: "skipped",
      labelKey: "kpiSkipped",
      subKey: "kpiSkippedHint",
      value: String(totals.skipped),
      count: totals.skipped,
    },
  ];
}

/**
 * 序列里最后两个桶的涨跌（pure，可脱离 React 断言）。
 *
 * 口径刻意是「最后一桶对前一桶」而不是「本窗对上窗」：回执里没有上一窗的数据，硬算就是编。
 * 前置桶为 0（分母不存在）与持平（涨跌无信息量）都不出标注——那两态显示 ↑0% 或 ∞% 会把
 * 「没有可比数据」读成结论。
 */
export function kpiDeltaOf(
  series: readonly {
    readonly bashCalls: number;
    readonly commands: number;
    readonly attempts: number;
    readonly compressed: number;
    readonly savedTokens: number;
  }[],
  field: "bashCalls" | "commands" | "attempts" | "compressed" | "savedTokens",
): KpiDelta | undefined {
  const lastPoint = series.at(-1);
  const prevPoint = series.at(-2);
  const last = lastPoint === undefined ? undefined : lastPoint[field];
  const prev = prevPoint === undefined ? undefined : prevPoint[field];
  // 前置桶为 0（分母不存在）、持平、或序列异常 → pct 归 0，最后统一落 undefined。
  const pct =
    last === undefined || prev === undefined || prev === 0 || last === prev
      ? 0
      : Math.round(((last - prev) / prev) * 100);
  // 三元而不是早退：`return undefined;` 语句在 `consistent-return` 与 `no-useless-undefined`
  // 两条规则之间没有合法形态，表达式一次过（lastEventLineOf 同款）。
  return last === undefined || prev === undefined || pct === 0
    ? undefined
    : {
        direction: last > prev ? "up" : "down",
        text: `${last > prev ? "↑" : "↓"}${String(Math.abs(pct))}%`,
      };
}

/** 粒度 → 涨跌标注的文案键（日/周/月各自对应「较前一日/周/月」）。 */
export function kpiDeltaLabelKeyOf(
  granularity: "day" | "week" | "month",
): "kpiDeltaDay" | "kpiDeltaWeek" | "kpiDeltaMonth" {
  if (granularity === "day") {
    return "kpiDeltaDay";
  }
  if (granularity === "week") {
    return "kpiDeltaWeek";
  }
  return "kpiDeltaMonth";
}

/**
 * 设置卡里一格形态摘要。
 *
 * 与洞察页的 `kpiRowsOf` 分开写而不是复用：那一份摊的是**窗口总量**（六格），这一份摊的是
 * **今日单形态**（三格）。硬把两者塞进一个函数，就得在里面判「这次是哪种上下文」，而它输出
 * 的格数、标签与是否显示空态全都跟着上下文变——那种函数的每个分支都要单独验一遍。
 *
 * `idle` 这一位是承重的：今天没动作时组件渲染一句「今天还没有记录」，而不是三格 0。三格 0
 * 会让读者以为「跑了命令但一分钱没省」，而事实是「今天这条形态没被用过」——这两件事在界面上
 * 必须长得不一样（真机反馈原话：「没有的就不要显示避免误导」）。
 */
export interface CardKpiRow {
  readonly key: InsightsForm;
  readonly labelKey: "todayPrefix" | "todayPipe";
  /** 今日这一形态被用上的次数（prefix 是改写成功数，pipe 是压缩成功数）。 */
  readonly commands: string;
  readonly saved: string;
  readonly savings: string;
  /** 节省率量条的宽度百分比（0~100 取整）。负数（rtk 允许 output > input）夹到 0。 */
  readonly meterPct: number;
  readonly idle: boolean;
}

/** 量条宽度：夹在 0~100 再取整——`width:61.79999%` 这种值会让浏览器画出半像素边。 */
/**
 * 把百分比夹进 `0..100`，**不四舍五入**。
 *
 * 量条要整数（`width` 的百分比），而旁边那格数字要一位小数——两处都夹同一个区间，
 * 但只有一处取整。共用一个「夹并取整」的函数会让 `61.8%` 变成 `62%`，那是把精度丢掉
 * 而不是把口径对齐。
 * @param savingsPct - 原始百分比（压缩后比原文还长时会是负数）
 * @returns 夹进 0..100 的值
 */
function clampPctOf(savingsPct: number): number {
  return Math.min(100, Math.max(0, savingsPct));
}

function meterPctOf(savingsPct: number): number {
  return Math.round(clampPctOf(savingsPct));
}

/**
 * 今日两形态摊成卡片 KPI，**顺序固定** prefix 在前。
 *
 * 不按「当前启用的形态」过滤：那是配置，而这里报的是记录。只开改写的人看到「结果压缩 ·
 * 还没有记录」是有用的信息（那一路确实没在用），而按配置过滤会让人以为滑块一动数字就变——
 * 实际上记录要等下一次工具调用才发生。
 */
export function cardKpiRowsOf(today: {
  readonly prefix: FormToday;
  readonly pipe: FormToday;
}): readonly CardKpiRow[] {
  const forms: readonly InsightsForm[] = FORMS;
  return forms.map((form) => {
    const value = form === "prefix" ? today.prefix : today.pipe;
    return {
      key: form,
      labelKey: form === "prefix" ? "todayPrefix" : "todayPipe",
      // 次数按个位写：与洞察页同一条理由，`formatTokens` 会把 1500 次折成 `1.5k`。
      commands: String(value.commands),
      saved: formatTokens(value.savedTokens),
      // 与量条同一口径：负数（压缩后反而变长）在这里印成 `0%`。量条本身已经夹到 0，
      // 而旁边那格数字还印 `-3%` 的话，同一行里两个数在说相反的事。
      savings: formatPct(clampPctOf(value.savingsPct)),
      meterPct: meterPctOf(value.savingsPct),
      // `attempts` 也要看：改写失败、压缩被护栏拦下时 `commands` 与 `savedTokens` 都是 0，
      // 但这一形态**确实动过**。只看前两位会把「今天试了 8 次都没成」显示成「今天还没有记录」。
      idle: value.commands === 0 && value.savedTokens === 0 && value.attempts === 0,
    };
  });
}

/**
 * 设置卡上的“清零统计”有没有东西可清。
 *
 * 今日两形态都是 `idle`、旧账本也不存在时，按下它只会走一趟确认弹窗再清一次空库。
 * 按钮该在那时禁用，让状态与卡片上的「今天还没有记录」一致；旧账本仍算数据——清零
 * 本来就会连迁移快照一起删掉，不能因为今天没动过就把它锁在库里。
 *
 * @param overview - 设置卡的今日概览
 * @returns 是否存在可清的数据
 */
export function overviewHasData(overview: StatsOverview): boolean {
  const { today, legacy } = overview;
  const todayHasData = cardKpiRowsOf(today).some((row) => !row.idle);
  return todayHasData || (legacy !== null && legacy.commands > 0);
}

/** 可用性文案：`ok` 时不占位，其余情况各有一句话（具体原因由 service 的 `message` 补）。 */
export type AvailabilityKey = "ok" | "unavailable";

/** 库与账本都可读 → 不提示；否则一句话。 */
export function availabilityKeyOf(availability: Availability): AvailabilityKey {
  return availability.prefix === "ok" && availability.pipe === "ok" ? "ok" : "unavailable";
}

/** 窗口的文案键：三档各一条，写出来才知道「7 天」不是「全部」。 */
export type RangeKey = "range7" | "range30" | "range90";

/** 窗口 → 文案键。三支穷举，新增一档时编译期就红。 */
export function rangeKeyOf(rangeDays: RangeDays): RangeKey {
  if (rangeDays === 7) {
    return "range7";
  }
  return rangeDays === 30 ? "range30" : "range90";
}

/** 粒度的文案键。 */
export type GranularityKey = "granularityDay" | "granularityWeek" | "granularityMonth";

/** 粒度 → 文案键。 */
export function granularityKeyOf(granularity: Granularity): GranularityKey {
  if (granularity === "day") {
    return "granularityDay";
  }
  return granularity === "week" ? "granularityWeek" : "granularityMonth";
}

/** 数据起始日那一行的值：`null`（空库）时给空串，由组件决定显示占位而不是「null」。
 *  两支的来源不同：pipe 侧给的是本插件自己的 `day`（`YYYY-MM-DD`），prefix 侧给的是
 *  rtk 账本里 `MIN(timestamp)` 的原样值（RFC3339 UTC，带时分秒与 `Z`）。后者照原样印出来
 *  是一串 `2026-10-27T04:00:00.000Z`，既难读、又和旁边的「按日」对不上——所以这里统一
 *  折成**本地日**。已经是日粒度的值原样返回，不走 `Date.parse`：`new Date("2026-10-27")`
 *  按 UTC 解析，在负时区会退到前一天。 */
export function dataStartOf(response: { readonly dataStart: string | null }): string {
  const raw = response.dataStart ?? "";
  if (raw === "" || DAY_KEY.test(raw)) {
    return raw;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? raw : localDayKey(parsed);
}

/** 页脚里一条「与 rtk 自己对账」的说明：文案键 + 参数，句子归字典。 */
export interface RtkSelfLine {
  readonly messageKey: "rtkSelfFailures" | "rtkSelfOversized" | "rtkSelfRecall" | "rtkSelfAgree";
  readonly values: Record<string, string>;
}

/**
 * 页脚的 rtk 自账对账行。
 *
 * 三条判据，每条都对应一个真实会误导读者的情形：
 *  - **只有 prefix 形态问**：另外两档的分子分母来自插件自己的表，而「`rtk gain` 排除超限行」
 *    说的是 `commands` 表，与那一屏无关。混在一起等于让两个口径互相解释。
 *  - **账本不可用时不问**：读不到账本时这几个位恒 0，印「解析失败 0 次」是把「没读到」说成
 *    「一次都没失败」——而这正是页脚要解释的那件事。
 *  - **0 不印**：页脚本来就在解释「为什么这一屏没有数」，再挂一句「0 次」只会把它撑长。
 * @param response - 一份回执（只要这几位：形态、账本可用性、rtk 自账三个数）
 * @returns 需要打印的那几条（可能为空）
 */
export function rtkSelfLinesOf(response: {
  readonly form: InsightsForm;
  readonly availability: Availability;
  readonly rtkSelf: {
    readonly parseFailures: number;
    readonly recovered: number;
    readonly oversized: number;
    readonly recallEntries: number;
    readonly recallBytes: number;
  };
}): RtkSelfLine[] {
  if (response.form !== "prefix" || response.availability.prefix !== "ok") {
    return [];
  }
  const { parseFailures, recovered, oversized, recallEntries, recallBytes } = response.rtkSelf;
  const lines: RtkSelfLine[] = [];
  if (parseFailures === 0 && oversized === 0) {
    lines.push({ messageKey: "rtkSelfAgree", values: {} });
  }
  if (parseFailures > 0) {
    lines.push({
      messageKey: "rtkSelfFailures",
      // 分母是失败数本身：0 次失败进不来这一支（上一行已经挡掉），不必再兜 0 除法。
      values: {
        failures: String(parseFailures),
        recovered: String(recovered),
        rate: formatPct((recovered / parseFailures) * 100),
      },
    });
  }
  if (oversized > 0) {
    lines.push({ messageKey: "rtkSelfOversized", values: { oversized: String(oversized) } });
  }
  // recall 那一条与上面两条的判据不同：它不看窗口（那个库由 rtk 整库淘汰），所以
  // `entries === 0` 才是「还没折过东西」，而不是「这一屏没有」。
  if (recallEntries > 0) {
    lines.push({
      messageKey: "rtkSelfRecall",
      values: { entries: String(recallEntries), size: formatBytes(recallBytes) },
    });
  }
  return lines;
}

/** 结局的语义色调：成功绿、跳过黄、失败红。用一个词而不是颜色值，是因为颜色写在 CSS 里
 *  （浅色主题要另一套），逻辑层只负责说「这是哪一种」。 */
export type LastEventTone = "ok" | "skip" | "fail";

/** 「最近一次」那一行。返回键 + 参数，组件负责套模板。 */
export interface LastEventLine {
  readonly status: LastEventStatusKey;
  readonly tone: LastEventTone;
  readonly family: string;
  readonly reason: string;
  /** 事件发生在哪一天：今天的写「今天」，昨天的写「昨天」，更早的写 `MM-DD`。 */
  readonly when: "today" | "yesterday" | "date";
  /** 本地 24 小时制 `HH:mm`。 */
  readonly clock: string;
  /** `when === "date"` 时用的日期文本（`MM-DD`）。 */
  readonly dateText: string;
  /** 量到的节省量/比率/耗时；没量到就不带，模板里那一整段也不会出现。 */
  readonly saved?: string;
  readonly pct?: string;
  readonly latency?: string;
  /** 用哪条模板。两个维度各去掉一段，于是有四条：
   *
   *  - `reason`：改写成功与压缩成功这两支的 reason 只是 `rewritten` / `success`，和左边的
   *    status 说的是同一件事——印出来就是「已改写 · cargo test · rewritten · 输入 medium」。
   *  - `size`：改写形态量的是指令本身，没有「输入多少字节」这回事，落库就是 `unknown`。
   *    把它照模板印出来是「输入 unknown」——一个没见过这串字的人只会以为统计坏了。
   *    没量到就整段不印，不要用一个占位词伪装成量到的值。 */
  readonly templateKey:
    | "whyLast"
    | "whyLastLatency"
    | "whyLastReasonLatency"
    | "whyLastPlain"
    | "whyLastSaved"
    | "whyLastSavedLatency";
}

/** 最近一条事件的结局文案键。 */
export type LastEventStatusKey = "lastCompressed" | "lastSkipped" | "lastRewritten" | "lastFailed";

/** 结局 → 文案键。四支穷举，不设默认支（新增结局时编译期就会红）。 */
function statusKeyOf(status: LastEvent["status"]): LastEventStatusKey {
  if (status === "compressed") {
    return "lastCompressed";
  }
  if (status === "skipped") {
    return "lastSkipped";
  }
  return status === "rewritten" ? "lastRewritten" : "lastFailed";
}

/** 结局 → 色调。跳过是「本来可以不跳」的黄，不是失败的红：它代表策略在按规则工作。 */
function toneOf(status: LastEvent["status"]): LastEventTone {
  if (status === "compressed" || status === "rewritten") {
    return "ok";
  }
  return status === "skipped" ? "skip" : "fail";
}

/** 模板选择只看两件事：这条结局需不需要 reason，以及这次有没有量到节省量与耗时。 */
function templateKeyOf(props: {
  readonly plain: boolean;
  readonly saved: boolean;
  readonly latency: boolean;
}): LastEventLine["templateKey"] {
  if (!props.plain) {
    return props.latency ? "whyLastReasonLatency" : "whyLast";
  }
  if (props.saved) {
    return props.latency ? "whyLastSavedLatency" : "whyLastSaved";
  }
  return props.latency ? "whyLastLatency" : "whyLastPlain";
}

/** `HH:mm`：固定 24 小时制，不跟系统 locale 走（en 宿主上也不该出现 `2:02 PM`）。 */
function clockOf(ts: number): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** 事件与「现在」是不是同一个本地日。跨日边界按本地日算，不用毫秒差（夏令时那天会差一小时）。 */
function whenOf(ts: number, now: number): LastEventLine["when"] {
  const day = localDayKey(ts);
  if (day === localDayKey(now)) {
    return "today";
  }
  return day === localDayKey(now - 86_400_000) ? "yesterday" : "date";
}

/** 非空事件的投影；`lastEventLineOf` 只在这一支里做字段判断。 */
function lastEventLineOfEvent(event: LastEvent, now: number): LastEventLine {
  // 0 与缺省都算「没量到」：0 token 不是一条能让人做决定的读数，印出来只会挤掉真正有用的耗时。
  const saved =
    event.savedTokens !== undefined && event.savedTokens > 0
      ? formatTokens(event.savedTokens)
      : undefined;
  const pct =
    saved !== undefined && event.savingsPct !== undefined ? formatPct(event.savingsPct) : undefined;
  const latency =
    event.latencyMs !== undefined && event.latencyMs > 0
      ? formatDuration(event.latencyMs)
      : undefined;
  const plain = event.status === "compressed" || event.status === "rewritten";
  const day = localDayKey(event.ts);
  return {
    status: statusKeyOf(event.status),
    tone: toneOf(event.status),
    // 空家族/空目录落「unknown」由 service 保证过，这里只兜空串。
    family: event.commandFamily === "" ? "unknown" : event.commandFamily,
    reason: event.reason,
    when: whenOf(event.ts, now),
    clock: clockOf(event.ts),
    dateText: day.slice(5),
    ...(saved === undefined ? {} : { saved }),
    ...(pct === undefined ? {} : { pct }),
    ...(latency === undefined ? {} : { latency }),
    templateKey: templateKeyOf({
      plain,
      saved: saved !== undefined,
      latency: latency !== undefined,
    }),
  };
}

/** 最近一条：`null` 表示窗口内一次都没有（组件显示 `whyNone`）。 */
export function lastEventLineOf(
  event: LastEvent | null,
  now: number = Date.now(),
): LastEventLine | undefined {
  return event === null ? undefined : lastEventLineOfEvent(event, now);
}

/** 「最近一次」那一块的标题键：两种形态问的不是同一个问题。
 *  改写形态看的是「上一次改写是怎么落的」，压缩形态看的是「上一次为什么没压」。 */
export function recentTitleKeyOf(form: InsightsForm): "recentTitlePrefix" | "recentTitlePipe" {
  return form === "prefix" ? "recentTitlePrefix" : "recentTitlePipe";
}

/**
 * 建议区的一行：`messageKey` 是要翻译的模板，`values` 是它的参数。
 *
 * **这里不产出句子**：service 只给参数（`Suggestion.params`），模板与界面语言都在客户端。
 * 第一版 service 直接拼中文，en 宿主切到建议区就是一整块中文——而它连回退的余地都没有。
 */
export interface SuggestionLine {
  readonly key: string;
  readonly messageKey:
    | "suggestLowYieldFilter"
    | "suggestUnusedFilter"
    | "suggestPotentialFilter"
    | "suggestLowYieldCommand";
  readonly values: {
    readonly filter?: string;
    readonly family?: string;
    readonly days?: number;
    readonly attempts?: number;
    readonly compressed?: number;
    readonly matches?: number;
    readonly savingsPct?: string;
  };
  /**
   * 三档语气，不是「警告/非警告」两档：
   * `warn` 是低收益到接近白改，`info` 是普通可优化项，`muted` 是「启用了但没命中」这种
   * 没有代价、无需动作的观察。三档共用同一行版式，颜色只落在左边线和图标上。
   */
  readonly tone: "info" | "warn" | "muted";
}

/** `params` → 模板参数。百分比先格式化成两位小数：模板里不该出现浮点原始值。 */
function valuesOf(params: Suggestion["params"]): SuggestionLine["values"] {
  return {
    ...(params.filter === undefined ? {} : { filter: params.filter }),
    ...(params.family === undefined ? {} : { family: params.family }),
    ...(params.days === undefined ? {} : { days: params.days }),
    ...(params.attempts === undefined ? {} : { attempts: params.attempts }),
    ...(params.compressed === undefined ? {} : { compressed: params.compressed }),
    ...(params.matches === undefined ? {} : { matches: params.matches }),
    ...(params.savingsPct === undefined ? {} : { savingsPct: formatPct(params.savingsPct) }),
  };
}

const SUGGESTION_KEYS: Readonly<Record<Suggestion["kind"], SuggestionLine["messageKey"]>> = {
  "low-yield-filter": "suggestLowYieldFilter",
  "unused-filter": "suggestUnusedFilter",
  "potential-filter": "suggestPotentialFilter",
  "low-yield-command": "suggestLowYieldCommand",
};

/** 建议 → 行。`severity` 只影响语气色，文案里不重复「警告」二字。 */
export function suggestionLineOf(suggestion: Suggestion): SuggestionLine {
  let tone: SuggestionLine["tone"] = "info";
  if (suggestion.kind === "unused-filter") {
    tone = "muted";
  } else if (suggestion.severity === "warn") {
    tone = "warn";
  }
  return {
    key: suggestion.key,
    messageKey: SUGGESTION_KEYS[suggestion.kind],
    values: valuesOf(suggestion.params),
    tone,
  };
}

/** 一组建议 → 行，保持 service 给的顺序（它已经按严重度排过）。 */
export function suggestionLinesOf(suggestions: readonly Suggestion[]): readonly SuggestionLine[] {
  return suggestions.map((suggestion) => suggestionLineOf(suggestion));
}

/**
 * 延迟：平均，压缩形态再加最大。
 *
 * 改写形态只报平均：日表只留 `latency_ms_sum` 与 `latency_count`，服务端把 `latencyMaxMs`
 * 恒置 0（见 `prefixTotalsOf`）。写出来就是「平均 42 ms / 最大 0 ms」——那个 0 不是「很快」，
 * 是「没量」。宁可少一格，不报一个会被读成极限值的假数。
 */
export function latencyLineOf(totals: Totals, form: InsightsForm): string {
  return form === "prefix"
    ? formatDuration(totals.latencyAvgMs)
    : `${formatDuration(totals.latencyAvgMs)} / ${formatDuration(totals.latencyMaxMs)}`;
}

/**
 * 这一形态的延迟到底量到了没有。
 *
 * 没有样本时 `latencyAvgMs`/`latencyMaxMs` 都是 0，而 `formatDuration(0)` 是 `"0 ms"`——把它
 * 渲染成「平均改写耗时: 0 ms」，读起来比「没量到」更糟：那是在说「这条链路很快」。所以没有
 * 样本就整行不画（`attempts` 那一格已经说明了做过几次尝试，不缺这一句说明）。
 *
 * 两个条件都要：`attempts === 0` 覆盖「一次都没试过」；两个延迟都为 0 覆盖「试过但这一路
 * 没计时」（pipe 的跳过事件不带 latency）。
 */
export function hasLatencyOf(totals: Totals): boolean {
  return totals.attempts > 0 && (totals.latencyAvgMs > 0 || totals.latencyMaxMs > 0);
}

/** 这一形态的延迟标签是「平均」还是「平均 / 最大」。 */
export function latencyLabelKeyOf(form: InsightsForm): "latencyLabelPrefix" | "latencyLabelPipe" {
  return form === "prefix" ? "latencyLabelPrefix" : "latencyLabelPipe";
}

/**
 * 一次窗口内根本没有任何调用时的判据。
 *
 * `bashCalls === 0` 且没有节省：这时 KPI 六格全是 0、图是空的、三张表全空——把这一堆 0 摊在
 * 屏幕上，读它的人分不清「rtk 一次都没被调用」与「插件坏了」。整页换成一句话说明。
 */
export function isEmptyWindow(totals: Totals): boolean {
  return totals.bashCalls === 0 && totals.attempts === 0 && totals.savedTokens === 0;
}

/**
 * 明细行的展示值。
 *
 * 四列里**覆盖率是压缩形态独有的一列**：改写形态下每一行都没有这个分子分母（命令家族表里
 * `coveragePct` 恒 0，因为分母只有日表知道），显示成 `0%` 会被读成「这条命令一次都没成功」。
 * 所以这里给 `undefined`，由组件决定整列不画。
 */
export interface CellValues {
  readonly commands: string;
  readonly saved: string;
  readonly savings: string;
  /** 压缩形态才有；改写形态是 `undefined`，调用方须整列省略。 */
  readonly coverage: string | undefined;
}

/** 一行的数值单元。`coverage` 只在压缩形态填值。 */
export function cellsOf(
  row: {
    readonly commands: number;
    readonly savedTokens: number;
    readonly savingsPct: number;
    readonly coveragePct: number;
  },
  form: InsightsForm,
): CellValues {
  return {
    // 次数是**计数**，不是 token 量：`formatTokens` 会把它写成 `1.0k`，读的人会以为那是
    // 1000 上下的一位近似值，而这一列本来精确到个位（真机上曾出现 `10` 与 `1.0k` 混排）。
    commands: String(row.commands),
    saved: formatTokens(row.savedTokens),
    savings: formatPct(row.savingsPct),
    coverage: form === "pipe" ? formatPct(row.coveragePct) : undefined,
  };
}
