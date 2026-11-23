// Insights 读面的形状（宿主侧与客户端共用）。
//
// 一条贯穿本文件的分工：**这里只有契约，没有口径**。聚合、比较、阈值全部住在
// `lib/insights-service.ts`；本文件只固定「线上回执长什么样」，让宿主与客户端对同一份
// schema 各自 parse。派生值（节省率、覆盖率、份额）也在此出现，但它们是被 service 算好
// 之后**运输**的字段，不是在这里计算的——客户端拿到的每一个数都该能追回一个 SQL 聚合，
// 否则同一张图在两端会各算一套。
import { z } from "zod";

/**
 * 沙箱「只读」模式的字面值。
 *
 * service 与 `host.ts` 各写一份 `"read-only"` 的结果是：宿主哪天把它改成 `readOnly`，
 * 前缀侧会照旧去读账本、`availability.prefix` 永远不会是 `readonly`——一个没有症状的错。
 */
export const SANDBOX_MODE_READ_ONLY = "read-only";

/** 两种形态。与配置里的 `enabledForms` 同一个词表，但这里只允许这两值。 */
export const InsightsFormSchema = z.enum(["prefix", "pipe"]);
export type InsightsForm = z.infer<typeof InsightsFormSchema>;

/** 窗口天数：只允许这三档。放宽成任意整数会让缓存与横轴刻度都失去上界。 */
const RangeDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);
/** 粒度：日 / 周 / 月。周以周一为首（`lib/time-buckets.ts`）。 */
const GranularitySchema = z.enum(["day", "week", "month"]);

/** 页面请求。 */
export const InsightsRequestSchema = z.object({
  form: InsightsFormSchema,
  rangeDays: RangeDaysSchema,
  granularity: GranularitySchema,
});
export type InsightsRequest = z.infer<typeof InsightsRequestSchema>;

/** 某个形态今天的摘要（设置卡那一行）。 */
const FormTodaySchema = z.object({
  commands: z.int().nonnegative(),
  savedTokens: z.int(),
  savingsPct: z.number(),
  /** pipe 压缩成功次数；prefix 这一位是「改写成功次数」。 */
  compressed: z.int().nonnegative(),
  /** 尝试次数：pipe 是命中 filter 的候选数，prefix 是真正发出 rewrite 的次数。 */
  attempts: z.int().nonnegative(),
  /**
   * **成功率**：`compressed / attempts`，百分比两位小数；`attempts` 为 0 时是 0。
   *
   * 两种形态的 `attempts` 语义不同（见上），但这里的分母始终是「试过几次」——与
   * `Totals.coveragePct`（分母是全部 bash 调用）不是同一个比率，所以两个字段各有名字：
   * 这个说的是「试过的里面成了多少」，那个说的是「所有调用里有多少被这条形态覆盖」。
   */
  coveragePct: z.number(),
});
export type FormToday = z.infer<typeof FormTodaySchema>;

/** 窗口内的总量。 */
const TotalsSchema = z.object({
  /** 窗口内的 bash 调用数（两种形态共用的分母）。 */
  bashCalls: z.int().nonnegative(),
  attempts: z.int().nonnegative(),
  compressed: z.int().nonnegative(),
  originalTokens: z.int().nonnegative(),
  compressedTokens: z.int().nonnegative(),
  savedTokens: z.int(),
  savingsPct: z.number(),
  /** **覆盖面**：成功数 / 全部 bash 调用数。分母是 `bashCalls`，不是 `attempts`。 */
  coveragePct: z.number(),
  /** **成功率**：成功数 / `attempts`（失败含 verify 拒绝、超时、pipe 非零退出）。 */
  successPct: z.number(),
  /** 窗口内被跳过（低于阈值 / gate 拦截）的次数；与 `attempts` 不是同一个分母。 */
  skipped: z.int().nonnegative(),
  latencyAvgMs: z.number(),
  latencyMaxMs: z.number(),
});
export type Totals = z.infer<typeof TotalsSchema>;

/** 时间序列上的一个桶。 */
const SeriesPointSchema = z.object({
  key: z.string(),
  commands: z.int().nonnegative(),
  bashCalls: z.int().nonnegative(),
  attempts: z.int().nonnegative(),
  compressed: z.int().nonnegative(),
  originalTokens: z.int().nonnegative(),
  compressedTokens: z.int().nonnegative(),
  savedTokens: z.int(),
  savingsPct: z.number(),
  coveragePct: z.number(),
});
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;

/** 按 filter 的一行。 */
const FilterRowSchema = z.object({
  name: z.string(),
  commands: z.int().nonnegative(),
  attempts: z.int().nonnegative(),
  compressed: z.int().nonnegative(),
  originalTokens: z.int().nonnegative(),
  compressedTokens: z.int().nonnegative(),
  savedTokens: z.int(),
  savingsPct: z.number(),
  /**
   * **这一行的覆盖面**：这一行压成/改写的次数 / 窗口内全部 bash 调用数。
   *
   * 与 `Totals.coveragePct` 同一个分母（`bashCalls`），所以明细行加起来能对上总量那格。
   * 第一版这里用的是 `attempts / bashCalls`（候选覆盖率），而总量用的是成功数——
   * 同一个列名在两个层级指向不同分子，读者只会把「候选覆盖」当「成功覆盖」。
   */
  coveragePct: z.number(),
  latencyAvgMs: z.number(),
  /** 最后一次命中的时间戳（毫秒）；从没成功过是 `null`。 */
  lastUsedAt: z.number().nullable(),
});
export type FilterRow = z.infer<typeof FilterRowSchema>;

/** 按命令家族的一行。 */
const CommandRowSchema = FilterRowSchema.extend({ family: z.string() }).omit({ name: true });
export type CommandRow = z.infer<typeof CommandRowSchema>;

/** 按工作目录的一行。只保留命令数、节省量、节省率三项：再细就是原始数据了。 */
const WorkdirRowSchema = z.object({
  path: z.string(),
  commands: z.int().nonnegative(),
  savedTokens: z.int(),
  savingsPct: z.number(),
});
export type WorkdirRow = z.infer<typeof WorkdirRowSchema>;

/** 跳过原因的一行。 */
const SkipReasonRowSchema = z.object({ reason: z.string(), count: z.int().nonnegative() });
export type SkipReasonRow = z.infer<typeof SkipReasonRowSchema>;

/**
 * 事件的结局。
 *
 * 独立导出而不只内联在 `LastEventSchema` 里：`lib/insights-store.ts` 的行类型要用它把
 * DB 的 `TEXT` 列收紧成字面量联合——否则 service 从行里读出来的 `status` 是 `string`，
 * 拼回执时只能靠断言，而断言把一个「写坏的时刻」变成了静默的默认值。
 */
export const EventStatusSchema = z.enum(["compressed", "skipped", "rewritten", "failed"]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

/** 输入体量的分档。同上，给 store 的行类型用。 */
export const SizeBucketSchema = z.enum(["tiny", "small", "medium", "large", "unknown"]);
export type SizeBucket = z.infer<typeof SizeBucketSchema>;

/** 最近一次事件。 */
const LastEventSchema = z.object({
  ts: z.number(),
  form: InsightsFormSchema,
  status: EventStatusSchema,
  reason: z.string(),
  commandFamily: z.string(),
  filter: z.string().nullable(),
  workdir: z.string(),
  sizeBucket: SizeBucketSchema,
  /** 量到的节省量与比率；prefix 不量 token，所以这两格缺席而不是 0。 */
  savedTokens: z.number().nonnegative().optional(),
  savingsPct: z.number().optional(),
  /** 这一次的耗时；没量到就不带。 */
  latencyMs: z.number().nonnegative().optional(),
});
export type LastEvent = z.infer<typeof LastEventSchema>;

/**
 * 建议的一种。
 *
 * **这里只有参数，没有文案**：文案由客户端按 `kind` 查 `ui-messages` 组装。第一版把
 * 「filter x 收益偏低」这类中文句子拼在 service 里，en 宿主切到建议区就是整块中文——
 * 而界面语言是客户端才知道的事，service 不该替它决定。
 */
const SuggestionParamsSchema = z.object({
  /** `low-yield-filter` / `unused-filter` / `potential-filter` 用。 */
  filter: z.string().optional(),
  /** `low-yield-command` 用。 */
  family: z.string().optional(),
  /** 判据窗口（天）：`unused-filter` / `potential-filter` 是 30，低收益类是本次请求窗口。 */
  days: z.int().optional(),
  attempts: z.int().optional(),
  compressed: z.int().optional(),
  matches: z.int().optional(),
  savingsPct: z.number().optional(),
});

const SuggestionSchema = z.object({
  kind: z.enum(["low-yield-filter", "unused-filter", "potential-filter", "low-yield-command"]),
  key: z.string(),
  severity: z.enum(["info", "warn"]),
  params: SuggestionParamsSchema,
});
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type SuggestionParams = z.infer<typeof SuggestionParamsSchema>;

/**
 * 各形态的可用性。
 *
 * `prefix` 有五种状态而不是布尔：`missing`（没有 dsh 账本 = 这个 host 从没跑过 prefix）、
 * `unreadable`（文件在但打不开）、`schema`（能开但表/列不对，通常是 rtk 大版本变了）、
 * `readonly`（沙箱只读，拿不到 prefix 节省）、`ok`。合成一个布尔就把「怎么修」丢掉了。
 */
/**
 * 不可用的原因码。
 *
 * 只给码、不给句子：句子要按界面语言拼（`ui-messages` 的 `availability*` 一组键）。
 * 第一版 service 直接拼中文，en 界面就会在页脚蹦出一段中文。
 */
export const AvailabilityReasonSchema = z.enum([
  "prefixReadonly",
  "prefixMissing",
  "prefixUnreadable",
  "prefixSchema",
  "pipeUnavailable",
]);
export type AvailabilityReason = z.infer<typeof AvailabilityReasonSchema>;

const AvailabilitySchema = z.object({
  prefix: z.enum(["ok", "missing", "unreadable", "schema", "readonly"]),
  pipe: z.enum(["ok", "unavailable"]),
  /** 空表 = 两个形态都可用（界面据此不显示提示行）。 */
  reasons: z.array(AvailabilityReasonSchema),
});
export type Availability = z.infer<typeof AvailabilitySchema>;

/**
 * 旧快照里的单个 filter 分项。
 *
 * 单独提出来不只为降嵌套层数：它是**旧形状**（字节与 token 并存），与新的
 * `FilterRowSchema` 语义不同——新行是「某个 filter 在窗口内的表现」，旧项是「当时的累计量」。
 * 共用一个 schema 会让下一次改新行时顺手改坏迁移的读面。
 */
const LegacyFilterRowSchema = z.object({
  commands: z.int().nonnegative(),
  savedBytes: z.int(),
  savedTokens: z.int(),
});

/** 旧累计账本的快照（迁移后留在 `dsh_meta` 表里）。 */
export const LegacySnapshotSchema = z
  .object({
    commands: z.int().nonnegative(),
    savedTokens: z.int(),
    byForm: z.object({ prefix: z.int().nonnegative(), pipe: z.int().nonnegative() }),
    byFilter: z.record(z.string(), LegacyFilterRowSchema),
  })
  .nullable();
export type LegacySnapshot = z.infer<typeof LegacySnapshotSchema>;

/**
 * rtk 自己那本账的对账信号（页脚用）。
 *
 * 只挂在 prefix 形态上：另外两种形态的分子分母来自插件自己的表，与 rtk 的汇总无关。
 *
 * - `parseFailures` / `recovered`：rtk 没认出命令、退回原样执行的那本账
 *   （`parse_failures` 表）。rtk 自己的 `rtk gain -F` 报的也是这两个数 + 一个回收率。
 * - `oversized`：窗口内 input 超 rtk 展示上限（7,500 tokens）的行数。**本页不排除这类行**
 *   （它是全量汇总），而 `rtk gain` 会整行排除，于是同一天可能出现两个不同的节省率——
 *   这一位存在的唯一目的就是让页脚说清「差在哪几行」，而不是让读者去猜。
 * - `recallEntries` / `recallBytes`：`recall.db` 的体检数（不是窗口内的，那个库由 rtk 按
 *   保留天数与条数上限整库淘汰）。它是**取回通道**：被折叠的中段存在那里，输出尾巴留
 *   `[+N hidden: rtk recall <hash>]`。显示它只为一件事——让人知道有个库在悄悄长大、去哪个
 *   目录找它。字节数取文件大小，不是 `SUM(byte_size)`（后者是压缩前长度）。
 */
export const RtkSelfSchema = z.object({
  parseFailures: z.int().nonnegative(),
  recovered: z.int().nonnegative(),
  oversized: z.int().nonnegative(),
  recallEntries: z.int().nonnegative(),
  recallBytes: z.int().nonnegative(),
});
export type RtkSelf = z.infer<typeof RtkSelfSchema>;

/** 页面回执。 */
export const InsightsResponseSchema = z.object({
  form: InsightsFormSchema,
  rangeDays: RangeDaysSchema,
  granularity: GranularitySchema,
  availability: AvailabilitySchema,
  today: z.object({ prefix: FormTodaySchema, pipe: FormTodaySchema }),
  totals: TotalsSchema,
  series: z.array(SeriesPointSchema),
  filters: z.array(FilterRowSchema),
  commands: z.array(CommandRowSchema),
  workdirs: z.array(WorkdirRowSchema),
  skipReasons: z.array(SkipReasonRowSchema),
  lastEvent: LastEventSchema.nullable(),
  suggestions: z.array(SuggestionSchema),
  legacy: LegacySnapshotSchema,
  /** 数据覆盖的起始日；空库时 `null`。 */
  dataStart: z.string().nullable(),
  /** rtk 那本账的对账信号；pipe 形态恒给全 0（它那两档不读 rtk 的汇总）。 */
  rtkSelf: RtkSelfSchema,
});
export type InsightsResponse = z.infer<typeof InsightsResponseSchema>;

/** 设置卡那一行的回执：只要今日两个形态 + 可用性 + 旧账本。 */
export const StatsOverviewSchema = z.object({
  today: z.object({ prefix: FormTodaySchema, pipe: FormTodaySchema }),
  availability: AvailabilitySchema,
  legacy: LegacySnapshotSchema,
});
export type StatsOverview = z.infer<typeof StatsOverviewSchema>;

/**
 * pipe 没压成的原因。
 *
 * 这张表是**读面可解释性**的承重件：一个「0 次压缩」如果分不出「没命中 filter」与
 * 「命中了但收益太低」，读者只能猜，而猜出来的结论通常指向错误的设置项。
 * `guard:${string}` 这一支留给 `lib/guard.ts` 的判定结果（它给的是自由文本原因）。
 */
export type PipeSkipReason =
  | "no-command"
  /**
   * 早期版本把「非 shell 工具」也记成一条跳过，于是「最近一次压缩」会显示
   * 「已跳过 · not-shell」、跳过原因榜里也会有一行 `not-shell`——那既不是这一次 shell 调用
   * 发生了什么，也不是读者能据此调整的东西。现在非 shell 调用根本不记，这一支只为读旧库保留。
   */
  | "not-shell"
  /** 下游把结果替换成了别的值（`accept` + `value`）：这份输出已经不是我们能压的那份。 */
  | "downstream-value"
  /** 下游直接拦下了这次调用（`block`）：与「换了值」是两件事，读法也不同。 */
  | "downstream-block"
  | "error"
  | "already-rewritten"
  | "structural-reject"
  | "no-filter"
  /**
   * 早期版本在 B 形态这一侧按 vitest 主版本拒绝压缩（5.x 上 rtk 只回一行 passthrough）。
   * 那条路现在改成本地删通过行（`lib/vitest-strip.ts`），不再有产生点；这一支只为读旧库保留。
   */
  | "vitest-gate"
  | "no-output"
  | "too-small"
  | "too-large"
  | "shape-mismatch"
  | "pipe-failed"
  | "not-json"
  | "pipe-internal"
  | `guard:${string}`;

/** 写进 store 的一条 pipe 记录。 */
export type PipeRecord =
  | { kind: "pipe-bash-call"; ts: number; commandFamily: string; workdir: string }
  | {
      kind: "pipe-skip";
      ts: number;
      reason: PipeSkipReason;
      filter?: string;
      commandFamily: string;
      workdir: string;
      originalTokens?: number;
      originalBytes?: number;
      latencyMs?: number;
    }
  | {
      kind: "pipe-success";
      ts: number;
      filter: string;
      commandFamily: string;
      workdir: string;
      originalTokens: number;
      compressedTokens: number;
      savedTokens: number;
      originalBytes: number;
      compressedBytes: number;
      latencyMs: number;
    }
  | { kind: "potential"; ts: number; day: string; filter: string; matches: number };

/** 写进 store 的一条 prefix 记录。 */
export type PrefixRecord =
  | { kind: "prefix-bash-call"; ts: number; commandFamily: string; workdir: string }
  | { kind: "prefix-gate-skip"; ts: number; reason: string; commandFamily: string; workdir: string }
  | { kind: "prefix-attempt"; ts: number }
  | {
      kind: "prefix-outcome";
      ts: number;
      outcome: "no-rewrite" | "verify-rejected" | "rewrite-error" | "timeout";
      reason: string;
      commandFamily: string;
      workdir: string;
      latencyMs: number;
    }
  | {
      kind: "prefix-rewritten";
      ts: number;
      latencyMs: number;
      families: readonly string[];
      workdir: string;
    };
