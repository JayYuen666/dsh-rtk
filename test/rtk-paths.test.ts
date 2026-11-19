// test/rtk-paths.test.ts —— 账本位置（`$DSH_HOME/rtk/history.db`）与那段 `RTK_DB_PATH` 注入。
//
// 这一层单独成文件是因为它决定**rtk 会把行写进哪个文件**。算错的后果不会自己冒出来：插件照常
// 打开一个「合法的」路径，只是 rtk 从来不往那里写，于是页面上永远是 0，而日志里一个字都没有。
//
// 两种错法各有一条用例兜着：
//   · 位置退化成 rtk 的全局目录——那时页面上会混进用户自己终端跑的几千条命令，与「只统计 dsh
//     会话」的计数自相矛盾（真机上出现过「改写成功 0 次、却省了 1.7M token」的一屏）。
//   · 注入把命令改坏——`cd x && ls` 拼成 `cd x ls`，命令本身变成了另一个东西，而且它照样退出 0。
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { describe, it, onTestFinished } from "vitest";
import assert from "node:assert/strict";

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { RtkPaths } from "../lib/rtk-paths.ts";
import {
  physicalDirOf,
  prepareHookConfig,
  resolveHookPaths,
  resolveLedgerPaths,
  withRtkLedgerEnv,
  withoutRtkDbEnv,
} from "../lib/rtk-paths.ts";

/** 反复出现的字面量提到模块级（`sonarjs(no-duplicate-string)` 数到三次就红）。 */
const HISTORY_DB = "history.db";
const RECALL_DB = "recall.db";
const RTK_DIR = "rtk";
const DEFAULT_HOME = ".dsh";
const DB_DIR = "/ledger/rtk";
const DB_PATH = `${DB_DIR}/${HISTORY_DB}`;
const RTK_GIT_STATUS = "rtk git status";

/** 一份成对的库路径：绝大多数用例只关心「两个库在同一个目录」这条约定。 */
const pathsOf = (historyDb: string): RtkPaths => ({
  historyDb,
  recallDb: path.join(path.dirname(historyDb), RECALL_DB),
});
const PATHS = pathsOf(DB_PATH);

/**
 * 单引号包裹，值里的单引号按 POSIX 收口成 `'\''`。
 *
 * 与实现的 `shellQuote` 分开写一份：它是**契约**（注入后的命令要能直接交给 shell），拿实现
 * 自己的函数来比等于让它自证。两条用例专门喂带单引号的路径。
 * @param value - 原始值
 * @returns 可直接拼进 shell 命令的字面量
 */
function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 注入前缀的逐字形状。
 *
 * 与实现分开写：两个变量的顺序与引号风格是**契约的一部分**（注入后的命令要能直接交给 shell），
 * 拿实现自己的拼串来比等于让它自证。
 * @param paths - 两个库路径
 * @returns `RTK_DB_PATH='…' RTK_RECALL_DB='…'`
 */
function injectionOf(paths: RtkPaths): string {
  return `RTK_DB_PATH=${shellQuoted(paths.historyDb)} RTK_RECALL_DB=${shellQuoted(paths.recallDb)}`;
}

/**
 * 把注入的那一段抹掉，得到「本该原样不动」的命令。
 *
 * 用它而不是逐字写期望串，是为了让断言表达真正的不变量：**注入只加前缀，别的字节一个不动**。
 * 逐字写期望串时，复合命令里 `&&` 两侧的空格也会被一起钉死，读的人分不清哪个空格是契约、
 * 哪个只是拼接的副产品。
 * @param command - 注入过 `RTK_DB_PATH` 的命令
 * @param dbPath - 注入时用的库路径
 * @returns 抹掉注入后的命令
 */
function withoutInjection(command: string, paths: RtkPaths): string {
  const prefix = injectionOf(paths);
  return command.replaceAll(`${prefix} `, "");
}

/**
 * 造一个临时目录，用例结束自动删。
 * @returns 目录绝对路径
 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dsh-rtk-paths-"));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

describe("resolveLedgerPaths", () => {
  it("账本落在 $DSH_HOME/rtk/history.db", async () => {
    const home = await tempDir();
    const paths = resolveLedgerPaths({ DSH_HOME: home });
    assert.deepEqual(paths, {
      historyDb: path.join(home, RTK_DIR, HISTORY_DB),
      recallDb: path.join(home, RTK_DIR, RECALL_DB),
    });
  });

  it("dsh_home 缺席时退回 ~/.dsh（宿主的默认家目录）", () => {
    const paths = resolveLedgerPaths({});
    assert.equal(paths.historyDb, path.join(homedir(), DEFAULT_HOME, RTK_DIR, HISTORY_DB));
  });

  it("空白串等于没设（宿主也是这么判的）", () => {
    const paths = resolveLedgerPaths({ DSH_HOME: "   " });
    assert.equal(paths.historyDb, path.join(homedir(), DEFAULT_HOME, RTK_DIR, HISTORY_DB));
  });

  it("RTK_DB_PATH 不再参与解析（那是 rtk 的全局库，不由我们读）", async () => {
    const home = await tempDir();
    const paths = resolveLedgerPaths({ DSH_HOME: home, RTK_DB_PATH: "/by/env/h.db" });
    assert.equal(paths.historyDb, path.join(home, RTK_DIR, HISTORY_DB));
  });

  it("dir 永远是库文件的父目录（沙箱登记的是它，不是文件）", async () => {
    const home = await tempDir();
    const paths = resolveLedgerPaths({ DSH_HOME: home });
    // 目录不再由 `RtkPaths` 携带第二份：调用点一律 `path.dirname(historyDb)` 现取，
    // 这样「登记哪个目录」与「库文件在哪」不可能各说一套。
    assert.equal(path.dirname(paths.historyDb), path.join(home, RTK_DIR));
  });

  it("不传 env 时读 process.env 里的 DSH_HOME", async () => {
    const home = await tempDir();
    const saved = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = home;
    onTestFinished(() => {
      if (saved === undefined) {
        delete process.env["DSH_HOME"];
      } else {
        process.env["DSH_HOME"] = saved;
      }
    });
    assert.equal(resolveLedgerPaths().historyDb, path.join(home, RTK_DIR, HISTORY_DB));
  });
});

describe("resolveHookPaths", () => {
  it("三处都在 $DSH_HOME/rtk/ 下：config / home / hook.db", async () => {
    const home = await tempDir();
    assert.deepEqual(resolveHookPaths({ DSH_HOME: home }), {
      configDir: path.join(home, RTK_DIR, "config"),
      home: path.join(home, RTK_DIR, "home"),
      dbPath: path.join(home, RTK_DIR, "hook.db"),
    });
  });

  it("账本与主库分家：hook 写的是自己那一个文件", async () => {
    const home = await tempDir();
    const ledger = resolveLedgerPaths({ DSH_HOME: home });
    assert.notEqual(resolveHookPaths({ DSH_HOME: home }).dbPath, ledger.historyDb);
  });

  it("dsh_home 缺席时与账本同一套回退（都落 ~/.dsh/rtk）", () => {
    const hook = resolveHookPaths({});
    assert.equal(hook.dbPath, path.join(homedir(), DEFAULT_HOME, RTK_DIR, "hook.db"));
  });
});

describe("prepareHookConfig", () => {
  const TOML = 'schema_version = 1\n[pipeline]\nextends = "rtk:posthook"\n';

  it("建出两个目录并写下 pipeline.toml，回它的目录", async () => {
    const home = await tempDir();
    const paths = resolveHookPaths({ DSH_HOME: home });
    const configDir = prepareHookConfig(paths, TOML);
    assert.equal(configDir, paths.configDir);
    assert.equal(readFileSync(path.join(paths.configDir, "pipeline.toml"), "utf8"), TOML);
  });

  it("连 home 也一起建：rtk 要往那里写自己的状态文件", async () => {
    // 少建这一个的后果不是报错：rtk 会退回平台的真实数据目录，把用户全局那份
    // `pipeline-status.json` 删掉（实测），而会话里什么都看不到。
    const home = await tempDir();
    const paths = resolveHookPaths({ DSH_HOME: home });
    prepareHookConfig(paths, TOML);
    assert.equal(statSync(paths.home).isDirectory(), true);
  });

  it("重复调用幂等：内容被覆盖、不抛", async () => {
    const home = await tempDir();
    const paths = resolveHookPaths({ DSH_HOME: home });
    prepareHookConfig(paths, TOML);
    const second = prepareHookConfig(paths, "schema_version = 1\n");
    assert.equal(second, paths.configDir);
    assert.equal(
      readFileSync(path.join(paths.configDir, "pipeline.toml"), "utf8"),
      "schema_version = 1\n",
    );
  });

  it("目录建不出来时回 undefined，且不抛（调用方据此关掉这条链）", async () => {
    // 拿一个普通文件当父级：三平台上 mkdir 都会失败，不需要平台判断。
    const root = await tempDir();
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "x");
    const paths = {
      configDir: path.join(blocker, "config"),
      home: path.join(blocker, "home"),
      dbPath: path.join(blocker, "hook.db"),
    };
    assert.equal(prepareHookConfig(paths, TOML), undefined);
    assert.equal(existsSync(path.join(blocker, "config")), false);
  });
});

describe("physicalDirOf", () => {
  it("解开符号链接", async () => {
    const root = await tempDir();
    const real = path.join(root, "real");
    const alias = path.join(root, "alias");
    await mkdir(real, { recursive: true });
    await symlink(real, alias, "dir");
    assert.equal(physicalDirOf(alias), physicalDirOf(real));
  });

  it("解不出来（目录不存在）时原样返回", async () => {
    const absent = path.join(await tempDir(), "nope", "deeper");
    assert.equal(physicalDirOf(absent), absent);
  });
});

describe("withRtkLedgerEnv", () => {
  it("单段命令：在 rtk 前面挂上两个库路径", () => {
    assert.equal(
      withRtkLedgerEnv(RTK_GIT_STATUS, PATHS),
      `${injectionOf(PATHS)} ${RTK_GIT_STATUS}`,
    );
  });

  it("两个变量成对出现：只给 RTK_DB_PATH 时 rtk 仍会把折叠中段写进全局 recall 库", () => {
    const injected = withRtkLedgerEnv(RTK_GIT_STATUS, PATHS);
    assert.match(injected, /RTK_DB_PATH='/u);
    assert.match(injected, /RTK_RECALL_DB='/u);
  });

  it("复合命令：只改承载改写的那一段，分隔符与其它段逐字不动", () => {
    const command = "cd a && rtk cargo test";
    const injected = withRtkLedgerEnv(command, PATHS);
    assert.notEqual(injected, command);
    assert.equal(withoutInjection(injected, PATHS), command);
    assert.match(injected, /&&\s*RTK_DB_PATH='/u);
  });

  it("多段都承载改写时逐段注入", () => {
    const command = "rtk git status && rtk cargo test";
    const injected = withRtkLedgerEnv(command, PATHS);
    assert.equal(injected.split("RTK_DB_PATH=").length - 1, 2);
    assert.equal(injected.split("RTK_RECALL_DB=").length - 1, 2);
    assert.equal(withoutInjection(injected, PATHS), command);
  });

  it("不是 rtk 的命令原样返回", () => {
    const command = "ls -la && echo done";
    assert.equal(withRtkLedgerEnv(command, PATHS), command);
  });

  it("形似的前缀也不动（`rtkx` 不是 rtk）", () => {
    const command = "rtkx run";
    assert.equal(withRtkLedgerEnv(command, PATHS), command);
  });

  it("空路径表示本次装配不碰账本：原样返回", () => {
    const command = "rtk git status";
    assert.equal(withRtkLedgerEnv(command, { historyDb: "", recallDb: "" }), command);
  });

  it("拆不开的命令（引号不配对）原样返回", () => {
    const command = "rtk git status 'unbalanced";
    assert.equal(withRtkLedgerEnv(command, PATHS), command);
  });

  it("路径里的单引号按 POSIX 收口，不会提前闭合", () => {
    const tricky = pathsOf("/a'b/history.db");
    const injected = withRtkLedgerEnv(RTK_GIT_STATUS, tricky);
    assert.equal(
      injected,
      `RTK_DB_PATH=${shellQuoted(tricky.historyDb)} RTK_RECALL_DB=${shellQuoted(tricky.recallDb)} rtk git status`,
    );
    assert.equal(withoutInjection(injected, tricky), RTK_GIT_STATUS);
  });
});

describe("withoutRtkDbEnv", () => {
  it("用 undefined tombstone 移除三个变量（含 recall），保留其它", () => {
    const env = withoutRtkDbEnv({
      RTK_DB_PATH: "/ambient/history.db",
      DSH_RTK_DB_PATH: "/ambient/x.db",
      RTK_RECALL_DB: "/ambient/recall.db",
      RTK_NO_TOML: "1",
    });
    assert.equal(env["RTK_DB_PATH"], undefined);
    assert.equal(env["DSH_RTK_DB_PATH"], undefined);
    // `RTK_RECALL_DB` 也要抹：父 shell 里有人导出过它时，那两条子进程（rewrite / pipe）本来
    // 就不碰 recall 库（都带 `RTK_RECALL=0`），留着它只会让「到哪取回」多一个说不清的来源。
    assert.equal(env["RTK_RECALL_DB"], undefined);
    assert.equal(env["RTK_NO_TOML"], "1");
  });

  it("改的是副本，入参不被写", () => {
    const source: Record<string, string | undefined> = { RTK_DB_PATH: "/a.db" };
    withoutRtkDbEnv(source);
    assert.equal(source["RTK_DB_PATH"], "/a.db");
  });
});
