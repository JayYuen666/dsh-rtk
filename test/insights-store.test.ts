// test/insights-store.test.ts —— 统计库的落盘面：写、读、代际、保留窗口、fail-open。
//
// 这里用**真** SQLite（`node:sqlite`，node 22+ 内置，本机 v26 实测可用），不用替身：
// 这一层要证的正是「SQL 写对了没有」——UPSERT 的累加、按天的主键冲突、`GROUP BY` 的
// 起点过滤、事务里的清表。用内存替身只能证明「我调用了一个函数」。
//
// 每个用例一个临时目录，`onTestFinished` 里删掉：WAL 会留下 `-wal` / `-shm` 两个兄弟
// 文件，只删主文件会让下一次跑在残留的 WAL 上读到上一轮的页。
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, onTestFinished, vi } from "vitest";
import assert from "node:assert/strict";

import { openInsightsStore } from "../lib/insights-store.ts";
import type { PipeRecord, PrefixRecord } from "../lib/insights-shape.ts";
import type { InsightsStore, SqliteModule } from "../lib/insights-store.ts";
import type { DatabaseFace, StatementFace } from "../lib/sqlite-face.ts";
import { EMPTY_LEGACY_ACCUMULATOR } from "../lib/legacy-stats.ts";
import type { LegacyAccumulator } from "../lib/legacy-stats.ts";

/** 用例里反复出现的字面量，提到模块级（`sonarjs(no-duplicate-string)` 数到三次就红）。 */
const CARGO_FILTER = "cargo-test";
const GIT_FILTER = "git-log";
const CARGO_FAMILY = "cargo test";
const GIT_FAMILY = "git log";
const REWRITTEN = "prefix-rewritten";
const REPO_WORKDIR = "/repo";
const STATS_DB = "stats.db";

/** 定时器的间隔：`lib/insights-store.ts` 的 `FLUSH_DELAY_MS` 是 1000，这里是它的期望值。 */
const FLUSH_DELAY = 1000;

/** 后置校验拒绝的 reason 字面量（出现三次）。 */
const ASSERTION_CHANGED = "guard:assertion-changed";

/** 写 meta 的那句 UPSERT：多处用例直接改库时共用（重复字面量会撞 `no-duplicate-string`）。 */
const META_UPSERT =
  "INSERT INTO dsh_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";

/** 拿写锁的那句 SQL 与它失败时的文案（多处用例共用，重复字面量会撞 `no-duplicate-string`）。 */
const LOCK_SQL = "BEGIN IMMEDIATE";
const LOCK_FAILED = "拿不到写锁";

/** 保留窗口的锚点：2026-11-15 12:00 本地时间。 */
const ANCHOR = new Date(2026, 10, 15, 12, 0, 0).getTime();

/**
 * 一个「构造即抛」的 sqlite 桩。
 *
 * 模块级常量而不是工厂里再造函数：`unicorn(consistent-function-scoping)` 会要求「不捕获
 * 外部变量的函数提到模块作用域」，而 `typescript/no-extraneous-class` 又不许只有一个构造器
 * 的类——两边的交集就是一个模块级函数常量。`as unknown as` 是绕过构造签名判据的最小代价，
 * 这个桩的存在意义正是「构造一定失败」。
 */
function refuseConstruction(): never {
  throw new Error("构造失败");
}

/** 记录种类字面量（出现三次以上）。 */
const PREFIX_OUTCOME = "prefix-outcome";
/** 后置校验拒绝的结局名（落 `verify_rejected` 列）。 */
const VERIFY_REJECTED = "verify-rejected";

/**
 * 造一条 `prefix-outcome` 的拒绝记录。
 * @returns 记录
 */
function verifyRejected(): Extract<PrefixRecord, { kind: "prefix-outcome" }> {
  return {
    kind: PREFIX_OUTCOME,
    ts: ANCHOR,
    outcome: VERIFY_REJECTED,
    reason: ASSERTION_CHANGED,
    commandFamily: CARGO_FAMILY,
    workdir: REPO_WORKDIR,
    latencyMs: 20,
  };
}

/**
 * 造一条 `pipe-bash-call`（用例里出现七次，字面量重复会撞 lint）。
 * @param commandFamily - 命令家族
 * @returns 记录
 */
function bashCall(commandFamily: string): Extract<PipeRecord, { kind: "pipe-bash-call" }> {
  return { kind: "pipe-bash-call", ts: ANCHOR, commandFamily, workdir: REPO_WORKDIR };
}

/** 一天的毫秒数（只为造「90 天前」这类日期，不参与桶位移）。 */
const DAY_MS = 86_400_000;

/** 锚点所在的本地日（`localDayKey(ANCHOR)` 的期望值）。 */
const DAY = "2026-11-15";
/** 窗口外的另一个日子（用来验起点过滤）。 */
const EARLY_DAY = "2026-01-01";

/**
 * 造一个临时库路径。
 * @returns 库路径；调用结束自动删目录
 */
async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-rtk-insights-"));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return path.join(dir, STATS_DB);
}

/**
 * 打开一个 store，并在用例结束时关掉它。
 *
 * 关掉的顺序是承重的：`close()` 会先 flush 再 `db.close()`，而 `onTestFinished` 里删目录
 * 排在关库之后，否则 WAL 还开着就删不掉。
 * @param dbPath - 库路径
 * @param options - 透传给 `openInsightsStore` 的其余入参
 * @returns 打开的 store（用例保证不是 undefined）
 */
async function openStore(
  dbPath: string,
  options: { readonly legacy?: LegacyAccumulator | null; readonly now?: () => number } = {},
): Promise<InsightsStore> {
  const store = await openInsightsStore({
    dbPath,
    ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
    now: options.now ?? (() => ANCHOR),
  });
  assert.ok(store !== undefined, "store 应当打开成功");
  onTestFinished(async () => {
    await store.close();
  });
  return store;
}

/**
 * 一条 pipe 成功记录。
 * @param savedTokens - 省下的 token（决定按 filter 的份额）
 * @returns 记录
 */
function pipeSuccess(savedTokens: number): {
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
} {
  return {
    kind: "pipe-success",
    ts: ANCHOR,
    filter: CARGO_FILTER,
    commandFamily: CARGO_FAMILY,
    workdir: REPO_WORKDIR,
    originalTokens: savedTokens * 2,
    compressedTokens: savedTokens,
    savedTokens,
    originalBytes: savedTokens * 8,
    compressedBytes: savedTokens * 4,
    latencyMs: 12,
  };
}

describe("统计库的建表与元信息", () => {
  it("新建库写入 schemaVersion=1 与 statsEpoch=0", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    // meta 不对外暴露读方法：走一次清空再读，代际号必须从 0 变成 1，
    // schemaVersion 则原样保留（它不是代际）。
    await store.reset();
    await store.close();
    const reopened = await openStore(dbPath);
    // 重开后仍能正常工作，说明表结构与 meta 都还在。
    reopened.recordPipe(bashCall(CARGO_FAMILY));
    reopened.recordPipe(pipeSuccess(10));
    await reopened.flush();
    const [day] = reopened.readPipeDays(DAY);
    assert.ok(day !== undefined);
    assert.equal(day.bash_calls, 1);
    assert.equal(day.compressed, 1);
  });

  it("同一个库可以被两个 store 同时打开，各自的写入都能读到", async () => {
    const dbPath = await tempDbPath();
    const first = await openStore(dbPath);
    const second = await openStore(dbPath);
    first.recordPipe(bashCall(GIT_FAMILY));
    second.recordPipe(bashCall(CARGO_FAMILY));
    await first.flush();
    await second.flush();
    // 读面以 DB 为准：从 first 上看，second 写的那条也必须在。
    const [firstDay] = first.readPipeDays(DAY);
    assert.equal(firstDay?.bash_calls, 2);
  });
});

describe("pipe 的写入与读取", () => {
  it("成功记录同时累加 pipe_days、写一条事件、留一条 last_event", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPipe(pipeSuccess(40));
    await store.flush();

    const [day] = store.readPipeDays(DAY);
    assert.ok(day !== undefined);
    assert.equal(day.compressed, 1);
    assert.equal(day.original_tokens, 80);
    assert.equal(day.compressed_tokens, 40);
    assert.equal(day.saved_tokens, 40);
    assert.equal(day.latency_ms_sum, 12);
    assert.equal(day.latency_count, 1);
    // bash_calls 由 pipe-bash-call 记，成功记录不该顺手加一：两者是两个独立口径。
    assert.equal(day.bash_calls, 0);

    const [event] = store.readPipeEvents(DAY);
    assert.ok(event !== undefined);
    assert.equal(event.filter, CARGO_FILTER);
    assert.equal(event.status, "compressed");
    assert.equal(event.reason, "success");
    assert.equal(event.saved_tokens, 40);

    const [last] = store.readLastEvents(5);
    assert.ok(last !== undefined);
    assert.equal(last.form, "pipe");
    assert.equal(last.status, "compressed");
    // 原始 320 B 落在 small 档（< 4096）。
    assert.equal(last.size_bucket, "small");
  });

  it("跳过记录按原因计数，没命中 filter 时不写事件行", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPipe({
      kind: "pipe-skip",
      ts: ANCHOR,
      reason: "too-small",
      commandFamily: CARGO_FAMILY,
      workdir: REPO_WORKDIR,
      originalBytes: 10,
    });
    store.recordPipe({
      kind: "pipe-skip",
      ts: ANCHOR,
      reason: "guard:low-gain",
      filter: CARGO_FILTER,
      commandFamily: CARGO_FAMILY,
      workdir: REPO_WORKDIR,
      originalBytes: 900,
      latencyMs: 7,
    });
    await store.flush();

    // 两条原因各自成行，不被折成同一个字符串：`guard:` 前缀是护栏自己给的理由。
    const reasons = store.readPipeSkipReasons(DAY);
    assert.deepEqual(
      reasons.map((row) => [row.reason, row.count]),
      [
        ["guard:low-gain", 1],
        ["too-small", 1],
      ],
    );
    // 只有带 filter 的那条写了事件行。
    const [event] = store.readPipeEvents(DAY);
    assert.ok(event !== undefined);
    assert.equal(event.filter, CARGO_FILTER);
    assert.equal(event.status, "skipped");
  });

  it("potential 计数按 (day, filter) 累加", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPotential(DAY, GIT_FILTER);
    store.recordPotential(DAY, GIT_FILTER);
    store.recordPotential(DAY, CARGO_FILTER);
    await store.flush();
    const rows = store.readPotential(DAY);
    assert.deepEqual(
      rows.map((row) => [row.filter, row.matches]),
      [
        [GIT_FILTER, 2],
        [CARGO_FILTER, 1],
      ],
    );
  });

  it("读面按起点日过滤，起点之前的天不出现", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPipe({ ...bashCall(CARGO_FAMILY), ts: ANCHOR - 10 * DAY_MS });
    store.recordPipe(bashCall(CARGO_FAMILY));
    await store.flush();
    assert.equal(store.readPipeDays(EARLY_DAY).length, 2);
    const [narrow] = store.readPipeDays(DAY);
    assert.ok(narrow !== undefined);
    assert.equal(narrow.day, DAY);
  });
});

describe("prefix 的写入与读取", () => {
  it("五种记录各落各的列", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPrefix({
      kind: "prefix-bash-call",
      ts: ANCHOR,
      commandFamily: CARGO_FAMILY,
      workdir: REPO_WORKDIR,
    });
    store.recordPrefix({ kind: "prefix-attempt", ts: ANCHOR });
    store.recordPrefix({
      kind: REWRITTEN,
      ts: ANCHOR,
      latencyMs: 30,
      families: [CARGO_FAMILY],
      workdir: REPO_WORKDIR,
    });
    store.recordPrefix(verifyRejected());
    store.recordPrefix({
      kind: "prefix-gate-skip",
      ts: ANCHOR,
      reason: "denied",
      commandFamily: GIT_FAMILY,
      workdir: REPO_WORKDIR,
    });
    await store.flush();

    const [day] = store.readPrefixDays(DAY);
    assert.ok(day !== undefined);
    assert.equal(day.bash_calls, 1);
    assert.equal(day.attempts, 1);
    assert.equal(day.rewritten, 1);
    assert.equal(day.verify_rejected, 1);
    assert.equal(day.gate_skips, 1);
    // 只有真正跑过 rewrite 的两条贡献了延迟（rewritten + outcome）：
    // 被门禁挡下的那条根本没有花时间。
    assert.equal(day.latency_count, 2);
    assert.equal(day.latency_ms_sum, 50);

    const gateReasons = store.readPrefixGateReasons(DAY);
    assert.deepEqual(
      gateReasons.map((row) => [row.reason, row.count]),
      [["denied", 1]],
    );
    // 明细事件表不再对外暴露（没有消费者，`dsh_prefix_events` 只喂「最近一次」那条聚合）。
    // 逆序读回来：先是门禁挡下那条（skipped / denied），再往前是 verify 拒绝（failed）。
    const recent = store
      .readLastEvents(10)
      .filter((row) => row.form === "prefix")
      .map((row) => row.status);
    assert.deepEqual(recent, ["skipped", "failed", "rewritten"]);
    const denied = store.readLastEventOf("prefix");
    assert.equal(denied?.reason, "denied", "按 form 取到的就是最后写进去的那条");
  });

  it("last_event 把 no-rewrite 记成 skipped、把 verify 拒绝记成 failed", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPrefix({
      kind: PREFIX_OUTCOME,
      ts: ANCHOR,
      outcome: "no-rewrite",
      reason: "no-change",
      commandFamily: CARGO_FAMILY,
      workdir: REPO_WORKDIR,
      latencyMs: 5,
    });
    store.recordPrefix({
      kind: PREFIX_OUTCOME,
      ts: ANCHOR + 1,
      outcome: "timeout",
      reason: "timeout",
      commandFamily: CARGO_FAMILY,
      workdir: REPO_WORKDIR,
      latencyMs: 2000,
    });
    await store.flush();
    // 最新在前：timeout 是最后写的。
    const last = store.readLastEvents(5);
    assert.deepEqual(
      last.map((row) => [row.reason, row.status]),
      [
        ["timeout", "failed"],
        ["no-change", "skipped"],
      ],
    );
  });
});

describe("代际与重置", () => {
  it("reset 清空所有表并递增代际", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPipe(pipeSuccess(10));
    store.recordPrefix({
      kind: "prefix-bash-call",
      ts: ANCHOR,
      commandFamily: CARGO_FAMILY,
      workdir: REPO_WORKDIR,
    });
    await store.flush();
    assert.equal(store.readPipeDays(EARLY_DAY).length, 1);

    await store.reset();
    assert.equal(store.readPipeDays(EARLY_DAY).length, 0);
    assert.equal(store.readPrefixDays(EARLY_DAY).length, 0);
    assert.equal(store.readLastEvents(10).length, 0);
  });

  it("另一个 store 的旧缓冲在重置后 flush 不会把数据写回来", async () => {
    const dbPath = await tempDbPath();
    const resetter = await openStore(dbPath);
    const stale = await openStore(dbPath);
    // stale 先攒一条，但还没 flush。
    stale.recordPipe(pipeSuccess(99));
    await resetter.reset();
    // stale 的缓冲属于旧代际：flush 之后必须整批丢弃。
    await stale.flush();
    assert.equal(resetter.readPipeDays(EARLY_DAY).length, 0);
    assert.equal(resetter.readLastEvents(10).length, 0);
  });

  it("重置之后新写入仍然生效", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPipe(pipeSuccess(10));
    await store.flush();
    await store.reset();
    store.recordPipe(pipeSuccess(7));
    await store.flush();
    const [day] = store.readPipeDays(DAY);
    assert.equal(day?.saved_tokens, 7);
  });
});

describe("保留窗口", () => {
  it("90 天之前的天被清理，窗口内的留下", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    // 100 天前与今天各写一条。
    store.recordPipe({
      kind: "pipe-bash-call",
      ts: ANCHOR - 100 * DAY_MS,
      commandFamily: CARGO_FAMILY,
      workdir: REPO_WORKDIR,
    });
    store.recordPipe(bashCall(CARGO_FAMILY));
    await store.flush();
    const days = store.readPipeDays("0000-00-00");
    assert.equal(days.length, 1);
    assert.equal(days[0]?.day, DAY);
  });

  it("last_events 只保留最近 100 条", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    // 一次 flush 里塞 120 条：`flush()` 是显式入口，不经过定时器，调用即落盘。
    for (let index = 0; index < 120; index += 1) {
      store.recordPipe({ ...pipeSuccess(1), ts: ANCHOR + index });
    }
    await store.flush();
    // 保留窗口内（120 条都在今天），只按条数裁。
    assert.equal(store.readLastEvents(500).length, 100);
  });
});

describe("旧账本迁移", () => {
  it("给出 legacy 时折成快照，字段照搬", async () => {
    const dbPath = await tempDbPath();
    const legacy: LegacyAccumulator = {
      commands: 7,
      originalBytes: 800,
      compressedBytes: 300,
      originalTokens: 100,
      compressedTokens: 40,
      byFilter: { [CARGO_FILTER]: { commands: 3, savedBytes: 100, savedTokens: 20 } },
      byForm: { prefix: 2, pipe: 5 },
    };
    const store = await openStore(dbPath, { legacy });
    const snapshot = store.readLegacy();
    assert.ok(snapshot !== null);
    assert.equal(snapshot.commands, 7);
    // token 优先：originalTokens > 0 时用 token 相减，不用字节。
    assert.equal(snapshot.savedTokens, 60);
    assert.deepEqual(snapshot.byForm, { prefix: 2, pipe: 5 });
    assert.deepEqual(snapshot.byFilter[CARGO_FILTER], {
      commands: 3,
      savedBytes: 100,
      savedTokens: 20,
    });
  });

  it("没有 token 数据时退回字节口径", async () => {
    const dbPath = await tempDbPath();
    const legacy: LegacyAccumulator = {
      ...EMPTY_LEGACY_ACCUMULATOR,
      commands: 2,
      originalBytes: 900,
      compressedBytes: 400,
    };
    const store = await openStore(dbPath, { legacy });
    assert.equal(store.readLegacy()?.savedTokens, 500);
  });

  it("第二个 store 再带 legacy 打开时不覆盖第一次的迁移结果", async () => {
    const dbPath = await tempDbPath();
    const before: LegacyAccumulator = { ...EMPTY_LEGACY_ACCUMULATOR, commands: 3 };
    const after: LegacyAccumulator = { ...EMPTY_LEGACY_ACCUMULATOR, commands: 9 };
    const first = await openStore(dbPath, { legacy: before });
    const second = await openStore(dbPath, { legacy: after });
    assert.equal(second.readLegacy()?.commands, 3);
    assert.equal(first.readLegacy()?.commands, 3);
  });

  it("没有 legacy 时 readLegacy 返回 null", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath, { legacy: null });
    assert.equal(store.readLegacy(), null);
  });
});

describe("fail-open", () => {
  it("node:sqlite 动态 import 失败时返回 undefined，不抛", async () => {
    const dbPath = await tempDbPath();
    const store = await openInsightsStore({
      dbPath,
      importSqlite: () => Promise.reject(new Error("没有这个模块")),
    });
    assert.equal(store, undefined);
  });

  it("路径不可写时返回 undefined，不抛", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-rtk-insights-ro-"));
    onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    // 用一个**存在的普通文件**当目录：DatabaseSync 在它下面建库必然失败。
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const store = await openInsightsStore({ dbPath: path.join(blocker, STATS_DB) });
    assert.equal(store, undefined);
  });

  it("文件损坏时返回 undefined，不抛", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-rtk-insights-bad-"));
    onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const dbPath = path.join(dir, STATS_DB);
    await writeFile(dbPath, "definitely not a sqlite database, just plain text padding........");
    const store = await openInsightsStore({ dbPath });
    assert.equal(store, undefined);
    // 目录里只有那个坏文件，没有偷偷建出 WAL 兄弟文件。
    const entries = await readdir(dir);
    assert.deepEqual(entries, [STATS_DB]);
  });

  it("注入的 loader 被调用一次，形状不对时同样返回 undefined", async () => {
    const dbPath = await tempDbPath();
    let calls = 0;
    const broken: SqliteModule = {
      DatabaseSync: refuseConstruction as unknown as SqliteModule["DatabaseSync"],
    };
    const store = await openInsightsStore({
      dbPath,
      importSqlite: () => {
        calls += 1;
        return Promise.resolve(broken);
      },
    });
    assert.equal(store, undefined);
    assert.equal(calls, 1);
  });
});

describe("size_bucket 的四档与 unknown", () => {
  it("原始字节落在 tiny / medium / large 各自成档，缺字节时 unknown", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    // 四档各一条，档界是 256 / 4096 / 65536（左闭右开）。
    const sizes = [10, 900, 5000, 200_000];
    for (const [index, originalBytes] of sizes.entries()) {
      store.recordPipe({ ...pipeSuccess(1), ts: ANCHOR + index, originalBytes });
    }
    // 不给 originalBytes 的那一条只有跳过记录能造：成功记录的字段是必填的。
    store.recordPipe({
      kind: "pipe-skip",
      ts: ANCHOR + sizes.length,
      reason: "too-small",
      commandFamily: CARGO_FAMILY,
      workdir: REPO_WORKDIR,
    });
    await store.flush();
    // 最新在前，所以倒过来读才是写入顺序。
    const buckets = store
      .readLastEvents(10)
      .map((row) => row.size_bucket)
      .toReversed();
    assert.deepEqual(buckets, ["tiny", "small", "medium", "large", "unknown"]);
  });

  it("跳过记录没带 token 与延迟时按 0 落盘", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPipe({
      kind: "pipe-skip",
      ts: ANCHOR,
      reason: "shape-mismatch",
      filter: GIT_FILTER,
      commandFamily: GIT_FAMILY,
      workdir: REPO_WORKDIR,
    });
    await store.flush();
    // 四个可选字段全缺省：事件行必须仍是 0 而不是 null（列没有默认值，靠写入方补齐）。
    const [event] = store.readPipeEvents(DAY);
    assert.ok(event !== undefined);
    assert.equal(event.original_tokens, 0);
    assert.equal(event.compressed_tokens, 0);
    assert.equal(event.original_bytes, 0);
    assert.equal(event.latency_ms, 0);
  });

  it("改写记录没有家族时 last_event 的 command_family 落 unknown", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    // families 为空表：rtk 改了一段但家族认不出来（例如整段是变量展开）。
    store.recordPrefix({
      kind: REWRITTEN,
      ts: ANCHOR,
      latencyMs: 8,
      families: [],
      workdir: REPO_WORKDIR,
    });
    await store.flush();
    const [last] = store.readLastEvents(5);
    assert.ok(last !== undefined);
    assert.equal(last.status, "rewritten");
    assert.equal(last.command_family, "unknown");
    assert.equal(last.size_bucket, "unknown");
  });

  it("复合命令被改了两段时，last_event 记的是**被改的那几段**里的第一段", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    // `cd x && git diff && cargo test` 只改后两段：整条命令的家族是 `cd`（首词），
    // 而 `cd` 根本没被改写。这一格要印「改了什么」，所以取 families[0]。
    store.recordPrefix({
      kind: REWRITTEN,
      ts: ANCHOR,
      latencyMs: 12,
      families: [GIT_FAMILY, CARGO_FAMILY],
      workdir: REPO_WORKDIR,
    });
    await store.flush();
    const [last] = store.readLastEvents(5);
    assert.ok(last !== undefined);
    assert.equal(last.command_family, GIT_FAMILY);
  });
});

describe("旧账本字节里存的是坏形状", () => {
  it("meta 里的 legacy 不是 JSON 时 readLegacy 给 null", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    await store.close();
    // 直接改 meta：模拟上一版写下坏字节（或手工编辑过的库）。
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare(META_UPSERT).run("legacy", "not json at all");
    db.close();
    const reopened = await openStore(dbPath);
    assert.equal(reopened.readLegacy(), null);
  });

  it("meta 里的 legacy 是 JSON 但形状不对时也给 null", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    await store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    // 合法 JSON、缺 byForm：旧字节被别的东西覆盖过，不该当成快照用。
    db.prepare(META_UPSERT).run("legacy", JSON.stringify({ commands: 1 }));
    db.close();
    const reopened = await openStore(dbPath);
    assert.equal(reopened.readLegacy(), null);
  });
});

/**
 * 造一个「可注入故障的驱动」：外壳只转调真 `node:sqlite`，`exec` / `prepare` 之前先问 hook。
 *
 * 用它而不是把内部函数导出来打桩：要证的行为是「事务失败时 store 不炸、这一批丢掉」，那是
 * store 对外承诺的一部分；而故障点（BEGIN / COMMIT / ROLLBACK 抛）只有驱动层能造。
 * 外层类必须**显式**列出访问修饰符、且每个方法都真的用到 `this`——否则本仓的
 * `explicit-member-accessibility` 与 `class-methods-use-this` 会同时开口。
 * @param realModule - 真模块
 * @param onExec - 每条 exec 之前调用，抛异常就等于驱动报错
 * @param onPrepare - 每条 prepare 之前调用
 * @returns 形状仍是 `SqliteModule`
 */
function hookedModule(
  realModule: SqliteModule,
  onExec?: (sql: string) => void,
  onPrepare?: (sql: string) => void,
): SqliteModule {
  return {
    DatabaseSync: class {
      readonly #inner: DatabaseFace;
      public constructor(
        dbPath: string,
        options?: { readonly readOnly?: boolean; readonly timeout?: number },
      ) {
        this.#inner = new realModule.DatabaseSync(dbPath, options);
      }
      public exec(sql: string): void {
        onExec?.(sql);
        this.#inner.exec(sql);
      }
      public prepare(sql: string): StatementFace {
        onPrepare?.(sql);
        return this.#inner.prepare(sql);
      }
      public close(): void {
        this.#inner.close();
      }
    },
  };
}

describe("事务失败时的退路", () => {
  it("拿写锁失败时这一批丢掉，不抛给调用方", async () => {
    const dbPath = await tempDbPath();
    const real = await import("node:sqlite");
    const store = await openInsightsStore({
      dbPath,
      importSqlite: () =>
        Promise.resolve(
          hookedModule(real, (sql) => {
            if (sql === LOCK_SQL) {
              throw new Error(LOCK_FAILED);
            }
          }),
        ),
      now: () => ANCHOR,
    });
    assert.ok(store !== undefined);
    onTestFinished(async () => {
      await store.close();
    });
    store.recordPipe(pipeSuccess(10));
    // flush 内部会 BEGIN → 抛 → 回滚（此时没有活动事务，ROLLBACK 也抛）→ 两层都吞掉。
    await assert.doesNotReject(store.flush());
    assert.equal(store.readPipeDays(DAY).length, 0);
  });

  it("清理失败只播报一行，不动这一批已落盘的行", async () => {
    const dbPath = await tempDbPath();
    const real = await import("node:sqlite");
    const warns: string[] = [];
    const store = await openInsightsStore({
      dbPath,
      importSqlite: () =>
        Promise.resolve(
          hookedModule(
            real,
            () => {
              // `prune` 走的是 `prepare(...).run(...)` 而不是 `exec`：钩在 prepare 上。
            },
            (sql) => {
              // `prune` 的 DELETE 在事务之后单独跑：它抛不该回滚这一批已经 COMMIT 的行。
              if (sql.startsWith("DELETE FROM dsh_pipe_events")) {
                throw new Error("prune exploded");
              }
            },
          ),
        ),
      now: () => ANCHOR,
      warn: (line) => {
        warns.push(line);
      },
    });
    assert.ok(store !== undefined);
    onTestFinished(async () => {
      await store.close();
    });
    store.recordPipe(pipeSuccess(1));
    await store.flush();
    assert.equal(store.readPipeDays(DAY).length, 1, "这一批必须已落盘");
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /cannot prune the stats tables/u);
  });

  it("抛出来的不是 Error 时也能播报：warn 文案不该是 [object Object]", async () => {
    const dbPath = await tempDbPath();
    const real = await import("node:sqlite");
    const warns: string[] = [];
    const store = await openInsightsStore({
      dbPath,
      importSqlite: () =>
        Promise.resolve(
          hookedModule(real, (sql) => {
            if (sql === LOCK_SQL) {
              // 字符串拒绝在宿主插件里并不罕见（子进程、第三方库、手写桩都可能这么抛）。
              const rejection: unknown = LOCK_FAILED;
              throw rejection;
            }
          }),
        ),
      now: () => ANCHOR,
      warn: (line) => {
        warns.push(line);
      },
    });
    assert.ok(store !== undefined);
    onTestFinished(async () => {
      await store.close();
    });
    store.recordPipe(pipeSuccess(3));
    await store.flush();
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /cannot write the stats tables \(/u);
    assert.doesNotMatch(warns[0] ?? "", /\[object /u);
  });

  it("重置提交失败时只吞掉异常，读面照常可用", async () => {
    const dbPath = await tempDbPath();
    const real = await import("node:sqlite");
    let failCommit = false;
    const store = await openInsightsStore({
      dbPath,
      importSqlite: () =>
        Promise.resolve(
          hookedModule(real, (sql) => {
            if (sql === "COMMIT" && failCommit) {
              throw new Error("提交失败");
            }
          }),
        ),
      now: () => ANCHOR,
    });
    assert.ok(store !== undefined);
    onTestFinished(async () => {
      await store.close();
    });
    store.recordPipe(pipeSuccess(10));
    await store.flush();
    assert.equal(store.readPipeDays(DAY).length, 1);
    // 只有 reset 的那次 COMMIT 失败：整段 BEGIN 都没成，回滚也抛，两层都被吞掉。
    failCommit = true;
    await assert.doesNotReject(store.reset());
    // reset 没有假成功：数据还在，代际也没往上跳。
    assert.equal(store.readPipeDays(DAY).length, 1);
  });

  it("迁移中途（BEGIN 之后）失败时回滚并整体判为打不开", async () => {
    const dbPath = await tempDbPath();
    const real = await import("node:sqlite");
    // 打开期一共三次 meta 写：schemaVersion、statsEpoch、以及迁移里的 legacy。前两次必须
    // 成功（它们发生在 BEGIN 之外），所以故障点定在第三次——那时写锁已经拿到，异常才会
    // 落进 `migrateLegacyOnce` 自己的 catch（回滚 + 原样抛出）。
    let metaWrites = 0;
    const store = await openInsightsStore({
      dbPath,
      legacy: { ...EMPTY_LEGACY_ACCUMULATOR, commands: 3 },
      importSqlite: () =>
        Promise.resolve(
          hookedModule(real, undefined, (sql) => {
            if (!sql.startsWith("INSERT INTO dsh_meta")) {
              return;
            }
            metaWrites += 1;
            if (metaWrites === 3) {
              throw new Error("写 meta 失败");
            }
          }),
        ),
    });
    assert.equal(store, undefined);
  });

  it("旧账本迁移拿不到写锁时整库判定为打不开", async () => {
    const dbPath = await tempDbPath();
    const real = await import("node:sqlite");
    const store = await openInsightsStore({
      dbPath,
      legacy: { ...EMPTY_LEGACY_ACCUMULATOR, commands: 3 },
      importSqlite: () =>
        Promise.resolve(
          hookedModule(real, (sql) => {
            // 迁移是打开期间唯一一次 BEGIN：让它失败，考察的是「迁移失败 → 整体 fail-open」。
            if (sql === LOCK_SQL) {
              throw new Error("迁移拿不到锁");
            }
          }),
        ),
    });
    assert.equal(store, undefined);
  });
});

describe("定时 flush 与代际缺失", () => {
  it("攒着的行由定时器落盘，不需要显式 flush", async () => {
    // 这一条要的是「定时器真的会调用 flushNow」：真睡 1 秒既慢又可能与下一个用例的清理赛跑。
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    store.recordPipe(pipeSuccess(5));
    assert.equal(store.readPipeDays(DAY).length, 0);
    // 定时器是 1 秒：用假时钟推进，不真的睡一秒。
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    const [day] = store.readPipeDays(DAY);
    assert.ok(day !== undefined);
    assert.equal(day.saved_tokens, 5);
  });

  it("statsEpoch 行被外部删掉时按 0 读，旧缓冲按代际不符丢弃", async () => {
    const dbPath = await tempDbPath();
    const store = await openStore(dbPath);
    // 先 reset 把代际推到 1。
    await store.reset();
    // 另一路把 meta 里的代际行删掉：读成 0 与本地 epoch=1 不符，缓冲必须整批丢。
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM dsh_meta WHERE key = 'statsEpoch'");
    db.close();
    store.recordPipe(pipeSuccess(9));
    await store.flush();
    assert.equal(store.readPipeDays(DAY).length, 0);
  });

  it("不给 now 时落回 Date.now，库照常打开", async () => {
    const dbPath = await tempDbPath();
    const store = await openInsightsStore({ dbPath });
    assert.ok(store !== undefined);
    await store.close();
  });
});

/**
 * 往 meta 里写一个读不成数字的代际号。
 *
 * 它对应真机出现过的那一态：`reset()` 早先会把 `String(NaN + 1)` = `"NaN"` 写回去，
 * 于是此后每一批都被判成「别的 host 重置过」整批丢弃——库看着正常、页面永远是空的。
 *
 * 模块作用域：它不捕获外层变量（`unicorn(consistent-function-scoping)`）。
 * @param dbPath - 库路径
 * @param raw - 写进去的原文
 */
async function spoilEpoch(dbPath: string, raw: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare(META_UPSERT).run("statsEpoch", raw);
  db.close();
}

describe("代际号读不懂时的自愈", () => {
  it("代际号是垃圾串时按 0 读：写入不被误判成旧代际，数据真的落盘", async () => {
    const dbPath = await tempDbPath();
    const first = await openStore(dbPath);
    await first.close();
    await spoilEpoch(dbPath, "garbage");
    // 重开：本进程的 epoch 从 meta 读出 0（读不懂按 0），两边一致，写入应当照常落盘。
    const store = await openStore(dbPath);
    store.recordPipe(pipeSuccess(7));
    await store.flush();
    assert.equal(store.readPipeDays(DAY).length, 1);
  });

  it("reset 把读不懂的代际号改写成数字，不再写回 NaN", async () => {
    const dbPath = await tempDbPath();
    const first = await openStore(dbPath);
    await first.close();
    await spoilEpoch(dbPath, "NaN");
    const store = await openStore(dbPath);
    await store.reset();
    // 代际号必须变成可读的数字串：写回 "NaN" 会让这个库从此再也存不下统计。
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT value FROM dsh_meta WHERE key = ?").get("statsEpoch") as
      | { value: string }
      | undefined;
    db.close();
    assert.equal(row?.value, "1");
  });
});

/**
 * 造一个「BEGIN 永远失败」的库。
 *
 * 用它而不是拿真锁去卡：这一组要证的是**失败之后排不排下一趟**，而真锁要靠时间窗控制，
 * 慢且不稳。故障点仍然只有驱动层能造（BEGIN 抛），所以走的还是真 SQL。
 *
 * 放模块作用域而不是 describe 里：它不捕获任何外层变量，`unicorn(consistent-function-scoping)`
 * 会要求把它提到不捕获的那一层。
 * @param dbPath - 库路径
 * @returns store 与「BEGIN 尝试次数」的读取口
 */
async function openingWithFailingBegin(
  dbPath: string,
): Promise<{ readonly store: InsightsStore; readonly begins: () => number }> {
  const real = await import("node:sqlite");
  let begins = 0;
  const store = await openInsightsStore({
    dbPath,
    importSqlite: () =>
      Promise.resolve(
        hookedModule(real, (sql) => {
          if (sql !== LOCK_SQL) {
            return;
          }
          begins += 1;
          throw new Error(LOCK_FAILED);
        }),
      ),
    now: () => ANCHOR,
  });
  assert.ok(store !== undefined);
  return { store, begins: () => begins };
}

describe("写不进去时的重试与关库后的静默", () => {
  it("攒满一批但没写成时排一趟重试：下一批不再等下一条记录才动", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { store, begins } = await openingWithFailingBegin(await tempDbPath());
    onTestFinished(async () => {
      await store.close();
    });
    // 攒满 FLUSH_THRESHOLD(32) 之后排的是**定时器**（0 延迟），不在调用栈里写库：
    // `push` 的调用方是 bash 工具的执行路径，同步 flush 会把工具调用按在写锁上。
    for (let index = 0; index < 32; index += 1) {
      store.recordPipe(pipeSuccess(index));
    }
    assert.equal(begins(), 0, "攒满时不该在调用栈里写库");
    await vi.advanceTimersByTimeAsync(0);
    const afterBurst = begins();
    assert.ok(afterBurst >= 1, "0 延迟的定时器到点后应当试过写一次");
    // 定时器到点再试一次：这条路径就是「没人再记新记录时也会自己重试」。
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    assert.ok(begins() > afterBurst, "定时器到点应当又试了一次");
    // 一次都没写进去：缓冲还在，读面照旧空着（这是 fail-open 的代价，不是假成功）。
    assert.equal(store.readPipeDays(DAY).length, 0);
  });

  it("关库之后的记录直接丢：不排定时器、不碰已关闭的连接", async () => {
    const { store, begins } = await openingWithFailingBegin(await tempDbPath());
    await store.close();
    const before = begins();
    // 两种入口都试一次：关库后到达的事件在任何一条路径上都不该再触发写。
    assert.doesNotThrow(() => {
      store.recordPipe(pipeSuccess(7));
      store.recordPotential("2026-11-15", CARGO_FILTER);
    });
    assert.equal(begins(), before, "关库后不该再碰数据库");
  });

  it("关库之后 reset 直接回完成：不重建表、不写 meta", async () => {
    const { store, begins } = await openingWithFailingBegin(await tempDbPath());
    await store.close();
    const before = begins();
    await assert.doesNotReject(store.reset());
    assert.equal(begins(), before);
  });
});
