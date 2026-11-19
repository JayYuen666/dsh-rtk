/**
 * 聚合层：把 store 的原始行与 rtk 账本的原始行折成页面回执。
 *
 * 为什么聚合住在这一层而不是 store：`lib/insights-store.ts` 只暴露原始行（见那里的注释），
 * 于是「覆盖率的分母是什么」「节省率按 token 还是按字节」这类**口径**只有一份实现。放进 SQL
 * 会让两个形态各写一套 `GROUP BY`，改一处就两边不一致。
 *
 * 三条贯穿全文件的口径：
 *
 * 1. **两种形态不合并**。prefix 省的是「rtk 改写之后模型读到的输出」，pipe 省的是「喂给
 *    `rtk pipe` 之前与之后」——分母不同、数据源不同（一个读 rtk 自己的 DB，一个读插件自己的
 *    库），合并成一个「总节省率」只会得到一个既不能归因也不能复现的数。
 * 2. **缺失不冒充 0**。`store` 打不开时 pipe 的 availability 是 `unavailable`、各读面给空，
 *    而不是给「0 次压缩」；read-only 时不读 rtk 账本，prefix 节省给 0 但 availability 标
 *    `readonly`。否则「没数据」与「省了 0」在界面上长得一样。
 * 3. **读面不做写**。`overview` / `insights` 全是纯读；`reset` 是唯一写入口，且任一步失败只
 *    让对应形态的 availability 变差，不抛。
 */
import type {
  AvailabilityReason,
  CommandRow,
  FilterRow,
  FormToday,
  InsightsRequest,
  InsightsResponse,
  LastEvent,
  LegacySnapshot,
  RtkSelf,
  SeriesPoint,
  StatsOverview,
  Suggestion,
  Totals,
  WorkdirRow,
} from "./insights-shape.ts";
import type {
  InsightsStore,
  LastEventRow,
  PipeDayRow,
  PipeEventRow,
  PotentialRow,
  PrefixDayRow,
  ReasonRow,
} from "./insights-store.ts";
import type {
  LedgerCommandRow,
  LedgerWorkdirRow,
  PrefixLedgerResult,
  RtkLedger,
} from "./rtk-ledger.ts";
import type { StatsStatus } from "./stats-shape.ts";

import { commandFamilyOf } from "./command-family.ts";
import { SANDBOX_MODE_READ_ONLY } from "./insights-shape.ts";
import { localDayKey, localMonthKey, localWeekKey, windowStartDay } from "./time-buckets.ts";

/** 建议窗口：spec §8 规定「启用未命中」与「未启用但可匹配」看最近 30 天。 */
const SUGGESTION_WINDOW_DAYS = 30;
/** 低收益判据的最少样本数（attempts 与 commands 共用这一条线）。 */
const MIN_SAMPLES = 5;
/** 低收益判据的节省率门槛（百分比）。 */
const LOW_YIELD_PCT = 30;
/** 「未启用但可匹配」的最少命中次数。 */
const POTENTIAL_MATCHES = 3;
/** 事件行里表示「压成功」的状态（写面与读面共用这一枚字面量）。 */
const STATUS_COMPRESSED = "compressed";
/** 「不认识」的兜底家族名（与 `commandFamilyOf` 的返回值同源）。 */
const UNKNOWN = "unknown";
/** 形态名（挑 `lastEvent` 时按它过滤）。 */
const FORM_PREFIX = "prefix";
const FORM_PIPE = "pipe";
/** 概览窗口：设置卡那一行只看今天，但账本读面要一个窗口，7 天最省。 */
const OVERVIEW_DAYS = 7;

/** 百分比保留两位：与 `lib/stats-shape.ts` 的 `summarize` 同一口径。 */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 分母为 0 时给 0，不给 `NaN`。 */
const pct = (part: number, whole: number): number => (whole > 0 ? round2((part / whole) * 100) : 0);

/** 一列求和。 */
const sum = <Row>(rows: readonly Row[], pick: (row: Row) => number): number =>
  rows.reduce((acc, row) => acc + pick(row), 0);

/** 按粒度把本地日折成桶键（日 / 周一 / 月）。 */
function bucketKey(day: string, granularity: InsightsRequest["granularity"]): string {
  if (granularity === "week") {
    return localWeekKey(day);
  }
  return granularity === "month" ? localMonthKey(day) : day;
}

/** 各形态的可用性（回执里那一段）。 */
type Availability = InsightsResponse["availability"];

/**
 * service 的依赖面。
 *
 * 三个「取值函数」而不是快照：卡片上改完 `enabledFilters` 或换沙箱模式之后，下一次读页面
 * 就该按新值算。传值会让页面在装配那一刻被冻住。
 */
export interface InsightsServiceDeps {
  /**
   * 取插件自己的统计库；返回 `undefined` = `node:sqlite` 不可用或库打不开。
   *
   * 是**取值函数**而不是值：库是异步打开的（`apply` 是同步的，建表 SQL 只能排在后面），
   * 装配那一刻把 `undefined` 快照进来，页面就永远读到「不可用」。
   */
  readonly store: () => InsightsStore | undefined;
  readonly ledger: RtkLedger;
  readonly status: () => StatsStatus;
  /** 部署默认的沙箱模式；`undefined` = 这个宿主没有该服务。 */
  readonly sandboxMode: () => string | undefined;
  readonly enabledFilters: () => readonly string[];
  /**
   * 读面失败时的播报口。
   *
   * 与 `log` 分开的理由同 `PrefixOptions.warn`：读不出来意味着页面在说「窗口里什么都没有」，
   * 而真实原因是库被别人锁着或文件坏了——这两件事必须有人能看见。
   */
  readonly warn?: ((line: string) => void) | undefined;
  /** 测试注入口：默认 `Date.now`。 */
  readonly now?: (() => number) | undefined;
}

/** 读面。全是幂等读，`reset` 是唯一写入口。 */
export interface InsightsService {
  readonly overview: () => Promise<StatsOverview>;
  readonly insights: (request: InsightsRequest) => Promise<InsightsResponse>;
  readonly reset: () => Promise<StatsOverview>;
  readonly status: () => StatsStatus;
}

/** 空账本回执：四种非 ok 态共用同一份骨架。 */
function emptyLedger(availability: PrefixLedgerResult["availability"]): PrefixLedgerResult {
  return {
    availability,
    days: [],
    commands: [],
    workdirs: [],
    dataStart: null,
    failures: { total: 0, recovered: 0 },
    oversized: 0,
    recall: { entries: 0, bytes: 0 },
  };
}

/**
 * pipe 形态的那一格：**整页不读 rtk 的汇总**。
 *
 * 不是「读不到」而是「口径不同」：结果压缩的分子分母来自插件自己的 `dsh_pipe_*` 表，
 * rtk 那句「本页比 `rtk gain` 多算了 N 行」说的是 `commands` 表，与这一屏无关。给 0 而不是
 * 省掉这一格，是为了让契约只有一种形状（客户端不必按形态分支判断字段在不在）。
 */
const NO_RTK_SELF: RtkSelf = {
  parseFailures: 0,
  recovered: 0,
  oversized: 0,
  recallEntries: 0,
  recallBytes: 0,
};

/** 账本读面的结果：空回执 + 「是不是因为只读才空」。 */
interface LedgerRead {
  readonly result: PrefixLedgerResult;
  /** 沙箱只读：不是没有账本，而是按 spec §9 不去读它。 */
  readonly readonly: boolean;
}

/**
 * 拼一句能指导下一步动作的说明。
 *
 * 合成一个布尔会把「怎么修」丢掉：`missing` 要去跑一次 prefix、`readonly` 要换沙箱模式、
 * `schema` 要检查 rtk 版本——这三种在界面上必须说不同的话。
 */
function availabilityReasons(
  prefix: Availability["prefix"],
  pipeUnavailable: boolean,
): AvailabilityReason[] {
  const reasons: AvailabilityReason[] = [];
  if (prefix === "readonly") {
    reasons.push("prefixReadonly");
  }
  if (prefix === "missing") {
    reasons.push("prefixMissing");
  }
  if (prefix === "unreadable") {
    reasons.push("prefixUnreadable");
  }
  if (prefix === "schema") {
    reasons.push("prefixSchema");
  }
  if (pipeUnavailable) {
    reasons.push("pipeUnavailable");
  }
  return reasons;
}

/** 回执里的 availability 段。 */
function availabilityOf(ledger: LedgerRead, store: InsightsStore | undefined): Availability {
  const pipeUnavailable = store === undefined;
  const prefix = ledger.readonly ? "readonly" : ledger.result.availability;
  return {
    prefix,
    pipe: pipeUnavailable ? "unavailable" : "ok",
    reasons: availabilityReasons(prefix, pipeUnavailable),
  };
}

/**
 * 今日的 prefix 摘要。
 *
 * 计数来自插件库（改写成没成只有它知道），节省量来自 rtk 账本（只有 rtk 知道字节）。
 * read-only 时后者为空，于是 `savedTokens` 是 0——但 availability 已经标了 `readonly`，
 * 界面据此说「不可用」而不是把 0 当结论。
 */
function todayPrefix(
  days: readonly PrefixDayRow[],
  ledger: PrefixLedgerResult,
  today: string,
): FormToday {
  const row = days.find((item) => item.day === today);
  const ledgerDay = ledger.days.find((item) => item.day === today);
  const commands = row?.rewritten ?? 0;
  const savedTokens = ledgerDay?.saved ?? 0;
  return {
    commands,
    savedTokens,
    savingsPct: pct(savedTokens, ledgerDay?.input ?? 0),
    compressed: commands,
    attempts: row?.attempts ?? 0,
    coveragePct: pct(commands, row?.bash_calls ?? 0),
  };
}

/** 今日的 pipe 摘要。尝试数就是今日事件行数（只有命中 filter 的候选才写事件行）。 */
function todayPipe(
  days: readonly PipeDayRow[],
  events: readonly PipeEventRow[],
  today: string,
): FormToday {
  const row = days.find((item) => item.day === today);
  const compressed = row?.compressed ?? 0;
  const attempts = events.filter((event) => event.day === today).length;
  const savedTokens = row?.saved_tokens ?? 0;
  return {
    commands: compressed,
    savedTokens,
    savingsPct: pct(savedTokens, row?.original_tokens ?? 0),
    compressed,
    attempts,
    coveragePct: pct(compressed, attempts),
  };
}

/** 一批事件行的累加器。 */
interface EventGroup {
  commands: number;
  attempts: number;
  compressed: number;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  latencySum: number;
  latencyCount: number;
  lastUsedAt: number | null;
}

/** 空累加器。 */
function emptyGroup(): EventGroup {
  return {
    commands: 0,
    attempts: 0,
    compressed: 0,
    originalTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    latencySum: 0,
    latencyCount: 0,
    lastUsedAt: null,
  };
}

/** 把一条事件折进累加器。 */
function foldEvent(group: EventGroup, event: PipeEventRow): void {
  group.attempts += 1;
  group.commands += 1;
  group.originalTokens += event.original_tokens;
  group.compressedTokens += event.compressed_tokens;
  group.savedTokens += event.saved_tokens;
  if (event.latency_ms > 0) {
    group.latencySum += event.latency_ms;
    group.latencyCount += 1;
  }
  if (event.status === STATUS_COMPRESSED) {
    group.compressed += 1;
    group.lastUsedAt = group.lastUsedAt === null ? event.ts : Math.max(group.lastUsedAt, event.ts);
  }
}

/** 按某个键把事件行分组（键为空串时落 `unknown`，否则 `GROUP BY` 会多一行空名）。 */
function groupEvents(
  events: readonly PipeEventRow[],
  keyOf: (event: PipeEventRow) => string,
): Map<string, EventGroup> {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    const raw = keyOf(event);
    const key = raw === "" ? UNKNOWN : raw;
    const group = groups.get(key) ?? emptyGroup();
    foldEvent(group, event);
    groups.set(key, group);
  }
  return groups;
}

/** 一组事件的派生指标（filter 行与 command 行共用的那一半）。 */
function metricsOf(group: EventGroup, totalBashCalls: number): Omit<FilterRow, "name"> {
  return {
    commands: group.commands,
    attempts: group.attempts,
    compressed: group.compressed,
    originalTokens: group.originalTokens,
    compressedTokens: group.compressedTokens,
    savedTokens: group.savedTokens,
    savingsPct: pct(group.savedTokens, group.originalTokens),
    coveragePct: pct(group.attempts, totalBashCalls),
    latencyAvgMs: group.latencyCount > 0 ? round2(group.latencySum / group.latencyCount) : 0,
    lastUsedAt: group.lastUsedAt,
  };
}

/** 按 filter 的行，按节省量降序。 */
function filterRowsOf(groups: Map<string, EventGroup>, totalBashCalls: number): FilterRow[] {
  return Array.from(groups, ([name, group]): FilterRow => ({
    name,
    ...metricsOf(group, totalBashCalls),
  })).toSorted((left, right) => right.savedTokens - left.savedTokens);
}

/** 按命令家族的行。 */
function commandRowsOf(groups: Map<string, EventGroup>, totalBashCalls: number): CommandRow[] {
  return Array.from(groups, ([family, group]): CommandRow => ({
    family,
    ...metricsOf(group, totalBashCalls),
  })).toSorted((left, right) => right.savedTokens - left.savedTokens);
}

/** 按工作目录的行。 */
function workdirRowsOf(groups: Map<string, EventGroup>): WorkdirRow[] {
  return Array.from(groups, ([path, group]): WorkdirRow => ({
    path,
    commands: group.commands,
    savedTokens: group.savedTokens,
    savingsPct: pct(group.savedTokens, group.originalTokens),
  })).toSorted((left, right) => right.savedTokens - left.savedTokens);
}

/** 序列累加器：一份里同时放两个数据源的量，最后统一重算率。 */
interface Bucket {
  commands: number;
  bashCalls: number;
  attempts: number;
  compressed: number;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
}

/** 取桶（没有就建一个）。 */
function bucketOf(buckets: Map<string, Bucket>, key: string): Bucket {
  const existing = buckets.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const fresh: Bucket = {
    commands: 0,
    bashCalls: 0,
    attempts: 0,
    compressed: 0,
    originalTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
  };
  buckets.set(key, fresh);
  return fresh;
}

/** 把桶折成序列点并按键排序（客户端据此补空桶，服务端不凭空造零值）。 */
function seriesOf(buckets: Map<string, Bucket>): SeriesPoint[] {
  return Array.from(buckets, ([key, bucket]): SeriesPoint => ({
    key,
    commands: bucket.commands,
    bashCalls: bucket.bashCalls,
    attempts: bucket.attempts,
    compressed: bucket.compressed,
    originalTokens: bucket.originalTokens,
    compressedTokens: bucket.compressedTokens,
    savedTokens: bucket.savedTokens,
    savingsPct: pct(bucket.savedTokens, bucket.originalTokens),
    coveragePct: pct(bucket.compressed, bucket.bashCalls),
  })).toSorted((left, right) => (left.key < right.key ? -1 : 1));
}

/** 一批延迟样本的均值与峰值（只认 >0 的样本：0 表示「没计时」，不是「瞬时」）。 */
function latencyOf(values: readonly number[]): { readonly avg: number; readonly max: number } {
  const samples = values.filter((value) => value > 0);
  if (samples.length === 0) {
    return { avg: 0, max: 0 };
  }
  // **不要写 `Math.max(...samples)`**：展开一个长度不受控的数组会先把它铺成实参列表，
  // 十几万个样本就够 V8 抛 `RangeError: Maximum call stack size exceeded`——而这个函数在
  // 每条 Remote 读面上都会跑。循环一遍没有这个上限。
  let max = 0;
  for (const sample of samples) {
    if (sample > max) {
      max = sample;
    }
  }
  return {
    avg: round2(sum(samples, (value) => value) / samples.length),
    max,
  };
}

/** pipe 的总量。`attempts` 数事件行——只有命中 filter 的候选才写事件。 */
function pipeTotalsOf(days: readonly PipeDayRow[], events: readonly PipeEventRow[]): Totals {
  const bashCalls = sum(days, (day) => day.bash_calls);
  const compressed = sum(days, (day) => day.compressed);
  const originalTokens = sum(days, (day) => day.original_tokens);
  const compressedTokens = sum(days, (day) => day.compressed_tokens);
  const savedTokens = sum(days, (day) => day.saved_tokens);
  const latency = latencyOf(events.map((event) => event.latency_ms));
  return {
    bashCalls,
    attempts: events.length,
    compressed,
    originalTokens,
    compressedTokens,
    savedTokens,
    savingsPct: pct(savedTokens, originalTokens),
    coveragePct: pct(compressed, bashCalls),
    successPct: pct(compressed, events.length),
    latencyAvgMs: latency.avg,
    latencyMaxMs: latency.max,
  };
}

/**
 * prefix 的总量。节省量来自 rtk 账本，计数来自插件库。
 *
 * `latencyMaxMs` 恒为 0：日表只留 `latency_ms_sum` 与 `latency_count`（spec 只要求 pipe 报
 * 峰值）。拿均值冒充峰值比给 0 更坏——那会让人以为峰值已经量过了。
 */
function prefixTotalsOf(days: readonly PrefixDayRow[], ledger: PrefixLedgerResult): Totals {
  const bashCalls = sum(days, (day) => day.bash_calls);
  const attempts = sum(days, (day) => day.attempts);
  const rewritten = sum(days, (day) => day.rewritten);
  const originalTokens = sum(ledger.days, (day) => day.input);
  const compressedTokens = sum(ledger.days, (day) => day.output);
  const savedTokens = sum(ledger.days, (day) => day.saved);
  const latencySum = sum(days, (day) => day.latency_ms_sum);
  const latencyCount = sum(days, (day) => day.latency_count);
  return {
    bashCalls,
    attempts,
    compressed: rewritten,
    originalTokens,
    compressedTokens,
    savedTokens,
    savingsPct: pct(savedTokens, originalTokens),
    coveragePct: pct(rewritten, bashCalls),
    successPct: pct(rewritten, attempts),
    latencyAvgMs: latencyCount > 0 ? round2(latencySum / latencyCount) : 0,
    latencyMaxMs: 0,
  };
}

/** pipe 的时间序列：计数与 token 分别来自两张表，按同一把桶键合并。 */
function pipeSeriesOf(
  days: readonly PipeDayRow[],
  events: readonly PipeEventRow[],
  granularity: InsightsRequest["granularity"],
): SeriesPoint[] {
  const buckets = new Map<string, Bucket>();
  for (const day of days) {
    const bucket = bucketOf(buckets, bucketKey(day.day, granularity));
    bucket.commands += day.compressed;
    bucket.bashCalls += day.bash_calls;
    bucket.compressed += day.compressed;
    bucket.originalTokens += day.original_tokens;
    bucket.compressedTokens += day.compressed_tokens;
    bucket.savedTokens += day.saved_tokens;
  }
  for (const event of events) {
    bucketOf(buckets, bucketKey(event.day, granularity)).attempts += 1;
  }
  return seriesOf(buckets);
}

/** prefix 的时间序列：计数来自插件库，token 来自 rtk 账本。 */
function prefixSeriesOf(
  days: readonly PrefixDayRow[],
  ledger: PrefixLedgerResult,
  granularity: InsightsRequest["granularity"],
): SeriesPoint[] {
  const buckets = new Map<string, Bucket>();
  for (const day of days) {
    const bucket = bucketOf(buckets, bucketKey(day.day, granularity));
    bucket.commands += day.rewritten;
    bucket.bashCalls += day.bash_calls;
    bucket.attempts += day.attempts;
    bucket.compressed += day.rewritten;
  }
  for (const day of ledger.days) {
    const bucket = bucketOf(buckets, bucketKey(day.day, granularity));
    bucket.originalTokens += day.input;
    bucket.compressedTokens += day.output;
    bucket.savedTokens += day.saved;
  }
  return seriesOf(buckets);
}

/**
 * 把账本里按 `original_cmd` 分组的行折成命令家族。
 *
 * 账本的粒度是「一模一样的命令行」——`cargo test -p a` 与 `cargo test -p b` 是两行。页面上
 * 需要的是家族层面的「哪类命令没收益」，所以在这里收口一次（与写面的 `commandFamilyOf`
 * 同一份实现，不能各写一套）。
 */
function prefixCommandRows(rows: readonly LedgerCommandRow[]): CommandRow[] {
  const groups = new Map<string, EventGroup>();
  for (const row of rows) {
    // `original_cmd` 是**被改写的那一段**，不是整条命令行：实测 `cd x && rtk git diff &&
    // rtk cargo test` 在 rtk 的 `commands` 表里落成两行（`git diff` 与 `cargo test`），
    // `cd x` 那一段没有行。所以直接折家族就是「按被替换的段统计」，不需要再拆一次命令；
    // 反过来拿整条命令折会得到 `cd`，那是从没被改写过的段。
    const family = commandFamilyOf(row.original_cmd);
    const group = groups.get(family) ?? emptyGroup();
    group.commands += row.commands;
    // 账本里只有**写成了**的命令（`commands` 表由 rtk 在跑完之后写），所以这里每一行都既是
    // 尝试也是成功。第一版把三者都设成 `commands` 看着无害，但它让这一行的 `successPct`
    // 恒等于 100%——那是在声称「这类命令每次都改写成功」，而失败的尝试根本没有行。
    group.attempts = group.commands;
    group.compressed = group.commands;
    group.originalTokens += row.input;
    group.compressedTokens += row.output;
    group.savedTokens += row.saved;
    groups.set(family, group);
  }
  return Array.from(groups, ([family, group]): CommandRow => ({
    family,
    commands: group.commands,
    attempts: group.attempts,
    compressed: group.compressed,
    originalTokens: group.originalTokens,
    compressedTokens: group.compressedTokens,
    savedTokens: group.savedTokens,
    savingsPct: pct(group.savedTokens, group.originalTokens),
    // 覆盖率的分母是 bash 调用数，只有插件库知道；账本里没有，给 0 而不编一个。
    coveragePct: 0,
    latencyAvgMs: 0,
    lastUsedAt: null,
  })).toSorted((left, right) => right.savedTokens - left.savedTokens);
}

/** 账本里的工作目录行（字段名不同，转一次）。
 *
 * 节省率的分母是**这个目录自己的** input，不是全库 input 总和。第一版用的是全库总和，于是
 * 每个目录的「节省率」都只是自己那份节省占全库的比例——真机上最忙的那个目录 26 次省了
 * 50k，却显示 37.8%，而没有量过 input 的目录也会有个大于 0 的百分比。 */
function prefixWorkdirRows(rows: readonly LedgerWorkdirRow[]): WorkdirRow[] {
  return rows.map((row) => ({
    path: row.project_path,
    commands: row.commands,
    savedTokens: row.saved,
    savingsPct: pct(row.saved, row.input),
  }));
}

/** 建议：pipe 的两条阈值判据（低收益 / 启用未命中）。 */
function pipeFilterSuggestions(
  groups: Map<string, EventGroup>,
  enabled: readonly string[],
  windowDays: number,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const [name, group] of groups) {
    const savingsPct = pct(group.savedTokens, group.originalTokens);
    if (group.attempts >= MIN_SAMPLES && savingsPct < LOW_YIELD_PCT) {
      // 两个数分开写：`attempts` 含被护栏拦下与跳过的事件，真正产出压缩体的是 `compressed`。
      // 只报前者时，「命中 5 条全被 low-gain 拒了」会被写成「压了 5 次只省 0%」——那是两种
      // 完全不同的处境（前者该调门槛或关掉，后者说明压缩根本没发生）。
      suggestions.push({
        kind: "low-yield-filter",
        key: name,
        severity: "info",
        params: {
          filter: name,
          days: windowDays,
          attempts: group.attempts,
          compressed: group.compressed,
          savingsPct,
        },
      });
    }
  }
  for (const name of enabled) {
    if (!groups.has(name)) {
      suggestions.push({
        kind: "unused-filter",
        key: name,
        severity: "info",
        params: { filter: name, days: SUGGESTION_WINDOW_DAYS },
      });
    }
  }
  return suggestions;
}

/** 建议：未启用但可匹配（`potential_filters` 的唯一用途）。 */
function potentialSuggestions(
  rows: readonly PotentialRow[],
  enabled: readonly string[],
): Suggestion[] {
  const enabledSet = new Set(enabled);
  // **先按 filter 合并再出建议**：`dsh_potential_filters` 的主键是 `(day, filter)`，30 天窗口
  // 里同一个 filter 会有多行。第一版逐行 map，于是同一件事被报成好几条建议（界面上重复出现、
  // React 的 key 也重复），而且每条都只说自己那一天的数字——读者会以为是「某一天命中 3 次」，
  // 实际是「30 天一共 9 次」。合并之后条数正确、数字也是窗口内的总量。
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.filter, (totals.get(row.filter) ?? 0) + row.matches);
  }
  return Array.from(totals, ([filter, matches]): Suggestion | null => {
    if (matches < POTENTIAL_MATCHES || enabledSet.has(filter)) {
      return null;
    }
    return {
      kind: "potential-filter",
      key: filter,
      severity: "info",
      params: { filter, days: SUGGESTION_WINDOW_DAYS, matches },
    };
  }).filter((item): item is Suggestion => item !== null);
}

/** 建议：prefix 里低收益的命令家族。 */
function prefixCommandSuggestions(
  groups: Map<string, EventGroup>,
  windowDays: number,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const [family, group] of groups) {
    const savingsPct = pct(group.savedTokens, group.originalTokens);
    if (group.commands >= MIN_SAMPLES && savingsPct < LOW_YIELD_PCT) {
      suggestions.push({
        kind: "low-yield-command",
        key: family,
        severity: "info",
        params: {
          family,
          days: windowDays,
          attempts: group.commands,
          savingsPct,
        },
      });
    }
  }
  return suggestions;
}

/** 把库里那一行投影成回执里的形状。 */
function lastEventOf(row: LastEventRow | undefined): LastEvent | null {
  if (row === undefined) {
    return null;
  }
  return {
    ts: row.ts,
    form: row.form,
    status: row.status,
    reason: row.reason,
    commandFamily: row.command_family,
    filter: row.filter,
    workdir: row.workdir,
    sizeBucket: row.size_bucket,
  };
}

/**
 * pipe 侧的数据起始日：保留窗口内最早的那一天（不是本次窗口的最早一天）。
 *
 * 只为一格日期就从 `0000-00-00` 起把整张日表读出来（保留 90 天，一天一行）不划算，
 * 交给 SQL 的 `ORDER BY day LIMIT 1` 更直接。
 */
function pipeDataStart(store: InsightsStore): string | null {
  return store.readPipeFirstDay();
}

/** 一次 `insights` 请求里两支共用的那几样。 */
interface SharedRead {
  readonly request: InsightsRequest;
  readonly now: number;
  readonly start: string;
  readonly ledger: PrefixLedgerResult;
  readonly store: InsightsStore | undefined;
  readonly enabled: readonly string[];
  readonly availability: Availability;
  readonly todayBoth: { readonly prefix: FormToday; readonly pipe: FormToday };
  readonly legacy: LegacySnapshot;
}

/** 跳过原因行按原因合并（两张原因表的形状一样，合并逻辑也一样）。 */
function reasonRowsOf(rows: readonly ReasonRow[]): { reason: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.reason, (totals.get(row.reason) ?? 0) + row.count);
  }
  return Array.from(totals, ([reason, count]) => ({ reason, count })).toSorted(
    (left, right) => right.count - left.count,
  );
}

/** pipe 形态的完整回执。 */
function pipeResponseOf(shared: SharedRead): InsightsResponse {
  const { request, store, now, start, legacy, enabled } = shared;
  const days = store?.readPipeDays(start) ?? [];
  const events = store?.readPipeEvents(start) ?? [];
  const filters = groupEvents(events, (event) => event.filter);
  const commands = groupEvents(events, (event) => event.command_family);
  const workdirs = groupEvents(events, (event) => event.workdir);
  const totalBash = sum(days, (day) => day.bash_calls);
  const potential = store?.readPotential(windowStartDay(SUGGESTION_WINDOW_DAYS, now)) ?? [];
  return {
    form: request.form,
    rangeDays: request.rangeDays,
    granularity: request.granularity,
    availability: shared.availability,
    today: shared.todayBoth,
    totals: pipeTotalsOf(days, events),
    series: pipeSeriesOf(days, events, request.granularity),
    filters: filterRowsOf(filters, totalBash),
    commands: commandRowsOf(commands, totalBash),
    workdirs: workdirRowsOf(workdirs),
    skipReasons: reasonRowsOf(store?.readPipeSkipReasons(start) ?? []),
    lastEvent: lastEventOf(store?.readLastEventOf(FORM_PIPE)),
    suggestions: [
      ...pipeFilterSuggestions(filters, enabled, request.rangeDays),
      ...potentialSuggestions(potential, enabled),
    ],
    legacy,
    dataStart: store === undefined ? null : pipeDataStart(store),
    rtkSelf: NO_RTK_SELF,
  };
}

/** prefix 形态的完整回执。 */
function prefixResponseOf(shared: SharedRead): InsightsResponse {
  const { request, store, start, legacy, ledger } = shared;
  const days = store?.readPrefixDays(start) ?? [];
  const commands = prefixCommandRows(ledger.commands);
  const families = new Map<string, EventGroup>();
  for (const row of commands) {
    const group = emptyGroup();
    group.commands = row.commands;
    group.attempts = row.attempts;
    group.compressed = row.compressed;
    group.originalTokens = row.originalTokens;
    group.compressedTokens = row.compressedTokens;
    group.savedTokens = row.savedTokens;
    families.set(row.family, group);
  }
  return {
    form: request.form,
    rangeDays: request.rangeDays,
    granularity: request.granularity,
    availability: shared.availability,
    today: shared.todayBoth,
    totals: prefixTotalsOf(days, ledger),
    series: prefixSeriesOf(days, ledger, request.granularity),
    // prefix 没有 filter 这一层：rtk 的改写表按命令模板匹配，不按 filter 分类。
    filters: [],
    commands,
    workdirs: prefixWorkdirRows(ledger.workdirs),
    skipReasons: reasonRowsOf(store?.readPrefixGateReasons(start) ?? []),
    lastEvent: lastEventOf(store?.readLastEventOf(FORM_PREFIX)),
    suggestions: prefixCommandSuggestions(families, request.rangeDays),
    legacy,
    dataStart: ledger.dataStart,
    rtkSelf: {
      parseFailures: ledger.failures.total,
      recovered: ledger.failures.recovered,
      oversized: ledger.oversized,
      recallEntries: ledger.recall.entries,
      recallBytes: ledger.recall.bytes,
    },
  };
}

/** 账本读面：read-only 时不读 DB（spec §9）。 */
async function readLedger(
  deps: InsightsServiceDeps,
  request: InsightsRequest,
): Promise<LedgerRead> {
  if (deps.sandboxMode() === SANDBOX_MODE_READ_ONLY) {
    return { result: emptyLedger("missing"), readonly: true };
  }
  return { result: await deps.ledger.read(request), readonly: false };
}

/** 概览用的固定请求（只关心「今天」，形态取 prefix，粒度取日）。 */
const OVERVIEW_REQUEST: InsightsRequest = {
  form: "prefix",
  rangeDays: OVERVIEW_DAYS,
  granularity: "day",
};

/**
 * 把 store 的读面折成「失败即空」。
 *
 * 为什么折在这一层而不是在每个 `store?.read*()` 调用点包 try/catch：读面有十来处，包漏一处
 * 就等于没有，而漏掉的那一处恰恰最可能先抛（`prepare` 在库被别的连接锁住或文件损坏时就抛）。
 * 折在这里，所有调用点共享同一个承诺——读不出来给空，不把异常抛给 Remote 调用方；至于
 * 「为什么空」，`availability` 已经说过了，这里只补一行为什么读不出来。
 * @param store - 打开的 store
 * @param warn - 播报口
 * @returns 读面被包过的 store
 */
function guardedReadsOf(
  store: InsightsStore,
  warn: ((line: string) => void) | undefined,
): InsightsStore {
  const read = <Value>(what: string, run: () => Value, fallback: Value): Value => {
    try {
      return run();
    } catch (error) {
      warn?.(`[rtk] insights: cannot read ${what} (${String(error)}); showing an empty window`);
      return fallback;
    }
  };
  return {
    ...store,
    readPipeDays: (startDay) => read("pipe days", () => store.readPipeDays(startDay), []),
    readPipeEvents: (startDay) => read("pipe events", () => store.readPipeEvents(startDay), []),
    readPipeSkipReasons: (startDay) =>
      read("pipe skip reasons", () => store.readPipeSkipReasons(startDay), []),
    readPrefixDays: (startDay) => read("prefix days", () => store.readPrefixDays(startDay), []),
    readPrefixGateReasons: (startDay) =>
      read("prefix gate reasons", () => store.readPrefixGateReasons(startDay), []),
    readPotential: (startDay) => read("potential filters", () => store.readPotential(startDay), []),
    readLastEventOf: (form) => read("the last event", () => store.readLastEventOf(form), undefined),
    readPipeFirstDay: () => read("the first pipe day", () => store.readPipeFirstDay(), null),
    readLegacy: () => read("the legacy snapshot", () => store.readLegacy(), null),
  };
}

/**
 * 取一个「读面不会抛」的 store。
 * @param store - 原始 store；`undefined` 原样返回（调用点照旧走 `?.` 与 `??`）
 * @param warn - 播报口
 * @returns 包过的 store
 */
function guardedStoreOf(
  store: InsightsStore | undefined,
  warn: ((line: string) => void) | undefined,
): InsightsStore | undefined {
  return store === undefined ? undefined : guardedReadsOf(store, warn);
}

/**
 * 造一个读面。
 * @param deps - 依赖面
 * @returns 读面
 */
export function createInsightsService(deps: InsightsServiceDeps): InsightsService {
  const clock = (): number => deps.now?.() ?? Date.now();

  /** 设置卡那一行：只算今日两个形态。 */
  const overview = async (): Promise<StatsOverview> => {
    const now = clock();
    const today = localDayKey(now);
    const start = windowStartDay(OVERVIEW_DAYS, now);
    const ledger = await readLedger(deps, OVERVIEW_REQUEST);
    const store = guardedStoreOf(deps.store(), deps.warn);
    return {
      today: {
        prefix: todayPrefix(store?.readPrefixDays(start) ?? [], ledger.result, today),
        pipe: todayPipe(
          store?.readPipeDays(start) ?? [],
          store?.readPipeEvents(start) ?? [],
          today,
        ),
      },
      availability: availabilityOf(ledger, store),
      legacy: store?.readLegacy() ?? null,
    };
  };

  /** 两支共用的那几样（两个形态的回执都从这里起步）。 */
  const sharedOf = async (request: InsightsRequest): Promise<SharedRead> => {
    const now = clock();
    const start = windowStartDay(request.rangeDays, now);
    const today = localDayKey(now);
    const ledger = await readLedger(deps, request);
    const store = guardedStoreOf(deps.store(), deps.warn);
    return {
      request,
      now,
      start,
      ledger: ledger.result,
      store,
      enabled: store === undefined ? [] : deps.enabledFilters(),
      availability: availabilityOf(ledger, store),
      todayBoth: {
        prefix: todayPrefix(store?.readPrefixDays(start) ?? [], ledger.result, today),
        pipe: todayPipe(
          store?.readPipeDays(start) ?? [],
          store?.readPipeEvents(start) ?? [],
          today,
        ),
      },
      legacy: store?.readLegacy() ?? null,
    };
  };

  return {
    overview,
    insights: async (request) => {
      const shared = await sharedOf(request);
      return request.form === FORM_PREFIX ? prefixResponseOf(shared) : pipeResponseOf(shared);
    },
    reset: async () => {
      // 两步各自「尽量清」：任一步失败只让对应形态的 availability 变差，不抛。
      try {
        await deps.store()?.reset();
      } catch {
        // 库打不开或写锁被占：pipe 侧会如实报 unavailable 或空窗口。
      }
      try {
        await deps.ledger.clear();
      } catch {
        // 账本不存在或不可写：prefix 侧照旧显示读到的那一份。
      }
      return overview();
    },
    status: () => deps.status(),
  };
}

/** 供测试与调用方复用的空账本（避免各处自己拼一份形状）。 */
export { emptyLedger };
