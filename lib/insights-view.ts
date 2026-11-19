// Insights 页的纯视图模型：补齐时间桶、算图表坐标、格式化数字。
//
// 这一层不碰 DOM、不碰 React、不碰 remote——它只吃 service 交回的回执，
// 所以能在 node 里逐条验（页面那一层要靠浏览器，覆盖率分母里没有它）。
//
// 为什么要在客户端再补一遍桶：service 只回**有数据**的桶（那是对的，它不该为了画图
// 去伪造零值），而折线图缺了中间那些天会把「11-01 到 11-15」画成相邻两天。
// 补零这一步因此归视图层，且必须与 service 用**同一套** `lib/time-buckets.ts`。
import type { InsightsResponse, SeriesPoint } from "./insights-shape.ts";
import { localDayKey, localMonthKey, localWeekKey, windowStartDay } from "./time-buckets.ts";

/** 天数不足它按稀疏处理：两个点画不出趋势，画出来只是在暗示有一条线。 */
const SPARSE_BELOW = 3;
/** `YYYY-MM-DD` 形态。起始日只接受这种：`Date.parse` 会把 `2026-10-28` 当 UTC 午夜，
 *  在负时区退到前一天，而这里要比的是**本地日**的桶键。 */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;
/** 空桶在回执里的形状：除 key 之外全是 0（`savingsPct` 分母为 0 时也給 0）。 */
const EMPTY_METRICS = {
  commands: 0,
  bashCalls: 0,
  attempts: 0,
  compressed: 0,
  originalTokens: 0,
  compressedTokens: 0,
  savedTokens: 0,
  savingsPct: 0,
  coveragePct: 0,
} as const;

/** 一个桶的聚合量（`emptyBucket` 与累加共用同一组字段）。 */
type Metrics = Omit<SeriesPoint, "key">;

/**
 * 把一行回执的 key 归到目标粒度。
 *
 * service 正常回的是已归并的键，但**不能假设它一定是**：跨版本时旧服务的桶键是整天，
 * 而页面已经切到周粒度——那时候把 `2026-11-03` 当成周键会让同一周出现四条柱子。
 * 所以这里一律再归一次（幂等：已是周键的 `2026-11-09` 归出来还是它自己）。
 */
function bucketKeyOf(raw: string, granularity: InsightsResponse["granularity"]): string {
  if (granularity === "month") {
    return localMonthKey(raw);
  }
  if (granularity === "week") {
    return localWeekKey(raw);
  }
  return raw.slice(0, 10);
}

/** 窗口内每个桶的键，按时间升序、去重。 */
function windowKeys(
  rangeDays: 7 | 30 | 90,
  granularity: InsightsResponse["granularity"],
  now: number,
): string[] {
  const start = windowStartDay(rangeDays, now);
  // 逐日 `setDate(getDate() + 1)` 而不是加 `DAY_MS`：夏令时那天不是 24 小时，
  // 按毫秒推进会跳过或重复一天（`lib/time-buckets.ts` 里同一条理由）。
  const cursor = new Date(
    Number(start.slice(0, 4)),
    Number(start.slice(5, 7)) - 1,
    Number(start.slice(8, 10)),
  );
  const keys: string[] = [];
  for (let day = 0; day < rangeDays; day += 1) {
    const key = bucketKeyOf(localDayKey(cursor.getTime()), granularity);
    if (keys.at(-1) !== key) {
      keys.push(key);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/** 把一行累加进桶里。**比率字段不在这里加**：它们必须由累加后的分子分母重算。 */
function foldInto(target: Metrics, row: SeriesPoint): void {
  target.commands += row.commands;
  target.bashCalls += row.bashCalls;
  target.attempts += row.attempts;
  target.compressed += row.compressed;
  target.originalTokens += row.originalTokens;
  target.compressedTokens += row.compressedTokens;
  target.savedTokens += row.savedTokens;
}

/** 分子分母重算比率（分母为 0 时给 0，不是 NaN——NaN 在 SVG/ECharts 里都画不出来，只是变空白）。 */
function ratioOf(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 100;
}

/**
 * 把 service 交回的桶补齐成整个窗口。
 *
 * @param series - service 交回的桶（只含有点的那些）
 * @param rangeDays - 窗口天数，与请求同源
 * @param granularity - 桶粒度
 * @param now - 当前时刻（毫秒）；测试注入用，页面传 `Date.now()`
 * @param dataStart - 数据起始日（`YYYY-MM-DD`，可空）。给了就从**那一天所在的桶**开始画：
 *   窗口比数据还长的那些天不该补成零柱——「这段时间没有数据」与「那段时间一次都没省下」
 *   在图上长得一样，读者只会得到后者。2026-11-18 真机上一眼看到的正是这个：近 30 天视图
 *   左端挂着一根 0 高度的柱子和一个 0% 的折线起点，而那天账本里根本没有记录。
 */
export function zeroFillSeries(
  series: readonly SeriesPoint[],
  rangeDays: 7 | 30 | 90,
  granularity: InsightsResponse["granularity"],
  now: number,
  dataStart?: string,
): SeriesPoint[] {
  const buckets = new Map<string, Metrics>();
  // 起始桶：数据起始日所在的那一个。桶键升序可比（`YYYY-MM-DD`），所以裁剪就是一次比较；
  // 落在起始日**同一个桶里**的那些天要留下（周桶常常跨过起始日）。
  const firstKey =
    dataStart === undefined || !DAY_KEY.test(dataStart) ? "" : bucketKeyOf(dataStart, granularity);
  for (const key of windowKeys(rangeDays, granularity, now)) {
    // 只留起始桶及其后：`if` 而不是 `continue`，因为这条规则在基线里是禁的
    // （`no-continue` 只许一条出路的写法）。
    if (firstKey === "" || key >= firstKey) {
      buckets.set(key, { ...EMPTY_METRICS });
    }
  }
  for (const row of series) {
    const target = buckets.get(bucketKeyOf(row.key, granularity));
    // 窗口外的行（保留期比窗口长，或时钟刚跨过零点）直接丢：画在轴上会让
    // 「最近 7 天」多出一根属于上个月的柱子。
    if (target !== undefined) {
      foldInto(target, row);
    }
  }
  return Array.from(buckets, ([key, metrics]) => ({
    key,
    ...metrics,
    savingsPct: ratioOf(metrics.savedTokens, metrics.originalTokens),
    coveragePct: ratioOf(metrics.compressed, metrics.bashCalls),
  }));
}

/** 一个点的图坐标。`x` 是 0~100 的百分比，`y` 同为 0~100（相对本图最大值）。 */
export interface ChartPoint {
  readonly key: string;
  readonly x: number;
  readonly yTokens: number;
  readonly yPct: number;
  readonly savedTokens: number;
  readonly savingsPct: number;
}

/** 折线 + 柱状共用的坐标与轴上限。 */
export interface ChartGeometry {
  readonly maxTokens: number;
  readonly maxPct: number;
  readonly points: readonly ChartPoint[];
}

/**
 * 归一化坐标。
 *
 * `x` 用 `index / (n - 1) * 100`：**等距**而不是按时间比例——日/周/月三档桶宽已经
 * 由粒度表达过了，再按毫秒拉开会让 90 天窗口里两个相邻点挤成半个像素。
 * 只有一个点时 `x` 给 50（画在正中间），否则 `0/0` 会得 NaN。
 */
export function chartGeometry(series: readonly SeriesPoint[]): ChartGeometry {
  let maxTokens = 0;
  let maxPct = 0;
  for (const row of series) {
    maxTokens = Math.max(maxTokens, row.savedTokens);
    maxPct = Math.max(maxPct, row.savingsPct);
  }
  const last = series.length - 1;
  const points = series.map((row, index) => ({
    key: row.key,
    x: last <= 0 ? 50 : (index / last) * 100,
    yTokens: maxTokens === 0 ? 0 : (row.savedTokens / maxTokens) * 100,
    yPct: maxPct === 0 ? 0 : (row.savingsPct / maxPct) * 100,
    savedTokens: row.savedTokens,
    savingsPct: row.savingsPct,
  }));
  return { maxTokens, maxPct, points };
}

/** 点太少时不画趋势：两个点连起来是一条线，不是趋势。 */
export function isSparse(series: readonly SeriesPoint[]): boolean {
  return series.filter((row) => row.savedTokens > 0).length < SPARSE_BELOW;
}

/**
 * token 数的短写：`1.2k` / `3.4M`。
 *
 * 图表轴与表格列都用它——完整数字（`1,234,567`）在 90 天窗口的轴标签上会互相压住。
 * 阈值取 1000 而不是 1024：这是给人看的读数，不是内存计量。
 */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

/** 百分比：最多一位小数，整数不带 `.0`（`62.5%` / `75%`）。 */
export function formatPct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${String(rounded)}%` : `${rounded.toFixed(1)}%`;
}

/**
 * 字节数的短写：`512 B` / `1.2 KB` / `3.4 MB`。
 *
 * 用 1024 进制而不是 `formatTokens` 的 1000：这里说的是磁盘上的那份文件，而文件大小在
 * 界面上与 `ls -lh`、Finder 的读法一致才有意义。`KB` 只保留一位小数、`B` 不带小数。
 */
export function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${String(Math.round(value))} B`;
}

/** 耗时：一秒钟以下按毫秒，以上按秒并保留一位小数。 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * 桶在轴上的标签。
 *
 * 月给 `YYYY-MM`（一个月一条，年份不能省）；日与周只给 `MM-DD`——轴上本来就只有
 * 一个季度的跨度，再写年份会两两重叠。周键是那周的周一，所以标签同样是一个日期。
 */
export function bucketLabel(key: string, granularity: InsightsResponse["granularity"]): string {
  return granularity === "month" ? key : key.slice(5);
}
