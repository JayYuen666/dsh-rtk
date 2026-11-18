/**
 * 账本的读取侧：只读聚合、沙箱登记与清零。账本是 dsh 自己的那一份
 * （`$DSH_HOME/rtk/history.db`，位置由 `lib/rtk-paths.ts` 算），所以这里读到的每一行都来自
 * dsh 会话——用户在自己终端里跑的 rtk 写在另一份全局账本里，不在这条链上。
 *
 * **位置解析住在 `lib/rtk-paths.ts`**：这里只剩「拿到一个路径之后做什么」。分开的理由是路径要
 * 三处共用（读面、写面、沙箱登记），而「怎么写 SQL」只属于读面。
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";

import type { InsightsRequest } from "./insights-shape.ts";
import { physicalDirOf } from "./rtk-paths.ts";
import { closeQuietly, errorFieldOf, openSqlite } from "./sqlite-face.ts";
import type { DatabaseFace, ImportSqlite } from "./sqlite-face.ts";
import { windowStartDay } from "./time-buckets.ts";

export type { DatabaseFace, SqliteModule } from "./sqlite-face.ts";

/** 一天的分桶行。 */
export interface LedgerDayRow {
  readonly day: string;
  /**
   * 当天写进账本的命令条数。
   *
   * 当前**没有消费者**：页面上的「改写次数」来自插件自己的日表（它才知道被改写的是哪一次），
   * 账本这边只用 `input` / `output` / `saved`。留着这一格是因为它是那条 SQL 的 `COUNT(*)`，
   * 而且排查「rtk 到底记了几行」时要用——但它不是界面上的任何一个数字。
   */
  readonly commands: number;
  readonly input: number;
  readonly output: number;
  readonly saved: number;
}

/** 按原始命令分组的行。 */
export interface LedgerCommandRow {
  readonly original_cmd: string;
  /**
   * rtk 记下的改写后命令行。
   *
   * 读面只用 `original_cmd` 折家族：`rtk_cmd` 恒为 `rtk <original>`，拿它折出来是同一个答案，
   * 而它会让「按家族分组」这件事多一个可能与 `original_cmd` 不一致的输入。留着是因为这条
   * SQL 的 `GROUP BY` 本来就带着它（同一个命令行 + 同一种改写才该合成一行）。
   */
  readonly rtk_cmd: string;
  readonly commands: number;
  readonly input: number;
  readonly output: number;
  readonly saved: number;
}

/** 按项目目录分组的行。 */
export interface LedgerWorkdirRow {
  readonly project_path: string;
  readonly commands: number;
  readonly input: number;
  readonly saved: number;
}

/**
 * 只读聚合的回执。
 *
 * `readonly` 不在这里：它是「沙箱不允许写」这件事的投影，由 service 层合成（ledger 只关心库
 * 本身读出来是什么样）。
 */
export interface PrefixLedgerResult {
  readonly availability: "ok" | "missing" | "unreadable" | "schema";
  readonly days: readonly LedgerDayRow[];
  readonly commands: readonly LedgerCommandRow[];
  readonly workdirs: readonly LedgerWorkdirRow[];
  readonly dataStart: string | null;
}

/** 账本端口：读一份聚合、清一次账。 */
export interface RtkLedger {
  readonly read: (request: InsightsRequest) => Promise<PrefixLedgerResult>;
  readonly clear: () => Promise<void>;
}

/**
 * 明细命令行的取样上限。
 *
 * 原先 100，且 `ORDER BY saved DESC`——于是「按命令家族」那张表只统计到节省量最高的 100 条
 * 命令行，低收益的长尾被切掉：家族合计既对不上 `commands` 的总行数，也解释了为什么「某家族
 * 只省了 3%」这种东西永远不出现（那些行根本没进来）。2000 是「30 天 × 每天几十条」的量级，
 * 再大就真要分页了；这里只取 `original_cmd / rtk_cmd / saved` 三列，2000 行不到 200 KB。
 */
const TOP_COMMANDS = 2000;
/** 工作目录那张榜真的是「看前几名」：目录数量天然有限，30 天里极少超过几十个。 */
const TOP_WORKDIRS = 20;
/** 写事务开法：与 store 同一句，`BEGIN`（deferred）在并发下会先读后写、可能中途升级失败。 */
const BEGIN_IMMEDIATE = "BEGIN IMMEDIATE";
/**
 * 打开库的等待上限（毫秒）。
 *
 * 从 1000 提到 5000 是因为**现在与 rtk 共用同一个文件**：rtk 自己的写入器设的是 5000
 * （`src/core/tracking.rs:2083` 的 `PRAGMA busy_timeout=5000`），我们比它短就等于在它写的时候
 * 先认输。读面读不到会报 unreadable，页面上就是「数据没有了」——比多等四秒糟得多。
 */
const BUSY_TIMEOUT_MS = 5000;
/**
 * 读面的等待上限（毫秒）。
 *
 * 与写面分开：`node:sqlite` 是同步 API，`busy_timeout` 期间**整个宿主主线程被按住**。读面由
 * 统计页每 5 秒轮询一次，用 5000 的话「rtk 正在写」就会变成「页面卡五秒」。500 足够覆盖一次
 * 常规写入（实测单行 INSERT 在毫秒级），读不到就如实报 unreadable，比卡住强。
 */
const READ_BUSY_TIMEOUT_MS = 500;
/** 「表/列不存在」的错误串判据：rtk 还没建过表，或库来自更老的 schema。 */
const NO_SUCH_THING = /no such (?:table|column)/u;
/** SQLite 的错误码（本层只认这一个）。 */
const SQLITE_ERROR = "ERR_SQLITE_ERROR";

/** 空回执（四种非 ok 态共用同一份骨架）。 */
function emptyResult(availability: PrefixLedgerResult["availability"]): PrefixLedgerResult {
  return { availability, days: [], commands: [], workdirs: [], dataStart: null };
}

/**
 * 建目录并拒绝符号链接。
 *
 * 拒绝链接这一条不是因为「安全审计」，而是因为库文件会被 rtk 与插件两个进程写：目录是指向
 * 别处的链接时，这份「账本」其实落在用户没预期的地方，而清零会照着它删。
 * @param dir - 候选目录
 * @returns 是否可用（已存在且是真目录，或刚建出来）
 */
export function ensureRtkDir(dir: string): boolean {
  // 同步是刻意的：装配期要立刻知道「这个目录能不能用」，异步版本会让 registerWritableRoot
  // 与第一次 spawn 抢同一段时间窗。三次调用都是一次性的 O(1) 元数据查询，不读文件内容。
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stats = lstatSync(dir);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** 沙箱策略里本插件只用到的一个方法。 */
interface WritableRootPolicy {
  readonly registerWritableRoot: (session: unknown, dir: string) => () => void;
}

function isWritableRootPolicy(value: unknown): value is WritableRootPolicy {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.has(value, "registerWritableRoot") &&
    typeof Reflect.get(value, "registerWritableRoot") === "function"
  );
}

/** 兜底退场时交回的空 disposer。具名而不是字面量：`() => {}` 会被 lint 判空函数。 */
const NOOP_DISPOSER = (): void => {
  // 登记失败时没有东西可回收；调用方只要求交回一个能调的 disposer。
};

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 让沙箱允许 rtk 往账本目录里写。
 *
 * **为什么这件事必须做**：账本在 `$DSH_HOME/rtk/`（默认 `~/.dsh/rtk/`），而 `workspace-write`
 * 沙箱只允许写工作目录。不登记的话 rtk 记账会 EACCES 静默失败——用户看到的 Insights 页永远是
 * 空的，且没有任何报错。
 *
 * 结构判定而不是 `as` 断言：这是宿主的可选服务，缺席时（只读沙箱、老版本宿主）这里安静退场，
 * 前缀改写照旧、只是 rtk 写不进库——读面会如实报不可用。
 */
export function registerRtkWritableRoot(
  ctx: {
    /** 服务读取口。**可选**：`HostContext` 把它声明成可选（异常 ctx 与测试替身可能没有）。 */
    readonly get?: ((name: string) => unknown) | undefined;
    readonly effect: (run: () => () => void, label: string) => void;
  },
  agent: { readonly session: unknown },
  dir: string,
  warn?: (line: string) => void,
): void {
  const policy = ctx.get?.("sandboxPolicy");
  if (!isWritableRootPolicy(policy)) {
    return;
  }
  // 必须先折成物理路径，且**登记失败绝不能冒泡**。
  //
  // 宿主的 `additionalRoot()`（dsh-sandbox）用 `realpathSync` 与原文比：两者不等就抛
  // `SANDBOX_INVALID_ROOT`（`use the physical directory path …; symlinked grants are not supported`）。
  // macOS 上 `/tmp` 就是 `/private/tmp`，于是 `DSH_HOME=/tmp/...` 时那次登记必抛；而这一行
  // 在工具的 execute 路径上，异常会变成模型看到的**工具失败**——一次记账附加项的登记错误
  // 把整条 bash 调用废掉，真机实测如此。所以这里两件事一起做：折物理路径，再包一层兜底，
  // 最坏情况只是 rtk 写不进库、Insights 页报不可用，命令照跑。
  ctx.effect(() => {
    try {
      return policy.registerWritableRoot(agent.session, physicalDirOf(dir));
    } catch (error) {
      warn?.(
        `[rtk] prefix: cannot grant ${dir} to the sandbox (${describeError(error)}); rtk bookkeeping will fail silently`,
      );
      return NOOP_DISPOSER;
    }
  }, "rtk: tracking dir");
}

/**
 * `YYYY-MM-DD`（本地日）→ rtk 写下的那种 RFC3339 UTC 串。
 *
 * 取本地零点再转 UTC：用户说的「近 7 天」是从他当地的零点算的，而库里存的是 UTC 时刻。
 * 格式对齐 rtk 的 `Utc::now().to_rfc3339()`：秒级 + `+00:00` 后缀（它用 `+00:00` 而不是
 * `Z`，这里跟它一致，免得比较时因为后缀不同而错位）。
 * @param day - `YYYY-MM-DD`
 * @returns `YYYY-MM-DDTHH:MM:SS+00:00`
 */
function toRfc3339Utc(day: string): string {
  /* v8 ignore next —— 调用点的入参是 `windowStartDay(...)` 的产物，恒为 `YYYY-MM-DD`；
     三个 `?? ` 是 `noUncheckedIndexedAccess` 下的类型位防御，不是能发生的分支。 */
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const local = new Date(year, month - 1, date);
  const iso = local.toISOString();
  return `${iso.slice(0, 19)}+00:00`;
}

/**
 * 只读聚合 rtk 账本。
 *
 * 四种非 ok 态的判据都来自实测：
 * - **missing** 分两种：库文件不存在（rtk 从没跑过），或库在但没有 `commands` 表（同一个意思，
 *   只是我们自己先建了 `dsh_*` 表把文件造出来了——不能因此报成「读坏了」）。
 * - **schema** 是 `ERR_SQLITE_ERROR` 且消息里有 `no such table|column`：库来自更老的 schema。
 * - **unreadable** 是其余一切（权限、损坏、busy 超时）。
 * - 时间窗先把边界折成 rtk 写下的 RFC3339 UTC 串、再直接比较 `timestamp` 列（见调用处的
 *   注释）：这样 `WHERE` 上是普通比较、能走索引，而分桶那一步照样用
 *   `date(timestamp,'localtime')`——分桶必须按本地日，边界也要按本地零点算，两者不矛盾。
 * @param dbPath - `history.db` 的路径
 * @param request - 时间窗
 * @param importSqlite - 测试注入口
 * @param warn - 读失败时的诊断口（`unreadable` 的成因不止一种，别让它零线索）
 * @returns 聚合回执
 */
export async function readPrefixLedger(
  dbPath: string,
  request: InsightsRequest,
  importSqlite: ImportSqlite = () => import("node:sqlite"),
  warn?: (line: string) => void,
): Promise<PrefixLedgerResult> {
  if (!existsSync(dbPath)) {
    return emptyResult("missing");
  }
  let db: DatabaseFace | undefined;
  try {
    db = await openSqlite(dbPath, { readOnly: true, timeout: READ_BUSY_TIMEOUT_MS }, importSqlite);
    const present = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'commands'")
      .get<{ readonly name: string }>();
    if (present === undefined) {
      return emptyResult("missing");
    }
    // 窗口起点先在 JS 里算成 rtk 写下的那种时间串（`2026-11-18T00:30:56.951789+00:00`），
    // 再用列上的普通比较。**不要写 `WHERE date(timestamp,'localtime') >= ?`**：那等于对每一行
    // 调用一次 `date()`，而 `timestamp` 上没有索引可用（rtk 建表时没建），于是每次刷新都全表扫。
    // 字符串比较的顺序与 UTC 时刻一致（同为 `YYYY-MM-DDTHH:MM:SS` 前缀），所以这样比是准的；
    // 唯一代价是零时区的边界按 UTC 算——窗口起点本来就是「N 天前的本地零点再折成 UTC」。
    const start = toRfc3339Utc(windowStartDay(request.rangeDays, Date.now()));
    const days = db
      .prepare(
        `SELECT date(timestamp, 'localtime') AS day, COUNT(*) AS commands,
           SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(saved_tokens) AS saved
         FROM commands WHERE timestamp >= ?
         GROUP BY day ORDER BY day`,
      )
      .all<LedgerDayRow>(start);
    const commands = db
      .prepare(
        `SELECT original_cmd, rtk_cmd, COUNT(*) AS commands,
           SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(saved_tokens) AS saved
         FROM commands WHERE timestamp >= ?
         GROUP BY original_cmd, rtk_cmd ORDER BY saved DESC LIMIT ?`,
      )
      .all<LedgerCommandRow>(start, TOP_COMMANDS);
    const workdirs = db
      .prepare(
        `SELECT project_path, COUNT(*) AS commands, SUM(input_tokens) AS input, SUM(saved_tokens) AS saved
         FROM commands WHERE timestamp >= ?
         GROUP BY project_path ORDER BY saved DESC LIMIT ?`,
      )
      .all<LedgerWorkdirRow>(start, TOP_WORKDIRS);
    const first = db
      .prepare("SELECT MIN(timestamp) AS first FROM commands")
      .get<{ readonly first: string | null }>();
    return { availability: "ok", days, commands, workdirs, dataStart: first?.first ?? null };
  } catch (error) {
    const code = errorFieldOf(error, "code");
    const message = errorFieldOf(error, "message");
    const schema = code === SQLITE_ERROR && NO_SUCH_THING.test(message);
    if (!schema) {
      // `unreadable` 把权限不足、文件损坏、busy 超时三种成因折成同一种处置，但它们要修的地方
      // 完全不同。这条读面每 5 秒轮询一次、故障完全静默，所以至少留一行——没有它，界面上那句
      // 「不可用」就是零线索。`errorFieldOf` 取不到时给空串，这里换成 `no-code` 才看得出
      // 「不是 SQLite 的错误码」与「有个没记下来的错误码」的区别。
      warn?.(
        `[rtk] prefix: cannot read the ledger (${code === "" ? "no-code" : code}: ${message})`,
      );
    }
    return emptyResult(schema ? "schema" : "unreadable");
  } finally {
    closeQuietly(db);
  }
}

/**
 * rtk 自己那几本账：`rtk gain --reset` 清的正是这四张（`src/core/tracking.rs:968` 的
 * `reset_all()`；`classifier_cache` 是缓存不是账，也一起清）。
 *
 * 我们不清 `parse_failures` 之外的内部表就会留下「清零之后 total 是 0、故障数还是 306」这种
 * 自相矛盾的页面，所以照它的清单来。
 */
const RTK_TABLES = [
  "commands",
  "parse_failures",
  "hook_decisions",
  "engine_attribution",
  "classifier_cache",
] as const;

/**
 * 清空 rtk 账本。
 *
 * **这是不可撤销的删除**，调用它的 UI 必须已经做过二次确认。删的是 rtk 自己的那五张表；
 * 插件的 `dsh_*` 表由 store 的 `reset()` 清（两边各管自己那张纸，谁都不猜对方有哪些表）。
 *
 * 表可能不存在（rtk 从没跑过、或版本更老），所以逐张尝试 DELETE 再统一提交——**同一个
 * 事务里**：半清的状态（`commands` 空了、`engine_attribution` 还在）比彻底失败更难解释，
 * 而用户点的是「清零」，不是「清一部分」。
 *
 * 库文件本身若是符号链接就直接不碰：`DELETE` 会顺着链接删掉目标库里的行，而那个目标可能是
 * 用户另指的真实账本。这里只认普通文件。
 * @param dbPath - `history.db` 的路径
 * @param importSqlite - 测试注入口
 * @param warn - 清不掉时的诊断口
 */
export async function clearRtkCommands(
  dbPath: string,
  importSqlite: ImportSqlite = () => import("node:sqlite"),
  warn?: (line: string) => void,
): Promise<void> {
  if (!existsSync(dbPath)) {
    return;
  }
  try {
    if (lstatSync(dbPath).isSymbolicLink()) {
      warn?.(
        `[rtk] insights: refusing to clear ${dbPath}: it is a symbolic link, and clearing it would delete rows from whatever it points at`,
      );
      return;
    }
  } catch (error) {
    /* v8 ignore next —— `existsSync` 刚说这个文件在，紧接着 `lstat` 才失败，只可能是两次
       系统调用之间它被删掉或被改了权限。不 `return`：这里只是「查不出是不是链接」，
       接下去开库会给出同一个结论并走同一条 `cannot clear` 播报——多一条出口只会多一条
       没有真实触发条件的路径。 */
    warn?.(`[rtk] insights: cannot inspect ${dbPath} (${describeError(error)})`);
  }
  let db: DatabaseFace | undefined;
  try {
    db = await openSqlite(dbPath, { timeout: BUSY_TIMEOUT_MS }, importSqlite);
    db.exec(BEGIN_IMMEDIATE);
    for (const table of RTK_TABLES) {
      try {
        db.exec(`DELETE FROM ${table}`);
      } catch {
        // 这张表不存在（更老的 schema）：跳过它，其余照清。
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    warn?.(`[rtk] insights: cannot clear rtk's ledger tables (${describeError(error)})`);
  } finally {
    closeQuietly(db);
  }
}

/** 把两个函数收成一个端口，供 service 层按依赖注入使用。
 * @param dbPath - `history.db` 的路径
 * @param warn - 读失败时的诊断口（透传给 `readPrefixLedger`）
 * @returns 账本端口
 */
export function createRtkLedger(dbPath: string, warn?: (line: string) => void): RtkLedger {
  return {
    read: (request) => readPrefixLedger(dbPath, request, undefined, warn),
    clear: () => clearRtkCommands(dbPath, undefined, warn),
  };
}
