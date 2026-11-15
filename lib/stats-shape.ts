// 统计数据的形状定义（宿主侧与客户端共用）。
//
// 两个 schema 的分工：`statsAccumulatorSchema` 是**落盘**的形状（宿主在 `domain.open()` 时逐条
// `parse()` 它），`statsSummarySchema` 是**投影**的形状（卡片与 Remote 读它）。派生值
// （`savedBytes` / `savingsPct`）只在投影里出现，不落盘——口径只有 `summarize` 一处。
import { z } from "zod";

/** 设置卡命名空间（camelCase，与 `id: rtk` 不同源）：`/api/rtkStats/<method>`。 */
export const RTK_STATS_NAMESPACE = "rtkStats";

/**
 * 单个 filter 的分项。
 *
 * 先声明再组合，而不是把 `z.object({...})` 内联进 `z.record`：工作区的
 * `unicorn(max-nested-calls)` 上限是 3 层，内联写法是 4 层。
 */
const filterStatSchema = z.object({
  commands: z.int().nonnegative(),
  savedBytes: z.int(),
  /**
   * 这个 filter 省下的 token。与 `savedBytes` 并存的理由同账本那两列：字节可复算，
   * token 是宿主扣钱的单位。`.default(0)` 同样是迁移通道（本列加入前写下的账本没有它）。
   */
  savedTokens: z.int().nonnegative().default(0),
});

/** `byFilter` 那一层：filter 名 → 分项。 */
const byFilterSchema = z.record(z.string(), filterStatSchema);

/**
 * 排行榜的一行。与 `filterStatSchema` 分开声明而不是共用：那个是**落盘**的分项（命令数、
 * 字节与 token），这个是**投影**的排行行（带占比）。共用一份会让落盘形状里凭空多出
 * 一个「占全部省下量百分之几」的派生值——那个数随总账变化，存进账本就自相矛盾了。
 */
const topFilterSchema = z.object({
  filter: z.string(),
  commands: z.int().nonnegative(),
  savedTokens: z.int(),
  /** 在**全部节省 token** 中的份额（`savedTokens / 总节省 token`），不是该 filter 的压缩率。 */
  sharePct: z.number(),
});

/**
 * 持久化账本的形状。**必须是 zod**：`domainTable` 的 `valueSchema` 由宿主在 open 时逐条
 * `parse()`，喂 schemastery 会在 open 期炸掉（插件 Config 用 schemastery，记录 schema 用 zod，
 * 这条分工写在 `@deepseek-ai/dsh-storage-domain` 的模块注释里）。
 */
export const statsAccumulatorSchema = z.object({
  commands: z.int().nonnegative(),
  originalBytes: z.int().nonnegative(),
  compressedBytes: z.int().nonnegative(),
  /**
   * 压缩前后各自的 token 估计（宿主 `ctx.tokenMeter.estimateMessage` 给的数）。
   *
   * **`.default(0)` 是迁移通道，不是可选装饰**：域版本从 1 升到 2 时靠
   * `compatibleVersions: [1]` 让存量记录照常读，而那些记录里没有这两列——schema 不接受缺键
   * 的话，`open()` 会把整份账本判成 invalid-record，统计栏从「有几个数」变成「一个都没有」。
   * 缺键读成 0 之后的含义是「这一份没量过 token」，`summarize` 会退回字节口径。
   *
   * 字节与 token 两套都留：字节是「模型本可以多看多少」的物理量（可复算），token 是宿主的
   * 账单口径（估算）。只留一套时，卡片上的百分比与宿主真正扣的钱永远对不上。
   */
  originalTokens: z.int().nonnegative().default(0),
  compressedTokens: z.int().nonnegative().default(0),
  byFilter: byFilterSchema,
  /**
   * 按形态分账（spec §6）：两种形态各自记**命令数**，`pipe` 额外知道字节。
   *
   * `prefix` 记不到原始字节——命令在进 shell 之前就变成 `rtk <cmd>` 了，原始输出根本没经过本插件，
   * 所以它的字节列只能是 `—`（卡片上写「看 rtk gain」）。早先只有一份合计数，于是用户开着默认形态
   * （prefix）却在卡片上看到 0：账本只记了 pipe。
   */
  byForm: z.object({
    prefix: z.int().nonnegative(),
    pipe: z.int().nonnegative(),
  }),
});
export type StatsAccumulator = z.infer<typeof statsAccumulatorSchema>;

/** 空账本：`load()` 没有存量记录时的初值，也是 `reset()` 的落点。 */
export const EMPTY_ACCUMULATOR: StatsAccumulator = {
  commands: 0,
  originalBytes: 0,
  compressedBytes: 0,
  originalTokens: 0,
  compressedTokens: 0,
  byFilter: {},
  byForm: { prefix: 0, pipe: 0 },
};

/** 卡片与 Remote 读到的投影。 */
export const statsSummarySchema = z.object({
  commands: z.int().nonnegative(),
  originalBytes: z.int().nonnegative(),
  compressedBytes: z.int().nonnegative(),
  savedBytes: z.int(),
  originalTokens: z.int().nonnegative(),
  compressedTokens: z.int().nonnegative(),
  savedTokens: z.int(),
  savingsPct: z.number(),
  byFilter: byFilterSchema,
  /** 按形态分账的命令数（`prefix` / `pipe`）；字节只有 `pipe` 有。 */
  byForm: z.object({
    prefix: z.int().nonnegative(),
    pipe: z.int().nonnegative(),
  }),
  /**
   * 按 filter 的节省排行（token 降序，最多 `TOP_FILTERS` 条）。
   *
   * 卡片用它画条形图；留成**列表**而不是让客户端自己排 `byFilter` 的 Record，是因为
   * 「排哪一列、取前几」是口径问题，该和 `summarize` 待在一起，而不是散在渲染代码里。
   */
  topFilters: z.array(topFilterSchema),
});
export type StatsSummary = z.infer<typeof statsSummarySchema>;

/**
 * 卡片顶部那行运行时状态。放在本文件而不是 `lib/stats-remote.ts`：客户端读面要按它
 * `safeParse` 线上回执（读到坏形状时点名报错，而不是硬转一份 `as`），而宿主侧的
 * `StatsStatus` 就是同一个形状 —— 一份 schema 两处消费，改形状只改这一处。
 */
export const statsStatusSchema = z.object({
  rtkPath: z.string().nullable(),
  rtkVersion: z.string().nullable(),
  /**
   * 探到的版本够不够新：`null` = 根本没探到（二进制不在 / 超时 / 非零退出），
   * `false` = 读到了但低于下限。两者在卡片上是两句不同的话（装 vs 升级），
   * 而 `rtkVersion === null` 分不开它们——探测失败也交 `null`。
   */
  supported: z.boolean().nullable(),
  enabled: z.boolean(),
  forms: z.array(z.string()),
});
export type StatsStatus = z.infer<typeof statsStatusSchema>;

/** 排行榜最多几条：卡片是半宽面板，再多就只剩标签没有条了。 */
export const TOP_FILTERS = 6;

/**
 * 一张 filter 卡片的节省份额。
 *
 * 分母是**全部节省 token**（`originalTokens - compressedTokens`），不是全部原文 token。
 * 后者会让各条 filter 的占比相加等于整体节省率（例如 38.34%），读起来像分布、实际是贡献率；
 * 本卡片的文案与 `statsChartHint` 都按「占全部节省」解释，所以这里必须用前者。
 *
 * 分母 0 时给 0 而不是 NaN：域版本 1 的存量账本没有 token 两列，而本列加入前写下的记录里
 * 每条 `savedTokens` 也都是 0。
 */
function shareOf(savedTokens: number, totalSavedTokens: number): number {
  return totalSavedTokens <= 0 ? 0 : Math.round((savedTokens / totalSavedTokens) * 10_000) / 100;
}

/**
 * 账本 → 投影。
 *
 * **节省率优先按 token 算**：token 是宿主真正扣钱的单位，而字节只是它的物理代理。但存量记录
 * （域版本 1）没有 token 两列——那时 `originalTokens` 是 0，除下去是 `NaN`，卡片会把它原样打印。
 * 所以分母为 0 时退回字节口径，两者都是 0 才给 0。
 *
 * 保留两位小数；分母为 0 时是 `0` 而不是 `NaN`（卡片会原样打印它）。
 */
export function summarize(acc: StatsAccumulator): StatsSummary {
  const savedBytes = acc.originalBytes - acc.compressedBytes;
  const savedTokens = acc.originalTokens - acc.compressedTokens;
  const useTokens = acc.originalTokens > 0;
  const numerator = useTokens ? savedTokens : savedBytes;
  const denominator = useTokens ? acc.originalTokens : acc.originalBytes;
  const savingsPct = denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 100;
  const topFilters = Object.entries(acc.byFilter)
    .map(([filter, stat]) => ({
      filter,
      commands: stat.commands,
      savedTokens: stat.savedTokens,
      sharePct: shareOf(stat.savedTokens, savedTokens),
    }))
    .toSorted((left, right) => right.savedTokens - left.savedTokens)
    .slice(0, TOP_FILTERS);
  return { ...acc, savedBytes, savedTokens, savingsPct, topFilters };
}
