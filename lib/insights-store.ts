/**
 * 插件的统计表：写在 **rtk 自己的 `history.db` 里**，全部 `dsh_` 前缀（见 `lib/rtk-paths.ts`）。
 *
 * 为什么与 rtk 共用同一个库文件：用户要的是「一套数据」。改写量与 `rtk gain` 报的是同一批命令，
 * 分两个库就必然出现「页面 1.2k、rtk 说 4.8k」这种谁也解释不了的差；同一个库至少给了它们一个
 * 可以互相核对的机会。共用的是**文件**，不是表：我们只碰 `dsh_*`，rtk 只碰它自己那五张。
 *
 * 为什么另起表而不是继续用宿主的 storage domain：新统计面要按天、按命令家族、按 filter、
 * 按工作目录做**带时间窗的聚合**，而 domain 是「一条记录一把读全」的键值面——把 90 天的明细
 * 塞进一个 Record，每次读都要 parse 整份 JSON，写还要整份覆盖。SQLite 用 `GROUP BY day`
 * 一次给出一个桶，代价是与宿主的存储机制分家（取舍写在 spec 里）。
 *
 * **前缀不是审美**：`engine_attribution` 那种「借位」写法靠的是 rtk 的查询恰好都带 `site` 过滤，
 * 属于别人改一行 SQL 我们就开始污染的局面。自建表则是 rtk 从不 DROP、也不清扫的东西
 * （实测 `rtk gain --reset` 只 DELETE 它自己那五张表），所以我们的行与它的行互不干扰——代价是
 * 清理窗口要自己管（rtk 的 `cleanup_old` 只扫它自己的表）。
 *
 * 三条硬约束，每条都对应一种真实的坏法：
 *
 * 1. **热路径不落盘**：`record*` 只推内存缓冲，`flush` 才在一个事务里写。统计埋点跑在
 *    工具执行路径上，一次 fsync 就是几毫秒，而它服务的只是「看一眼省了多少」。
 * 2. **读面以 DB 为准**：`read*` 直接查库，不看缓冲。多 host 共享同一个 `DSH_HOME` 时，
 *    另一个进程刚写下的行本进程缓冲里没有——按缓冲读会让两个窗口各说一套。
 * 3. **重置靠代际号**：`reset()` 递增 `dsh_meta.statsEpoch` 再清表。旧缓冲 flush 时先比代际，
 *    不一致就整批丢弃。没有这一步，重置之后一条还没 flush 的记录会把统计「复活」。
 *
 * 打不开就返回 `undefined`（`node:sqlite` 缺失、路径不可写、文件损坏都一样）：统计是
 * 附加面，不能因为它让压缩本身失效。
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  EventStatus,
  InsightsForm,
  LegacySnapshot,
  PipeRecord,
  PrefixRecord,
  SizeBucket,
} from "./insights-shape.ts";
import { LegacySnapshotSchema } from "./insights-shape.ts";
import type { LegacyAccumulator } from "./legacy-stats.ts";
import type { DatabaseFace, ImportSqlite, StatementFace } from "./sqlite-face.ts";
import { closeQuietly, openSqlite } from "./sqlite-face.ts";
import { localDayKey, windowStartDay } from "./time-buckets.ts";

export type { DatabaseFace, SqliteModule } from "./sqlite-face.ts";

/** 打开统计库的入参。 */
export interface OpenInsightsStoreOptions {
  readonly dbPath: string;
  /** 旧累计账本；给出时做一次性迁移，`null` / 缺省表示没有旧账本。 */
  readonly legacy?: LegacyAccumulator | null;
  /** 测试注入口：默认真 `import("node:sqlite")`。 */
  readonly importSqlite?: ImportSqlite;
  /** 测试注入口：默认 `Date.now`。 */
  readonly now?: () => number;
  /**
   * 诊断口：写不进去、清不掉时各留一行。
   *
   * 这条链原先完全静默（`flushNow` 的 catch 吞掉整批），于是「统计悄悄变少」在日志里零线索。
   * 与 `insights-sink` 的 `warn` 同一个渠道。
   */
  readonly warn?: ((line: string) => void) | undefined;
}

/** `dsh_pipe_days` 的一行。 */
export interface PipeDayRow {
  readonly day: string;
  readonly bash_calls: number;
  readonly compressed: number;
  readonly original_tokens: number;
  readonly compressed_tokens: number;
  readonly saved_tokens: number;
  readonly latency_ms_sum: number;
  readonly latency_count: number;
}

/** `dsh_pipe_events` 的一行。 */
export interface PipeEventRow {
  readonly id: number;
  readonly ts: number;
  readonly day: string;
  readonly filter: string;
  readonly command_family: string;
  readonly workdir: string;
  readonly status: EventStatus;
  readonly reason: string;
  readonly original_tokens: number;
  readonly compressed_tokens: number;
  readonly saved_tokens: number;
  readonly original_bytes: number;
  readonly compressed_bytes: number;
  readonly latency_ms: number;
}

/** 按天计数的原因表（`dsh_pipe_skip_reasons` / `dsh_prefix_gate_reasons` 同形）。 */
export interface ReasonRow {
  readonly day: string;
  readonly reason: string;
  readonly count: number;
}

/** `dsh_prefix_days` 的一行。 */
export interface PrefixDayRow {
  readonly day: string;
  readonly bash_calls: number;
  readonly gate_skips: number;
  readonly attempts: number;
  readonly rewritten: number;
  readonly no_rewrite: number;
  readonly verify_rejected: number;
  readonly rewrite_error: number;
  readonly timeout: number;
  readonly latency_ms_sum: number;
  readonly latency_count: number;
}

/** `dsh_prefix_events` 的一行。 */
export interface PrefixEventRow {
  readonly id: number;
  readonly ts: number;
  readonly day: string;
  readonly reason: string;
  readonly command_family: string;
  readonly workdir: string;
  readonly latency_ms: number;
}

/** `dsh_potential_filters` 的一行。 */
export interface PotentialRow {
  readonly day: string;
  readonly filter: string;
  readonly matches: number;
}

/** `dsh_last_events` 的一行。 */
export interface LastEventRow {
  readonly id: number;
  readonly ts: number;
  readonly form: InsightsForm;
  readonly status: EventStatus;
  readonly reason: string;
  readonly command_family: string;
  readonly workdir: string;
  readonly filter: string | null;
  readonly size_bucket: SizeBucket;
}

/**
 * 统计库的读面与写面。
 *
 * 只暴露**原始行**：聚合、阈值、建议都住在 `lib/insights-service.ts`。把「按天求和」
 * 放进 store 的后果是同一套口径在 store 与 service 各有一份，改一处就两边不一致。
 */
export interface InsightsStore {
  readonly recordPipe: (input: PipeRecord) => void;
  readonly recordPrefix: (input: PrefixRecord) => void;
  readonly recordPotential: (day: string, filter: string) => void;
  readonly readPipeDays: (startDay: string) => readonly PipeDayRow[];
  readonly readPipeEvents: (startDay: string) => readonly PipeEventRow[];
  readonly readPipeSkipReasons: (startDay: string) => readonly ReasonRow[];
  readonly readPrefixDays: (startDay: string) => readonly PrefixDayRow[];
  readonly readPrefixGateReasons: (startDay: string) => readonly ReasonRow[];
  readonly readPotential: (startDay: string) => readonly PotentialRow[];
  readonly readLastEvents: (limit: number) => readonly LastEventRow[];
  /** 某个形态最近的一条。**按 form 过滤在 SQL 里**，不能先取一页再 `find`。 */
  readonly readLastEventOf: (form: InsightsForm) => LastEventRow | undefined;
  /** 明细最早的那一天（没有明细时 `null`）。只为取这一格，不要把整表读出来。 */
  readonly readPipeFirstDay: () => string | null;
  readonly readLegacy: () => LegacySnapshot;
  readonly reset: () => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** 缓冲到这么多条就立刻 flush：既不让内存无限长，也不让一次事务过大。 */
const FLUSH_THRESHOLD = 32;

/** 攒够多久 flush 一次（毫秒）。 */
const FLUSH_DELAY_MS = 1000;

/** 明细保留天数（spec：90 天）。 */
const RETENTION_DAYS = 90;

/** `dsh_last_events` 只留最近这么多条：它是「最近发生了什么」的窄面，不是历史。 */
const LAST_EVENTS_KEEP = 100;

/**
 * 缓冲的上限：写不进去时把没落盘的记录留着重试，但内存不能无限长。
 *
 * 取 `FLUSH_THRESHOLD` 的 32 倍（1024 条）：正常路径根本走不到这里——只有库被别处长时间
 * 占着或磁盘出错时才会堆起来。堆到上限就从最老的开始丢，丢的是「更早的统计」而不是
 * 「刚发生的事」。
 */
const BUFFER_LIMIT = 1024;

/**
 * busy_timeout：另一个进程正在写时最多等这么久，然后放弃这一批（读面仍以 DB 为准）。
 *
 * 从 1000 提到 5000 是因为**现在与 rtk 共用同一个库文件**：rtk 自己的写入器设的是 5000
 * （`src/core/tracking.rs:2083` 的 `PRAGMA busy_timeout=5000`）。我们比它短，就意味着在它
 * 写的时候我们先认输——用户看到的是「刚才跑的几条没统计上」，而原因完全不可见。
 */
const BUSY_TIMEOUT_MS = 5000;

/** 建表语句。全部 `IF NOT EXISTS`：多 host 并发打开时谁先建都成立。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS dsh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dsh_pipe_days (
  day TEXT PRIMARY KEY, bash_calls INTEGER NOT NULL DEFAULT 0, compressed INTEGER NOT NULL DEFAULT 0,
  original_tokens INTEGER NOT NULL DEFAULT 0, compressed_tokens INTEGER NOT NULL DEFAULT 0,
  saved_tokens INTEGER NOT NULL DEFAULT 0, latency_ms_sum INTEGER NOT NULL DEFAULT 0,
  latency_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dsh_pipe_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, filter TEXT NOT NULL,
  command_family TEXT NOT NULL, workdir TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
  original_tokens INTEGER NOT NULL DEFAULT 0, compressed_tokens INTEGER NOT NULL DEFAULT 0,
  saved_tokens INTEGER NOT NULL DEFAULT 0, original_bytes INTEGER NOT NULL DEFAULT 0,
  compressed_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dsh_pipe_skip_reasons (
  day TEXT NOT NULL, reason TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, reason)
);
CREATE TABLE IF NOT EXISTS dsh_prefix_days (
  day TEXT PRIMARY KEY, bash_calls INTEGER NOT NULL DEFAULT 0, gate_skips INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, rewritten INTEGER NOT NULL DEFAULT 0,
  no_rewrite INTEGER NOT NULL DEFAULT 0, verify_rejected INTEGER NOT NULL DEFAULT 0,
  rewrite_error INTEGER NOT NULL DEFAULT 0, timeout INTEGER NOT NULL DEFAULT 0,
  latency_ms_sum INTEGER NOT NULL DEFAULT 0, latency_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dsh_prefix_gate_reasons (
  day TEXT NOT NULL, reason TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, reason)
);
CREATE TABLE IF NOT EXISTS dsh_prefix_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, reason TEXT NOT NULL,
  command_family TEXT NOT NULL, workdir TEXT NOT NULL, latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dsh_potential_filters (
  day TEXT NOT NULL, filter TEXT NOT NULL, matches INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, filter)
);
CREATE TABLE IF NOT EXISTS dsh_last_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, form TEXT NOT NULL, status TEXT NOT NULL,
  reason TEXT NOT NULL, command_family TEXT NOT NULL, workdir TEXT NOT NULL,
  filter TEXT, size_bucket TEXT NOT NULL
);
`;

/** 明细表清单：清表与按天清理共用一份，少写一遍就会漏一张。 */
const DAY_TABLES = [
  "dsh_pipe_days",
  "dsh_pipe_events",
  "dsh_pipe_skip_reasons",
  "dsh_prefix_days",
  "dsh_prefix_gate_reasons",
  "dsh_prefix_events",
  "dsh_potential_filters",
] as const;

/** 重置时要清空的表（比 `DAY_TABLES` 多 `dsh_last_events`：它按 id 保留，不按天）。 */
const ALL_TABLES = [...DAY_TABLES, "dsh_last_events"] as const;

/** pipe 按天累加的三种形状。写成常量而不是拼串：SQL 是审计面，拼出来的读不清。 */
const SQL_PIPE_BASH_CALL = `INSERT INTO dsh_pipe_days(day,bash_calls) VALUES(?,1)
  ON CONFLICT(day) DO UPDATE SET bash_calls=dsh_pipe_days.bash_calls+1`;

const SQL_PIPE_SUCCESS = `INSERT INTO dsh_pipe_days(day,compressed,original_tokens,compressed_tokens,saved_tokens,latency_ms_sum,latency_count)
  VALUES(?,1,?,?,?,?,1)
  ON CONFLICT(day) DO UPDATE SET
    compressed=dsh_pipe_days.compressed+1,
    original_tokens=dsh_pipe_days.original_tokens+excluded.original_tokens,
    compressed_tokens=dsh_pipe_days.compressed_tokens+excluded.compressed_tokens,
    saved_tokens=dsh_pipe_days.saved_tokens+excluded.saved_tokens,
    latency_ms_sum=dsh_pipe_days.latency_ms_sum+excluded.latency_ms_sum,
    latency_count=dsh_pipe_days.latency_count+1`;

const SQL_PREFIX_BASH_CALL = `INSERT INTO dsh_prefix_days(day,bash_calls) VALUES(?,1)
  ON CONFLICT(day) DO UPDATE SET bash_calls=dsh_prefix_days.bash_calls+1`;

const SQL_PREFIX_ATTEMPT = `INSERT INTO dsh_prefix_days(day,attempts) VALUES(?,1)
  ON CONFLICT(day) DO UPDATE SET attempts=dsh_prefix_days.attempts+1`;

const SQL_PREFIX_GATE_SKIP = `INSERT INTO dsh_prefix_days(day,gate_skips) VALUES(?,1)
  ON CONFLICT(day) DO UPDATE SET gate_skips=dsh_prefix_days.gate_skips+1`;

const SQL_PREFIX_REWRITTEN = `INSERT INTO dsh_prefix_days(day,rewritten,latency_ms_sum,latency_count) VALUES(?,1,?,1)
  ON CONFLICT(day) DO UPDATE SET
    rewritten=dsh_prefix_days.rewritten+1,
    latency_ms_sum=dsh_prefix_days.latency_ms_sum+excluded.latency_ms_sum,
    latency_count=dsh_prefix_days.latency_count+1`;

const SQL_PIPE_EVENT_INSERT = `INSERT INTO dsh_pipe_events(ts,day,filter,command_family,workdir,status,reason,original_tokens,compressed_tokens,saved_tokens,original_bytes,compressed_bytes,latency_ms)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const SQL_PREFIX_EVENT_INSERT = `INSERT INTO dsh_prefix_events(ts,day,reason,command_family,workdir,latency_ms)
  VALUES(?,?,?,?,?,?)`;

const SQL_LAST_EVENT_INSERT = `INSERT INTO dsh_last_events(ts,form,status,reason,command_family,workdir,filter,size_bucket)
  VALUES(?,?,?,?,?,?,?,?)`;

/** 显式取写锁：多 host 同库时"先看再写"必须是原子的（deferred 会让两边都读到旧值）。 */
const BEGIN_IMMEDIATE = "BEGIN IMMEDIATE";

const SQL_POTENTIAL = `INSERT INTO dsh_potential_filters(day,filter,matches) VALUES(?,?,?)
  ON CONFLICT(day,filter) DO UPDATE SET matches=dsh_potential_filters.matches+excluded.matches`;

const sqlReasonCount = (table: "dsh_pipe_skip_reasons" | "dsh_prefix_gate_reasons"): string =>
  `INSERT INTO ${table}(day,reason,count) VALUES(?,?,1)
   ON CONFLICT(day,reason) DO UPDATE SET count=${table}.count+1`;

const sqlPrefixOutcome = (column: string): string =>
  `INSERT INTO dsh_prefix_days(day,${column},latency_ms_sum,latency_count) VALUES(?,1,?,1)
   ON CONFLICT(day) DO UPDATE SET
     ${column}=dsh_prefix_days.${column}+1,
     latency_ms_sum=dsh_prefix_days.latency_ms_sum+excluded.latency_ms_sum,
     latency_count=dsh_prefix_days.latency_count+1`;

/** prefix 四种「没改成」的结局各自落哪一列。查表而不是三元链：链一长就撞复杂度门。 */
const PREFIX_OUTCOME_COLUMNS = {
  "no-rewrite": "no_rewrite",
  "verify-rejected": "verify_rejected",
  "rewrite-error": "rewrite_error",
  timeout: "timeout",
} as const;

/** 缓冲里的一条（带形态标签，避免运行时靠 `kind` 前缀猜）。 */
type BufferItem =
  | { readonly form: "pipe"; readonly record: PipeRecord }
  | { readonly form: "prefix"; readonly record: PrefixRecord };

/**
 * 把未知异常压成一行可读文本（warn 通道用）。
 *
 * 两支都是真会发生的：`node:sqlite` 抛的是 `Error`，而桩、`JSON.parse` 之类的拒绝面
 * 可能是字符串或别的值——warn 文案里写 `[object Object]` 还不如写原文。
 * @param error - 任何被 throw 出来的东西
 * @returns 一行文本
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 一行 `dsh_meta`。 */
interface MetaRow {
  readonly value?: unknown;
}

/**
 * 读一个 dsh_meta 键。
 * @param db - 打开的库
 * @param key - 键名
 * @returns 值；缺键或形状不对时 `undefined`
 */
function readMeta(db: DatabaseFace, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM dsh_meta WHERE key = ?").get<MetaRow>(key);
  return typeof row?.value === "string" ? row.value : undefined;
}

/**
 * 写一个 dsh_meta 键（存在即覆盖）。
 * @param db - 打开的库
 * @param key - 键名
 * @param value - 值
 */
function writeMeta(db: DatabaseFace, key: string, value: string): void {
  db.prepare(
    "INSERT INTO dsh_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}

/**
 * 把 `dsh_meta.statsEpoch` 的字面量读成一个数。
 *
 * **非有限值一律当 0**：`Number("garbage")` 是 `NaN`，而 `NaN !== NaN` 恒成立——代际比较
 * 一旦拿到 `NaN`，每一批都会被判成「别的 host 重置过」整批丢弃，`reset()` 又会把
 * `String(NaN + 1)` = `"NaN"` 写回去，于是这个库从此再也存不下任何统计（实测复现过）。
 * 读不懂的字节只能当成「还没编号」，让写入方重新给它一个。
 * @param raw - `dsh_meta` 里的原文
 * @returns 代际号；缺键或读不懂读成 0
 */
function parseEpoch(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 读代际号。
 * @param db - 打开的库
 * @returns 代际号；缺键读成 0
 */
function epochOf(db: DatabaseFace): number {
  return parseEpoch(readMeta(db, "statsEpoch"));
}

/**
 * 预编译语句的懒缓存。
 *
 * 同一批 SQL 在一次 flush 里会重复执行（每行一条 INSERT），每次 `prepare` 都要重新解析，
 * 而 SQL 串在模块里是常量——缓存的是**解析结果**，不是数据。
 * @param db - 打开的库
 * @returns 按 SQL 串取语句
 */
function statementOf(db: DatabaseFace): (sql: string) => StatementFace {
  const cache = new Map<string, StatementFace>();
  return (sql) => {
    const hit = cache.get(sql);
    if (hit !== undefined) {
      return hit;
    }
    const made = db.prepare(sql);
    cache.set(sql, made);
    return made;
  };
}

/** flush 时需要的两件东西：库与语句缓存。 */
interface WriteContext {
  readonly db: DatabaseFace;
  readonly stmt: (sql: string) => StatementFace;
}

/**
 * 给某个原因计数加一。
 * @param ctx - 写上下文
 * @param table - 原因表名
 * @param day - 本地日
 * @param reason - 原因串
 */
function bumpReason(
  ctx: WriteContext,
  table: "dsh_pipe_skip_reasons" | "dsh_prefix_gate_reasons",
  day: string,
  reason: string,
): void {
  ctx.stmt(sqlReasonCount(table)).run(day, reason);
}

/**
 * 字节数落在哪个量级。
 * @param bytes - 原始字节数；未知时 `undefined`
 * @returns 量级桶名
 */
function sizeBucketOf(
  bytes: number | undefined,
): "tiny" | "small" | "medium" | "large" | "unknown" {
  if (bytes === undefined) {
    return "unknown";
  }
  if (bytes < 256) {
    return "tiny";
  }
  if (bytes < 4096) {
    return "small";
  }
  if (bytes < 65_536) {
    return "medium";
  }
  return "large";
}

/** `dsh_last_events` 的写入形状（id 由库给）。 */
interface LastEventWrite {
  readonly ts: number;
  readonly form: "prefix" | "pipe";
  readonly status: "compressed" | "skipped" | "rewritten" | "failed";
  readonly reason: string;
  readonly commandFamily: string;
  readonly workdir: string;
  readonly filter: string | null;
  readonly sizeBucket: string;
}

/**
 * 记一条「最近发生了什么」。
 * @param ctx - 写上下文
 * @param event - 事件
 */
function pushLastEvent(ctx: WriteContext, event: LastEventWrite): void {
  ctx
    .stmt(SQL_LAST_EVENT_INSERT)
    .run(
      event.ts,
      event.form,
      event.status,
      event.reason,
      event.commandFamily,
      event.workdir,
      event.filter,
      event.sizeBucket,
    );
}

/**
 * 落一条 pipe 成功记录。
 * @param ctx - 写上下文
 * @param day - 本地日
 * @param record - 记录
 */
function applyPipeSuccess(
  ctx: WriteContext,
  day: string,
  record: Extract<PipeRecord, { kind: "pipe-success" }>,
): void {
  ctx
    .stmt(SQL_PIPE_SUCCESS)
    .run(day, record.originalTokens, record.compressedTokens, record.savedTokens, record.latencyMs);
  ctx
    .stmt(SQL_PIPE_EVENT_INSERT)
    .run(
      record.ts,
      day,
      record.filter,
      record.commandFamily,
      record.workdir,
      "compressed",
      "success",
      record.originalTokens,
      record.compressedTokens,
      record.savedTokens,
      record.originalBytes,
      record.compressedBytes,
      record.latencyMs,
    );
  pushLastEvent(ctx, {
    ts: record.ts,
    form: "pipe",
    status: "compressed",
    reason: "success",
    commandFamily: record.commandFamily,
    workdir: record.workdir,
    filter: record.filter,
    sizeBucket: sizeBucketOf(record.originalBytes),
  });
}

/**
 * 落一条 pipe 跳过记录。
 *
 * 只有命中 filter 的候选才写事件行：没命中 filter 的候选如果也写，`GROUP BY filter`
 * 会多出一行空 filter，把「哪个 filter 最没用」这张表撑歪。
 * @param ctx - 写上下文
 * @param day - 本地日
 * @param record - 记录
 */
function applyPipeSkip(
  ctx: WriteContext,
  day: string,
  record: Extract<PipeRecord, { kind: "pipe-skip" }>,
): void {
  bumpReason(ctx, "dsh_pipe_skip_reasons", day, record.reason);
  if (record.filter !== undefined) {
    ctx
      .stmt(SQL_PIPE_EVENT_INSERT)
      .run(
        record.ts,
        day,
        record.filter,
        record.commandFamily,
        record.workdir,
        "skipped",
        record.reason,
        record.originalTokens ?? 0,
        0,
        0,
        record.originalBytes ?? 0,
        0,
        record.latencyMs ?? 0,
      );
  }
  pushLastEvent(ctx, {
    ts: record.ts,
    form: "pipe",
    status: "skipped",
    reason: record.reason,
    commandFamily: record.commandFamily,
    workdir: record.workdir,
    filter: record.filter ?? null,
    sizeBucket: sizeBucketOf(record.originalBytes),
  });
}

/**
 * 落一条 pipe 记录。
 * @param ctx - 写上下文
 * @param record - 记录
 */
function applyPipe(ctx: WriteContext, record: PipeRecord): void {
  if (record.kind === "potential") {
    ctx.stmt(SQL_POTENTIAL).run(record.day, record.filter, record.matches);
    return;
  }
  const day = localDayKey(record.ts);
  if (record.kind === "pipe-bash-call") {
    ctx.stmt(SQL_PIPE_BASH_CALL).run(day);
    return;
  }
  if (record.kind === "pipe-success") {
    applyPipeSuccess(ctx, day, record);
    return;
  }
  applyPipeSkip(ctx, day, record);
}

/**
 * 落一条 prefix 结局记录（四种「没改成」）。
 * @param ctx - 写上下文
 * @param day - 本地日
 * @param record - 记录
 */
function applyPrefixOutcome(
  ctx: WriteContext,
  day: string,
  record: Extract<PrefixRecord, { kind: "prefix-outcome" }>,
): void {
  ctx.stmt(sqlPrefixOutcome(PREFIX_OUTCOME_COLUMNS[record.outcome])).run(day, record.latencyMs);
  ctx
    .stmt(SQL_PREFIX_EVENT_INSERT)
    .run(record.ts, day, record.reason, record.commandFamily, record.workdir, record.latencyMs);
  pushLastEvent(ctx, {
    ts: record.ts,
    form: "prefix",
    // verify 拒绝与超时在面板上是「失败」；`no-rewrite` 是「这条命令 rtk 不认识」，
    // 它不是失败——所以只有前者记 failed。
    status: record.outcome === "no-rewrite" ? "skipped" : "failed",
    reason: record.reason,
    commandFamily: record.commandFamily,
    workdir: record.workdir,
    filter: null,
    sizeBucket: "unknown",
  });
}

/**
 * 落一条 prefix 记录。
 * @param ctx - 写上下文
 * @param record - 记录
 */
function applyPrefix(ctx: WriteContext, record: PrefixRecord): void {
  const day = localDayKey(record.ts);
  if (record.kind === "prefix-bash-call") {
    ctx.stmt(SQL_PREFIX_BASH_CALL).run(day);
    return;
  }
  if (record.kind === "prefix-attempt") {
    ctx.stmt(SQL_PREFIX_ATTEMPT).run(day);
    return;
  }
  if (record.kind === "prefix-rewritten") {
    ctx.stmt(SQL_PREFIX_REWRITTEN).run(day, record.latencyMs);
    pushLastEvent(ctx, {
      ts: record.ts,
      form: "prefix",
      status: "rewritten",
      reason: "rewritten",
      // 记的是**被改写的那几段**里的第一段，不是整条命令的家族：`commandFamilyOf(raw)` 在
      // `cd x && git diff && cargo test` 上会给出 `cd`——那一段根本没被改写。空表也真实存在
      // （rtk 改了一段但家族认不出来），`unknown` 是 `commandFamilyOf` 自己的兜底名。
      commandFamily: record.families[0] ?? "unknown",
      workdir: record.workdir,
      filter: null,
      sizeBucket: "unknown",
    });
    return;
  }
  if (record.kind === "prefix-gate-skip") {
    ctx.stmt(SQL_PREFIX_GATE_SKIP).run(day);
    bumpReason(ctx, "dsh_prefix_gate_reasons", day, record.reason);
    ctx
      .stmt(SQL_PREFIX_EVENT_INSERT)
      .run(record.ts, day, record.reason, record.commandFamily, record.workdir, 0);
    pushLastEvent(ctx, {
      ts: record.ts,
      form: "prefix",
      status: "skipped",
      reason: record.reason,
      commandFamily: record.commandFamily,
      workdir: record.workdir,
      filter: null,
      sizeBucket: "unknown",
    });
    return;
  }
  applyPrefixOutcome(ctx, day, record);
}

/**
 * 按形态分发一条缓冲记录。
 * @param ctx - 写上下文
 * @param item - 缓冲项
 */
function applyRecord(ctx: WriteContext, item: BufferItem): void {
  if (item.form === "pipe") {
    applyPipe(ctx, item.record);
    return;
  }
  applyPrefix(ctx, item.record);
}

/**
 * 清掉保留窗口之外的数据。
 *
 * **不在写事务里调用**：8 条 DELETE 里任一条抛（旧库 schema 差异、表被外部删掉）都会把
 * 同一事务里那批合法 INSERT 一起回滚——一次清理失败变成一次记账失败。这里改成 COMMIT 之后
 * 单独跑，失败只影响清理本身。
 * @param db - 打开的库
 * @param now - 当前毫秒时间戳
 */
function prune(db: DatabaseFace, now: number): void {
  const cutoff = windowStartDay(RETENTION_DAYS, now);
  for (const table of DAY_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(cutoff);
  }
  db.prepare(
    "DELETE FROM dsh_last_events WHERE id NOT IN (SELECT id FROM dsh_last_events ORDER BY id DESC LIMIT ?)",
  ).run(LAST_EVENTS_KEEP);
}

/**
 * 尽力回滚：BEGIN 都没成功时 ROLLBACK 也会抛，而这里再抛就把异常带回了工具热路径。
 * @param db - 打开的库
 */
function rollbackQuietly(db: DatabaseFace): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // 事务没开成（或连接已断）：这一批就此丢掉，读面仍以 DB 为准。
  }
}

/**
 * 把旧累计账本折成快照。
 *
 * token 与字节两套口径在旧账本里并存；有 token 就走 token（新界面按 token 展示），
 * 没有才退回字节。这与 `lib/stats-shape.ts` 里 `summarize` 的取舍同源。
 * @param legacy - 旧账本
 * @returns 快照
 */
function toLegacySnapshot(legacy: LegacyAccumulator): LegacySnapshot {
  const savedTokens =
    legacy.originalTokens > 0
      ? legacy.originalTokens - legacy.compressedTokens
      : legacy.originalBytes - legacy.compressedBytes;
  return {
    commands: legacy.commands,
    savedTokens,
    byForm: { prefix: legacy.byForm.prefix, pipe: legacy.byForm.pipe },
    byFilter: legacy.byFilter,
  };
}

/**
 * 一次性迁移旧账本。
 *
 * `BEGIN IMMEDIATE` 是这条的承重件：两个 host 同时启动时都看到没有 `legacyMigrated`，
 * 谁先拿到写锁谁写，后一个进来重读标志就跳过。用 `BEGIN`（deferred）则两边都能读到
 * 「还没迁移」，于是双写——第二个写会盖掉第一个，`commands` 就少了一半。
 * @param db - 打开的库
 * @param legacy - 旧账本
 */
function migrateLegacyOnce(db: DatabaseFace, legacy: LegacyAccumulator): void {
  db.exec(BEGIN_IMMEDIATE);
  try {
    if (readMeta(db, "legacyMigrated") !== "1") {
      writeMeta(db, "legacy", JSON.stringify(toLegacySnapshot(legacy)));
      writeMeta(db, "legacyMigrated", "1");
    }
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

/**
 * 解析旧账本快照。
 * @param raw - dsh_meta 里的 JSON 串
 * @returns 快照；缺键或坏 JSON 时 `null`
 */
function parseLegacy(raw: string | undefined): LegacySnapshot {
  if (raw === undefined) {
    return null;
  }
  try {
    // 走 schema 而不是 `JSON.parse(...) as LegacySnapshot`：落盘的是上一版写下的字节，
    // 断言只是把「它一定还是那个形状」当成事实；换成解析则旧字节读不出来的那几项各自回 null。
    const parsed = LegacySnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // 坏 JSON 不该让整页打不开：迁移是附加面，读不出来就当没有旧账本。
    return null;
  }
}

/**
 * 装配只读的那一组方法。
 *
 * 从 `createStore` 里拆出来不是为了让文件好看：`max-lines-per-function` 卡在 120 行，而这个
 * 函数原本 130 行——把读面挪出来之后，剩下的写面（缓冲、代际、事务、幂等关闭）正好是一个
 * 能一眼看完的单元。两者共享同一个 `db`，拆开不影响语义。
 * @param db - 打开的库
 * @returns 只读方法与 reset 之外的读面
 */
function readersOf(
  db: DatabaseFace,
): Pick<
  InsightsStore,
  | "readPipeDays"
  | "readPipeEvents"
  | "readPipeSkipReasons"
  | "readPrefixDays"
  | "readPrefixGateReasons"
  | "readPotential"
  | "readLastEvents"
  | "readLastEventOf"
  | "readPipeFirstDay"
  | "readLegacy"
> {
  return {
    readPipeDays: (startDay) =>
      db
        .prepare("SELECT * FROM dsh_pipe_days WHERE day >= ? ORDER BY day")
        .all<PipeDayRow>(startDay),
    readPipeEvents: (startDay) =>
      db
        .prepare("SELECT * FROM dsh_pipe_events WHERE day >= ? ORDER BY ts")
        .all<PipeEventRow>(startDay),
    readPipeSkipReasons: (startDay) =>
      db
        .prepare("SELECT * FROM dsh_pipe_skip_reasons WHERE day >= ? ORDER BY count DESC")
        .all<ReasonRow>(startDay),
    readPrefixDays: (startDay) =>
      db
        .prepare("SELECT * FROM dsh_prefix_days WHERE day >= ? ORDER BY day")
        .all<PrefixDayRow>(startDay),
    readPrefixGateReasons: (startDay) =>
      db
        .prepare("SELECT * FROM dsh_prefix_gate_reasons WHERE day >= ? ORDER BY count DESC")
        .all<ReasonRow>(startDay),
    readPotential: (startDay) =>
      db
        .prepare("SELECT * FROM dsh_potential_filters WHERE day >= ? ORDER BY matches DESC")
        .all<PotentialRow>(startDay),
    readLastEvents: (limit) =>
      db.prepare("SELECT * FROM dsh_last_events ORDER BY id DESC LIMIT ?").all<LastEventRow>(limit),
    // 按形态取最近一条：`readLastEvents(20)` 再 `find(form)` 在两种形态同时开启时会落空
    // ——最近 20 条完全可能全属于另一形态，本形态于显示「窗口内一次都没有」，而那是错的。
    readLastEventOf: (form) =>
      db
        .prepare("SELECT * FROM dsh_last_events WHERE form = ? ORDER BY id DESC LIMIT 1")
        .get<LastEventRow>(form),
    readPipeFirstDay: () => {
      const row = db
        .prepare("SELECT day FROM dsh_pipe_days ORDER BY day LIMIT 1")
        .get<{ readonly day: string }>();
      return row?.day ?? null;
    },
    readLegacy: () => parseLegacy(readMeta(db, "legacy")),
  };
}

/**
 * 清空九张表并抬一代代际号。
 *
 * 单独成函数只为一件事：`createStore` 已经贴着「单函数 120 行」的天花板，而这段事务体
 * 是它内部最自成一块的部分——它只碰 `db`，不碰缓冲、定时器与闭包状态。
 * @param db - 打开的库
 * @returns 提交成功时的新代际号；回滚时 `undefined`
 */
function resetTables(db: DatabaseFace): number | undefined {
  let next: number | undefined;
  try {
    db.exec(BEGIN_IMMEDIATE);
    next = epochOf(db) + 1;
    writeMeta(db, "statsEpoch", String(next));
    for (const table of ALL_TABLES) {
      db.exec(`DELETE FROM ${table}`);
    }
    // 迁移快照也在「统计」里：只清九张表会让界面在清零之后继续显示旧账本那一栏
    // （`legacy` 就是从这一行读的）。`schemaVersion` / `statsEpoch` 是库自己的元数据，
    // 清了等于把自己也重置掉，所以只删这一个键。
    db.exec("DELETE FROM dsh_meta WHERE key = 'legacy'");
    db.exec("COMMIT");
  } catch {
    rollbackQuietly(db);
    next = undefined;
  }
  return next;
}

/**
 * 在已打开的库上装配 store。
 * @param db - 打开的库
 * @param now - 时钟
 * @returns store
 */
function createStore(
  db: DatabaseFace,
  now: () => number,
  warn?: (line: string) => void,
): InsightsStore {
  const ctx: WriteContext = { db, stmt: statementOf(db) };
  let buffer: BufferItem[] = [];
  let epoch = epochOf(db);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // `close` 必须幂等：它既可能被显式调用一次（用例里先关再重开），也可能被宿主的
  // 卸载 disposer 再调一次。第二次 `db.close()` 抛的是 `database is not open`，
  // 而那时已经没有任何工作要做——把「重复释放」变成异常只会让卸载路径炸在清理阶段。
  let closed = false;
  // 一次故障只播报一次：写不进去往往连着几十批，每批一行会把日志刷满，而它要说明的事情
  // 只有一件（「统计写不进这个库」）。成功后复位，下一次故障还会重新播报。
  let warnedWrite = false;

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /**
   * 把缓冲写进库。
   *
   * 返回 `true` 表示这一批没写成、需要再排一次（写锁被占是暂时的，rtk 自己也写这个文件）。
   * **由调用方决定重试**：`flushNow` 自己不回头调 `schedule`——那样两个函数就互为前向引用，
   * 而「先声明后使用」在这条链上做不到（定时器要 `flushNow`，重试要 `schedule`）。
   */
  const flushNow = (): boolean => {
    // 关库之后定时器还可能响一次（`unref` 只保证它不钉住进程，不保证它被取消）。
    // 这时 `epochOf` 会在已关闭的连接上抛——而它一旦抛在 `try` 之外，就是一条
    // uncaughtException，把整个宿主带下去。统计是附加面，绝不能有这个后果。
    if (closed || buffer.length === 0) {
      return false;
    }
    const batch = buffer;
    buffer = [];
    try {
      // **先取写锁再读代际**：锁外读与 BEGIN 之间，另一个 host 的 `reset()` 可能刚好提交，
      // 那样读到的是旧号，本批属于旧代际的行会写回一份已经被清掉的统计。取锁之后重读，
      // 「比较代际」与「写入」就落在同一个事务里，中间没有别人插得进来的缝。
      db.exec(BEGIN_IMMEDIATE);
      const dbEpoch = epochOf(db);
      if (dbEpoch !== epoch) {
        // 别的 host 重置过：本缓冲里的行属于上一个代际，写回去等于让被清掉的统计复活。
        db.exec("ROLLBACK");
        epoch = dbEpoch;
        return false;
      }
      for (const item of batch) {
        applyRecord(ctx, item);
      }
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      // **没写成的这一批放回缓冲，等下一趟**：写锁被占是暂时的（rtk 自己也写这个文件），
      // 而丢掉就是永久——用户看到的是「刚才那几条没统计上」，且没有任何提示。
      // 上限兜住「库一直写不进去」的极端情况：超出的从最老的开始丢，内存不无限长。
      buffer = [...batch, ...buffer].slice(-BUFFER_LIMIT);
      if (!warnedWrite) {
        warnedWrite = true;
        warn?.(
          `[rtk] insights: cannot write the stats tables (${describeError(error)}); keeping up to ${String(BUFFER_LIMIT)} records in memory and retrying`,
        );
      }
      return true;
    }
    // 写成了：清理与播报状态都归位。清理**在事务之后**单独跑（见 `prune` 的注释），
    // 它失败不影响这一批已经落盘的数据。
    warnedWrite = false;
    try {
      prune(db, now());
    } catch (error) {
      warn?.(`[rtk] insights: cannot prune the stats tables (${describeError(error)})`);
    }
    return false;
  };

  const schedule = (delayMs: number = FLUSH_DELAY_MS): void => {
    if (closed || timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      // 写锁没拿到就地再排一趟：不排的话这一批要等下一条记录才动，而用户往往正好在这时
      // 打开统计页，看到的是一份缺了最近几条的账。
      if (flushNow()) {
        schedule(FLUSH_DELAY_MS);
      }
    }, delayMs);
    // 不让统计的定时器把宿主进程钉住：它只是「攒一会儿再写」，进程要退就该退。
    timer.unref();
  };

  const push = (item: BufferItem): void => {
    // 关库之后的记录直接丢：缓冲里留着它们只会在下一次 flush 时撞上已关闭的连接，
    // 而那时已经没有人会来读这份数据了。
    if (closed) {
      return;
    }
    buffer.push(item);
    // **攒够也走定时器，不在调用栈里写库。** `push` 的调用方是 bash 工具的执行路径，
    // 而一次 `BEGIN IMMEDIATE` + 5s busy_timeout 就是「工具调用被统计拖住最多五秒」——
    // 与文件头「热路径不落盘」直接相反。`FLUSH_DELAY_MS` 用 `setImmediate` 级别的 0 延迟
    // 由 `schedule(0)` 表达：条数够了就尽快写，但仍然出这个调用栈。
    if (buffer.length >= FLUSH_THRESHOLD) {
      stopTimer();
      schedule(0);
      return;
    }
    schedule(FLUSH_DELAY_MS);
  };

  return {
    recordPipe: (input) => {
      push({ form: "pipe", record: input });
    },
    recordPrefix: (input) => {
      push({ form: "prefix", record: input });
    },
    recordPotential: (day, filter) => {
      push({ form: "pipe", record: { kind: "potential", ts: now(), day, filter, matches: 1 } });
    },
    ...readersOf(db),
    reset: () => {
      buffer = [];
      stopTimer();
      if (closed) {
        return Promise.resolve();
      }
      const next = resetTables(db);
      // **提交之后才前进内存里的代际**（`resetTables` 内部保证 COMMIT 先返回）：COMMIT 失败
      // 会回滚、库里还是旧号，而内存先跑一步的话，此后每一批合法记录都会被判成「别的 host
      // 重置过」整批丢掉——一次失败的清零会让统计永久停摆，且现象与「重置成功但没新数据」
      // 一模一样。`resetTables` 返回 `undefined` 表示这次没抬代际（回滚了）。
      if (next !== undefined) {
        epoch = next;
      }
      return Promise.resolve();
    },
    flush: () => {
      flushNow();
      return Promise.resolve();
    },
    close: () => {
      if (closed) {
        return Promise.resolve();
      }
      // 顺序是承重的：先把缓冲写掉，再竖 `closed` 旗。反过来（先竖旗）会让 `flushNow` 的
      // 首句早退，缓冲区里最后那几条记录就永远不会落盘——而它们正是「刚跑完的那条命令」。
      stopTimer();
      flushNow();
      closed = true;
      closeQuietly(db);
      return Promise.resolve();
    },
  };
}

/**
 * 在打开成功的库上建 schema、补 dsh_meta、迁移旧账本，然后装配 store。
 *
 * 单独一段是为了让 `openInsightsStore` 只有一个出口：它的两条路径（成功/失败）都要返回
 * `InsightsStore | undefined`，写成 try 里 return 值、catch 里 return undefined 会撞上
 * 「有一半路径没有返回值」的判据。抛出的异常交给调用点统一处置。
 * @param db - 已打开的库
 * @param options - 入参
 * @returns store
 */
function prepareStore(db: DatabaseFace, options: OpenInsightsStoreOptions): InsightsStore {
  // WAL 是 rtk 自己给这个库设的模式（`src/core/tracking.rs:2083`），这里再设一次是幂等的：
  // 共用一个文件之后，两个进程的连接参数必须一致，否则我们会在它写的时候拿到 SQLITE_BUSY。
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${String(BUSY_TIMEOUT_MS)};`);
  db.exec(SCHEMA);
  if (readMeta(db, "schemaVersion") === undefined) {
    writeMeta(db, "schemaVersion", "1");
  }
  if (readMeta(db, "statsEpoch") === undefined) {
    writeMeta(db, "statsEpoch", "0");
  }
  if (options.legacy !== null && options.legacy !== undefined) {
    migrateLegacyOnce(db, options.legacy);
  }
  return createStore(db, options.now ?? Date.now, options.warn);
}

/**
 * 确保库文件的父目录存在。
 *
 * **为什么要在这一层做**：目录原本只由 prefix 形态的装配（`prepareLedgerDir`）建，而那条
 * 路径有自己的一串门禁——rtk 不在 PATH 时整层不装。于是「只开 pipe 形态」
 * 或「跑了 pipe 但没跑过 prefix」的机器上，`$DSH_HOME/rtk/` 从来没被创建过，`openSqlite`
 * 会因为没有父目录而失败：pipe 侧的统计本来能记，却整块报不可用。建目录放在开库之前，
 * 与谁先跑无关。
 *
 * 失败不抛：建不出来就是打不开，`openInsightsStore` 那一层会按「本次没有统计」处置。
 * 用异步版本：这个函数本来就在 `openInsightsStore` 的 await 链上，没有「必须立刻知道结果」
 * 的时序要求（那条要求属于装配期的 `ensureRtkDir`，它要在第一次 spawn 之前把目录备好）。
 * @param file - 库文件路径
 */
async function ensureParentDir(file: string): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    // 只读 home、父路径是文件……都在这里静止；开库会给出同样的结论。
  }
}

/**
 * 打开统计库。
 *
 * 任何一步失败都返回 `undefined`（不抛）：统计是附加面，压缩本身不能因为它失效。
 * @param options - 入参
 * @returns store；打不开时 `undefined`
 */
export async function openInsightsStore(
  options: OpenInsightsStoreOptions,
): Promise<InsightsStore | undefined> {
  let db: DatabaseFace | undefined;
  let store: InsightsStore | undefined;
  try {
    await ensureParentDir(options.dbPath);
    // 用真实的 `import("node:sqlite")` 打开：`ImportSqlite` 的形状与 `node:sqlite` 的真实
    // 导出兼容（参数类型与真实 `SQLInputValue` 等价的联合，不是 `unknown`），所以这里不需要
    // 任何断言。理由写在 `lib/sqlite-face.ts` 的文件头。
    db = await openSqlite(options.dbPath, { timeout: BUSY_TIMEOUT_MS }, options.importSqlite);
    store = prepareStore(db, options);
  } catch (error) {
    // 打不开的每一种成因（没有 node:sqlite、目录不可写、文件损坏、迁移失败）
    // 在这里是同一种处置：本次会话没有统计，压缩照常。**但要留一行**：这里是整条统计链
    // 唯一知道自己为什么没起来的地方，静默退场会让页面永远「不可用」而日志一片空白。
    options.warn?.(`[rtk] insights: cannot open ${options.dbPath} (${describeError(error)})`);
    store = undefined;
  }
  if (store === undefined) {
    // 失败时收拾已经打开的那一半：不关的话「schema 建到一半失败」会把句柄留到进程结束。
    // 成功时不关——句柄由 store 的 close 负责。
    closeQuietly(db);
  }
  return store;
}
