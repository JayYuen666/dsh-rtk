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
import { mkdirSync, realpathSync } from "node:fs";
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
import type { SqliteModule } from "../lib/rtk-ledger.ts";

/** 反复出现的字面量提到模块级（`sonarjs(no-duplicate-string)` 数到三次就红）。 */
const HISTORY_DB = "history.db";
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
    const ledger = await readPrefixLedger(dbPath, {
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
  });

  it("窗口外的行不进聚合，但 dataStart 仍看全库", async () => {
    const dbPath = path.join(await tempDir(), HISTORY_DB);
    const now = Date.now();
    const old = now - 40 * DAY_MS;
    await seedLedger(dbPath, [
      { at: old, saved: 900 },
      { at: now, saved: 100 },
    ]);
    const weekly = await readPrefixLedger(dbPath, {
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
    const monthly = await readPrefixLedger(dbPath, {
      form: "prefix",
      rangeDays: 90,
      granularity: "day",
    });
    assert.equal(monthly.days.length, 2);
    assert.equal(monthly.dataStart, new Date(old).toISOString());
  });

  it("库不存在时报 missing", async () => {
    const dir = await tempDir();
    const ledger = await readPrefixLedger(path.join(dir, "nope.db"), {
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
    const ledger = await readPrefixLedger(dbPath, {
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
    const ledger = await readPrefixLedger(dbPath, {
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

    const after = await readPrefixLedger(dbPath, {
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
    const after = await readPrefixLedger(real, {
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
    const ledger = createRtkLedger(dbPath);
    const read = await ledger.read({ form: "prefix", rangeDays: 7, granularity: "day" });
    assert.equal(read.availability, "ok");
    await ledger.clear();
    const after = await ledger.read({ form: "prefix", rangeDays: 7, granularity: "day" });
    assert.deepEqual(after.days, []);
  });
});
