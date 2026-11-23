// test/rtk-ledger.test.ts —— dsh 账本的只读聚合、清零与沙箱登记。
//
// 路径解析在 `test/rtk-paths.test.ts`：那是另一件事（算出 rtk 会写哪个文件），与这里「拿到路径
// 之后怎么读」分开钉，混在一起时两边的失败会互相掩盖。
//
// 聚合那一段用**真** SQLite（`node:sqlite`，本机 node v26 实测可用），并且按 rtk 自己的
// 建表形状造库（`rtk/src/core/tracking.rs` 的 commands 表）：这一层要证的正是「SQL 读对了
// 没有」——按本地日分桶、窗口起点、LIMIT、MIN(timestamp)，用替身只能证明「我调用了一个函数」。
//
// 三种非 ok 态是分开断言的，因为它们给用户的提示完全不同：
//   missing   → 「rtk 还没记过账」
//   schema    → 「库在，但没有 commands 表」（tracking 关着，或来自更老的 schema）
//   unreadable → 「读坏了 / 没权限 / busy」
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, onTestFinished } from "vitest";
import assert from "node:assert/strict";

import {
  clearRtkCommands,
  createRtkLedger,
  ensureRtkDir,
  readPrefixLedger,
  registerRtkWritableRoot,
} from "../lib/rtk-ledger.ts";
import type { DatabaseFace, SqliteModule, StatementFace } from "../lib/sqlite-face.ts";

/** 反复出现的字面量提到模块级（`sonarjs(no-duplicate-string)` 数到三次就红）。 */
const HISTORY_DB = "history.db";
const RECALL_DB = "recall.db";
const CARGO_ORIGINAL = "cargo test";
const CARGO_REWRITTEN = "rtk cargo test";
const GIT_ORIGINAL = "git status";
const REPO_WORKDIR = "/repo/app";
const OTHER_WORKDIR = "/repo/lib";

/**
 * 「构造即抛」的 sqlite 桩函数体。
 *
 * 放模块作用域：写在用例里会被 `unicorn(consistent-function-scoping)` 要求提出去，写成只有
 * 一个构造器的类又会撞 `typescript/no-extraneous-class`。
 */
function refuseConstruction(): never {
  throw new Error("无法加载驱动");
}

/** 一天的毫秒数：只为造「窗口外」的行，不参与桶位移。 */
const DAY_MS = 86_400_000;

/**
 * 造一个临时目录，用例结束自动删。
 * @returns 目录绝对路径
 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-rtk-ledger-"));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 一行 commands 记录的造法。 */
interface CommandRowSeed {
  readonly at: number;
  readonly original?: string;
  readonly rewritten?: string;
  readonly input?: number;
  readonly output?: number;
  readonly saved?: number;
  readonly workdir?: string;
}

/**
 * 按 rtk 的建表语句造一份 commands 表。
 *
 * 列与类型逐字取自 `rtk/src/core/tracking.rs`（含后来迁移加上的 `exec_time_ms` 与
 * `project_path`）：少一列，被测的 SQL 就会以 `no such column` 落到 schema 分支，
 * 于是「聚合算错了」与「表都建不对」两种失败看起来一样。
 * @param dbPath - 库路径
 * @param rows - 要插入的记录
 */
async function seedLedger(dbPath: string, rows: readonly CommandRowSeed[]): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE commands (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    original_cmd TEXT NOT NULL,
    rtk_cmd TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    saved_tokens INTEGER NOT NULL,
    savings_pct REAL NOT NULL,
    exec_time_ms INTEGER DEFAULT 0,
    project_path TEXT DEFAULT ''
  )`);
  const insert = db.prepare(
    `INSERT INTO commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens,
       saved_tokens, savings_pct, exec_time_ms, project_path)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  );
  for (const row of rows) {
    insert.run(
      new Date(row.at).toISOString(),
      row.original ?? CARGO_ORIGINAL,
      row.rewritten ?? CARGO_REWRITTEN,
      row.input ?? 1000,
      row.output ?? 200,
      row.saved ?? 800,
      row.workdir ?? REPO_WORKDIR,
    );
  }
  db.close();
}

/**
 * 造一个只有空库、没有 commands 表的文件。
 * @param dbPath - 库路径
 */
async function seedEmptyDb(dbPath: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE unrelated (x INTEGER)");
  db.close();
}

/**
 * 往已存在的库里补一张 `parse_failures`（rtk 后来才加的表，所以单独造）。
 *
 * 列与类型逐字取自现量 DDL：`CREATE TABLE parse_failures (id INTEGER PRIMARY KEY,
 * timestamp TEXT NOT NULL, raw_command TEXT NOT NULL, error_message TEXT NOT NULL,
 * fallback_succeeded INTEGER NOT NULL DEFAULT 0)`。
 * @param dbPath - 库路径
 * @param rows - `{at, succeeded}` 两列，其余列填占位
 */
async function seedParseFailures(
  dbPath: string,
  rows: readonly { readonly at: number; readonly succeeded: boolean }[],
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE parse_failures (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    raw_command TEXT NOT NULL,
    error_message TEXT NOT NULL,
    fallback_succeeded INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = db.prepare(
    "INSERT INTO parse_failures (timestamp, raw_command, error_message, fallback_succeeded) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      new Date(row.at).toISOString(),
      "rtk ps aux",
      "error: unrecognized subcommand 'ps'",
      row.succeeded ? 1 : 0,
    );
  }
  db.close();
}

/**
 * 造一份 `recall.db`。
 *
 * 列与类型逐字取自现量 DDL（`recall` 表）：被测 SQL 只数行数，但表结构不对会以
 * `no such table` 落到「读不到就给 0」那一支，于是「真的没有」与「表建错了」看起来一样。
 * @param dbPath - 库路径
 * @param count - 插入几条
 * @returns 造完之后文件多大（字节）
 */
async function seedRecallDb(dbPath: string, count: number): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE recall (
    hash TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    cwd TEXT,
    exit_code INTEGER,
    created_at INTEGER NOT NULL,
    total_lines INTEGER NOT NULL,
    shown_upto INTEGER NOT NULL,
    byte_size INTEGER NOT NULL,
    truncated INTEGER NOT NULL,
    codec TEXT NOT NULL,
    blob BLOB NOT NULL,
    recalled INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = db.prepare(
    `INSERT INTO recall (hash, command, cwd, created_at, total_lines, shown_upto,
       byte_size, truncated, codec, blob) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'gzip', ?)`,
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(
      `hash${String(index)}`,
      "ls-hidden",
      REPO_WORKDIR,
      1_795_048_799,
      250,
      1,
      4096,
      new Uint8Array([1, 2, 3]),
    );
  }
  db.close();
  return statSync(dbPath).size;
}

describe("ensureRtkDir", () => {
  it("建出目录并返回真", async () => {
    const dir = path.join(await tempDir(), "rtk");
    assert.equal(ensureRtkDir(dir), true);
  });

  it("目录已存在时也返回真", async () => {
    const dir = await tempDir();
    assert.equal(ensureRtkDir(dir), true);
  });

  it("目录是指向别处的符号链接时返回假", async () => {
    const root = await tempDir();
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    await mkdir(real);
    await symlink(real, link, "dir");
    assert.equal(ensureRtkDir(link), false);
  });

  it("建不出来（父路径是文件）时返回假", async () => {
    const root = await tempDir();
    const blocker = path.join(root, "blocker");
    await writeFile(blocker, "x");
    assert.equal(ensureRtkDir(path.join(blocker, "rtk")), false);
  });
});

/** 登记成功时交回的空 disposer；`() => {}` 字面量会被 lint 判空函数。 */
const noop = (): void => {
  // 这里没有东西要回收。
};

describe("registerRtkWritableRoot", () => {
  it("有沙箱策略时注册并交出 disposer", () => {
    const calls: string[] = [];
    const ctx = {
      get: (name: string) =>
        name === "sandboxPolicy"
          ? {
              registerWritableRoot: (session: unknown, dir: string) => {
                calls.push(`${String(session)}:${dir}`);
                return () => {
                  calls.push("disposed");
                };
              },
            }
          : undefined,
      effect: (run: () => () => void, label: string) => {
        calls.push(label);
        run()();
      },
    };
    registerRtkWritableRoot(ctx, { session: "s1" }, "/home/u/.dsh/rtk");
    assert.deepEqual(calls, ["rtk: tracking dir", "s1:/home/u/.dsh/rtk", "disposed"]);
  });

  it("策略缺席时安静退场", () => {
    let effects = 0;
    registerRtkWritableRoot(
      {
        get: (): undefined => {
          // 沙箱策略缺席：返回 undefined 表示宿主编译时没装它。
        },
        effect: () => {
          effects += 1;
        },
      },
      { session: "s1" },
      "/x",
    );
    assert.equal(effects, 0);
  });

  it("形似但缺方法的服务也退场", () => {
    let effects = 0;
    registerRtkWritableRoot(
      {
        get: () => ({ registerWritableRoot: "not-a-function" }),
        effect: () => {
          effects += 1;
        },
      },
      { session: "s1" },
      "/x",
    );
    assert.equal(effects, 0);
  });

  // 下面两条钉的是真宿主里踩到过的两种失败形态。
  //
  // 一、**必须折物理路径**：宿主的 `additionalRoot()` 拿 `realpathSync` 的结果与传入原文比，
  // 不等就抛 `SANDBOX_INVALID_ROOT`（"symlinked grants are not supported"）。macOS 上
  // `$DSH_HOME=/tmp/...` 的解析结果就是 `/private/tmp/...`，于是那条路必抛。
  it("登记前折成物理路径（符号链接的父目录要被解开）", async () => {
    const root = await tempDir();
    const real = path.join(root, "real");
    mkdirSync(real, { recursive: true });
    const alias = path.join(root, "alias");
    await symlink(real, alias);
    const seen: string[] = [];
    registerRtkWritableRoot(
      {
        get: () => ({
          registerWritableRoot: (_session: unknown, dir: string) => {
            seen.push(dir);
            return noop;
          },
        }),
        effect: (run: () => () => void) => {
          run();
        },
      },
      { session: "s1" },
      alias,
    );
    assert.deepEqual(seen, [realpathSync.native(real)]);
  });

  // 二、**异常不能冒泡**：登记发生在工具的 execute 路径上，一个附加项的登记失败会把整条
  // bash 调用变成模型看到的 `SandboxInvalidRootError`（真机实测：连 `git status` 都跑不成）。
  it("登记抛错时只 warn，不把异常抛给调用方", () => {
    const warns: string[] = [];
    const ctx = {
      get: () => ({
        registerWritableRoot: () => {
          throw new Error("SANDBOX_INVALID_ROOT");
        },
      }),
      effect: (run: () => () => void, label: string) => {
        void label;
        run()();
      },
    };
    assert.doesNotThrow(() => {
      registerRtkWritableRoot(ctx, { session: "s1" }, "/x", (line) => {
        warns.push(line);
      });
    });
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /cannot grant .* rtk bookkeeping will fail silently/u);
  });

  // 抛的可以不是 Error（宿主网关那边就有字符串拒绝）。兜底文案必须还能落成一行日志，
  // 否则「包一层」本身就变成新的崩溃点。
  it("登记抛的是非 Error 值时也照常退场", () => {
    const warns: string[] = [];
    const ctx = {
      get: () => ({
        registerWritableRoot: () => {
          // 故意抛一个非 Error：宿主网关那边就有字符串拒绝的形态。
          const rejection: unknown = "ERR_BOOM";
          throw rejection;
        },
      }),
      effect: (run: () => () => void, label: string) => {
        void label;
        run()();
      },
    };
    assert.doesNotThrow(() => {
      registerRtkWritableRoot(ctx, { session: "s1" }, "/x", (line) => {
        warns.push(line);
      });
    });
    assert.match(warns[0] ?? "", /cannot grant .*ERR_BOOM/u);
  });

  // 路径解析不出来（目录还不存在）时原样登记：折不动就交给宿主自己去判，
  // 不能因为「解不开」就把一个本来合法的目录悄悄吞掉。
  it("物理路径解不出来时原样登记", () => {
    const seen: string[] = [];
    registerRtkWritableRoot(
      {
        get: () => ({
          registerWritableRoot: (_session: unknown, dir: string) => {
            seen.push(dir);
            return noop;
          },
        }),
        effect: (run: () => () => void) => {
          run()();
        },
      },
      { session: "s1" },
      "/definitely/not/here/rtk",
    );
    assert.deepEqual(seen, ["/definitely/not/here/rtk"]);
  });
});

describe("readPrefixLedger", () => {
  it("按本地日聚合、按命令与目录排行", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    const now = Date.now();
    await seedLedger(dbPath, [
      { at: now, input: 1000, output: 200, saved: 800 },
      { at: now, input: 500, output: 100, saved: 400, workdir: OTHER_WORKDIR },
      {
        at: now,
        original: GIT_ORIGINAL,
        rewritten: "rtk git status",
        input: 300,
        output: 50,
        saved: 250,
        workdir: OTHER_WORKDIR,
      },
    ]);
    const ledger = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(ledger.availability, "ok");
    assert.equal(ledger.days.length, 1);
    // `node:sqlite` 的行是 **null 原型**对象，严格 deepEqual 会因原型不同而红（本轮实测）；
    // 展开成普通对象再比，断言里就只剩「字段值对不对」这一件待判的事。
    assert.deepEqual(
      { ...ledger.days[0] },
      { day: ledger.days[0]?.day, commands: 3, input: 1800, output: 350, saved: 1450 },
    );
    assert.equal(ledger.commands.length, 2);
    assert.deepEqual(
      { ...ledger.commands[0] },
      {
        original_cmd: CARGO_ORIGINAL,
        rtk_cmd: CARGO_REWRITTEN,
        commands: 2,
        input: 1500,
        output: 300,
        saved: 1200,
      },
    );
    assert.deepEqual(
      { ...ledger.workdirs[0] },
      { project_path: REPO_WORKDIR, commands: 1, input: 1000, saved: 800 },
    );
    assert.equal(ledger.workdirs.length, 2);
    assert.notEqual(ledger.dataStart, null);
    // 最新一行按 timestamp 取，字段名按界面消费的形状投影；期望值来自上面第三行种子。
    assert.deepEqual(
      { ...ledger.lastCommand },
      {
        ts: new Date(now).toISOString(),
        input: 300,
        output: 50,
        saved: 250,
        originalCmd: GIT_ORIGINAL,
      },
    );
  });

  it("窗口外的行不进聚合，但 dataStart 仍看全库", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    const now = Date.now();
    const old = now - 40 * DAY_MS;
    await seedLedger(dbPath, [
      { at: old, saved: 900 },
      { at: now, saved: 100 },
    ]);
    const weekly = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(weekly.days.length, 1);
    assert.equal(weekly.days[0]?.saved, 100);
    assert.deepEqual(
      { ...weekly.workdirs[0] },
      { project_path: REPO_WORKDIR, commands: 1, input: 1000, saved: 100 },
    );
    const monthly = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 90,
      granularity: "day",
    });
    assert.equal(monthly.days.length, 2);
    assert.equal(monthly.dataStart, new Date(old).toISOString());
  });

  it("解析失败数与回收率随窗口取，超限行也只数窗口内的", async () => {
    // 期望值全部独立写死，不从被测 SQL 派生：`input: 7501` 是刻意压在 OVERSIZED_TOKENS(7500)
    // 两侧造出来的（7500 不算、7501 算），`old` 那两行是要被窗口挡在外面的对照。
    const dir = await tempDir();
    const dbPath = path.join(dir, HISTORY_DB);
    const now = Date.now();
    const old = now - 40 * DAY_MS;
    await seedLedger(dbPath, [
      { at: now, input: 7501, output: 200, saved: 100 },
      { at: now, input: 7500, output: 200, saved: 100 },
      { at: old, input: 9000, output: 200, saved: 100 },
    ]);
    await seedParseFailures(dbPath, [
      { at: now, succeeded: true },
      { at: now, succeeded: true },
      { at: now, succeeded: false },
      { at: old, succeeded: false },
    ]);
    const weekly = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    // 窗口内的三条里两条救回来了 → 2/3；40 天前那条落在窗口外，不进分子也不进分母。
    assert.deepEqual({ ...weekly.failures }, { total: 3, recovered: 2 });
    // 7501 算一行、7500 不算（判据是严格大于）、9000 在窗口外。
    assert.equal(weekly.oversized, 1);
    const monthly = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 90,
      granularity: "day",
    });
    assert.deepEqual({ ...monthly.failures }, { total: 4, recovered: 2 });
    assert.equal(monthly.oversized, 2);
  });

  it("老库没有 parse_failures 表时留 0，不把整页判成 schema", async () => {
    // `parse_failures` 是 rtk 后来才加的表。缺它时 `readPrefixLedger` 要照常交出聚合，
    // 只把这两个数留 0——若让异常穿出去，整个改写形态会显示「账本形状不认识」。
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now(), saved: 100 }]);
    const ledger = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(ledger.availability, "ok");
    assert.deepEqual({ ...ledger.failures }, { total: 0, recovered: 0 });
    assert.equal(ledger.oversized, 0);
  });

  it("窗口内一行都没有时 failures 仍交出两个 0（SUM 在空集上是 null）", async () => {
    // `SUM(...)` 对空集返回 NULL 而不是 0：不兜这一位，`recovered` 会被当成 `null` 一路
    // 传到界面上，页脚的回收率算出 `NaN%`。这里命令表存在但为空，正好走到那一支。
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, []);
    await seedParseFailures(dbPath, []);
    const ledger = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(ledger.availability, "ok");
    assert.deepEqual({ ...ledger.failures }, { total: 0, recovered: 0 });
    assert.equal(ledger.oversized, 0);
    assert.equal(ledger.dataStart, null);
  });

  it("recall 库的体检数按条数与文件大小给，不按窗口", async () => {
    // 与上面几条的判据不同：`recall.db` 里没有「窗口」这个概念（rtk 自己按保留天数与条数上限
    // 整库淘汰），所以这里只数「现在有多少」。
    const dir = await tempDir();
    const dbPath = path.join(dir, HISTORY_DB);
    const recallDb = path.join(dir, RECALL_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const bytes = await seedRecallDb(recallDb, 3);
    const ledger = await readPrefixLedger(dbPath, recallDb, {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(ledger.recall.entries, 3);
    // 字节数取**文件大小**而不是 `SUM(byte_size)`：后者是压缩前的长度（`codec` 实测是 gzip），
    // 而用户关心的「这个库在长大」说的是磁盘上那一份。
    assert.equal(ledger.recall.bytes, bytes);
  });

  it("recall 库不存在或还没建表时给两个 0，不拖红整页", async () => {
    const dir = await tempDir();
    const dbPath = path.join(dir, HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const absent = await readPrefixLedger(dbPath, path.join(dir, "nope", RECALL_DB), {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(absent.availability, "ok");
    assert.deepEqual({ ...absent.recall }, { entries: 0, bytes: 0 });

    // 文件在但没有 `recall` 表（rtk 用的是 tee 模式，或库是别的进程刚建的）。
    const bare = path.join(dir, RECALL_DB);
    await seedEmptyDb(bare);
    const noTable = await readPrefixLedger(dbPath, bare, {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(noTable.recall.entries, 0);
    assert.equal(noTable.recall.bytes > 0, true, "文件在就有大小，哪怕里面没有我们认得的表");
  });

  it("recall 路径给空串时一个库都不读（用户把记账配空了）", async () => {
    const dir = await tempDir();
    const dbPath = path.join(dir, HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const ledger = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.deepEqual({ ...ledger.recall }, { entries: 0, bytes: 0 });
  });

  it("库不存在时报 missing", async () => {
    const dir = await tempDir();
    const ledger = await readPrefixLedger(path.join(dir, "nope.db"), "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(ledger.availability, "missing");
    assert.deepEqual(ledger.days, []);
    assert.equal(ledger.dataStart, null);
  });

  // 库在、但没有 `commands` 表：判 **missing** 而不是 schema。
  //
  // 这一格改过口径。早先插件自己另开一本 `stats.db`，凡是「文件在、表不在」都只可能是 rtk 的
  // schema 更老；现在插件把 `dsh_*` 表写进 rtk 那个文件，**我们会把文件造出来**——于是
  // 「表不在」的常见成因变成「rtk 从没记过账」，说成 schema 会把人引向错误的排查方向。
  it("库在但没有 commands 表时报 missing（插件自己会把文件造出来）", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedEmptyDb(dbPath);
    const ledger = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(ledger.availability, "missing");
  });

  // 真正属于 schema 的那一档：`commands` 表在，但列不全（rtk 更老的一版建的表）。
  // 这一条同时钉住「missing 与 schema 不是同一个判断」——把两者合并成一条会让上面那条用例
  // 无论怎么改都绿。
  it("commands 表在但缺列时报 schema", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE commands (timestamp TEXT NOT NULL, original_cmd TEXT NOT NULL)");
    db.close();
    const ledger = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(ledger.availability, "schema");
  });

  it("文件损坏时报 unreadable", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await writeFile(dbPath, "this is not a sqlite file");
    const warns: string[] = [];
    const ledger = await readPrefixLedger(
      dbPath,
      "",
      {
        form: "prefix",
        rangeDays: 7,
        granularity: "day",
      },
      undefined,
      (line) => {
        warns.push(line);
      },
    );
    assert.equal(ledger.availability, "unreadable");
    // 这条读面每 5 秒轮询一次、界面只写「不可用」，不播报就零线索。
    // 真错误的 `code` 是 SQLite 的错误码（非空），所以这一条同时钉住「有码」那支。
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /cannot read the ledger \((?!no-code)[a-z]\w*:/iu);
  });

  it("驱动加载失败时也报 unreadable", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const broken: SqliteModule = {
      DatabaseSync: refuseConstruction as unknown as SqliteModule["DatabaseSync"],
    };
    const warns: string[] = [];
    const ledger = await readPrefixLedger(
      dbPath,
      "",
      { form: "prefix", rangeDays: 7, granularity: "day" },
      () => Promise.resolve(broken),
      (line) => {
        warns.push(line);
      },
    );
    assert.equal(ledger.availability, "unreadable");
    // 构造抛的是普通 `Error`，没有 `code`：这一支必须落成 `no-code`，
    // 否则「不是 SQLite 的错误码」与「有个没记下来的错误码」在日志里长得一样。
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /cannot read the ledger \(no-code: /u);
  });

  it("schema 档不播报：那不是故障，是 rtk 从没记过账", async () => {
    // 与上面两条对称：`no such table/column` 走 schema 分支，属于「正常但没数据」，
    // 每 5 秒一次的轮询不该把这一档刷成故障日志。
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE commands");
    db.close();
    const warns: string[] = [];
    const ledger = await readPrefixLedger(
      dbPath,
      "",
      { form: "prefix", rangeDays: 7, granularity: "day" },
      undefined,
      (line) => {
        warns.push(line);
      },
    );
    // 表被整个删掉时报 missing（文件是我们自己造出来的，见实现里的口径说明）。
    assert.equal(ledger.availability, "missing");
    assert.deepEqual(warns, []);
  });

  // rtk 1.2.1 用 `PRAGMA user_version` 记自己的 schema 档（Initial=1、EngineTables=2、
  // InitialRecheck=3，`src/core/tracking.rs`）。版本比插件认识的新时，读面可能少列；
  // 这种漂移**不会**让任何 SQL 报错（多出来的表/列与这里的聚合无关），所以只能自己报。
  it("库的 user_version 比插件认识的新时播报漂移", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 4");
    db.close();
    const warns: string[] = [];
    const ledger = await readPrefixLedger(
      dbPath,
      "",
      { form: "prefix", rangeDays: 7, granularity: "day" },
      undefined,
      (line) => {
        warns.push(line);
      },
    );
    // 判据是「照旧读出数据 + 留一行告警」：漂移不是故障，不该把页面打成不可用。
    assert.equal(ledger.availability, "ok");
    assert.equal(warns.length, 1);
    assert.match(
      warns[0] ?? "",
      /ledger schema is version 4, newer than the 3 .*insights may be incomplete/u,
    );
  });

  it("user_version 等于插件认识的那一档时不播报", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 3");
    db.close();
    const warns: string[] = [];
    await readPrefixLedger(
      dbPath,
      "",
      { form: "prefix", rangeDays: 7, granularity: "day" },
      undefined,
      (line) => {
        warns.push(line);
      },
    );
    assert.deepEqual(warns, []);
  });

  it("pragma user_version 读不到时按 0 处理，不播报漂移", async () => {
    // 防御支：驱动异常或旧库可能不回这一行。把它当 0 是保守的——未知版本不该被报成「比你认识的新」。
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const { DatabaseSync } = await import("node:sqlite");
    function OpenFace(file: string): DatabaseFace {
      const db = new DatabaseSync(file, { readOnly: true, timeout: 500 });
      return {
        prepare: (sql: string): StatementFace =>
          sql === "PRAGMA user_version"
            ? { run: (): unknown => null, get: (): undefined => void 0, all: () => [] }
            : db.prepare(sql),
        exec: (sql: string) => {
          db.exec(sql);
        },
        close: () => {
          db.close();
        },
      };
    }
    const stub: SqliteModule = {
      DatabaseSync: OpenFace as unknown as SqliteModule["DatabaseSync"],
    };
    const warns: string[] = [];
    const ledger = await readPrefixLedger(
      dbPath,
      "",
      { form: "prefix", rangeDays: 7, granularity: "day" },
      () => Promise.resolve(stub),
      (line) => {
        warns.push(line);
      },
    );
    assert.equal(ledger.availability, "ok");
    assert.deepEqual(warns, []);
  });
});

describe("clearRtkCommands", () => {
  // 清的清单与 rtk 自己的 `reset_all()` 对齐（`src/core/tracking.rs:968`）：commands、
  // parse_failures、hook_decisions、engine_attribution、classifier_cache 五张全清。
  //
  // 只删 commands 会留下自相矛盾的页面：总数归零、故障数还是 306。而 `dsh_*` 那几张**不在这里
  // 清**——它们归 store 的 `reset()`，两边各管自己那张纸，谁都不猜对方有哪些表。
  it("清掉 rtk 的五张表，插件的 dsh_ 表与未知表照旧", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE hook_decisions (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO hook_decisions (id) VALUES (7)");
    db.exec("CREATE TABLE dsh_pipe_days (day TEXT PRIMARY KEY)");
    db.exec("INSERT INTO dsh_pipe_days (day) VALUES ('2026-11-17')");
    db.close();

    await clearRtkCommands(dbPath);

    const after = await readPrefixLedger(dbPath, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(after.availability, "ok");
    assert.deepEqual(after.days, []);
    assert.equal(after.dataStart, null);
    const check = new DatabaseSync(dbPath);
    const hooks = check.prepare("SELECT COUNT(*) AS rows FROM hook_decisions").get() as {
      rows: number;
    };
    const ours = check.prepare("SELECT COUNT(*) AS rows FROM dsh_pipe_days").get() as {
      rows: number;
    };
    check.close();
    assert.equal(hooks.rows, 0, "rtk 的五张表一起清（与 reset_all 对齐）");
    assert.equal(ours.rows, 1, "插件自己的表不归这里清");
  });

  it("库不存在时安静退场", async () => {
    const dir = await tempDir();
    // 断言点就是「不抛」：库不存在时清空是一条安静的成功路径。
    await assert.doesNotReject(clearRtkCommands(path.join(dir, "nope.db")));
  });

  it("库文件是符号链接时拒绝清：删的是链接目标的数据", async () => {
    const dir = await tempDir();
    const real = path.join(dir, HISTORY_DB);
    await seedLedger(real, [{ at: Date.now() }]);
    const link = path.join(dir, "link.db");
    await symlink(real, link);
    const warns: string[] = [];
    await clearRtkCommands(link, undefined, (line) => {
      warns.push(line);
    });
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /refusing to clear .* symbolic link/u);
    // 目标一行没动：拒绝是**真的**拒绝，不是「先清再报警」。
    const after = await readPrefixLedger(real, "", {
      form: "prefix",
      rangeDays: 7,
      granularity: "day",
    });
    assert.equal(after.availability, "ok");
    assert.equal(after.days.length, 1);
  });

  it("打开失败时留一行：清零没做成也必须说出来", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await writeFile(dbPath, "not a database at all, just text");
    const warns: string[] = [];
    await clearRtkCommands(dbPath, undefined, (line) => {
      warns.push(line);
    });
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /cannot clear rtk's ledger tables/u);
  });
});

describe("createRtkLedger", () => {
  it("把读与清传给两个函数", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    await seedLedger(dbPath, [{ at: Date.now() }]);
    const ledger = createRtkLedger(dbPath, "");
    const read = await ledger.read({ form: "prefix", rangeDays: 7, granularity: "day" });
    assert.equal(read.availability, "ok");
    await ledger.clear();
    const after = await ledger.read({ form: "prefix", rangeDays: 7, granularity: "day" });
    assert.deepEqual(after.days, []);
  });
});
