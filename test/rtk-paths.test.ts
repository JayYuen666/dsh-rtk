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

import {
  physicalDirOf,
  resolveLedgerPaths,
  withRtkDbPath,
  withoutRtkDbEnv,
} from "../lib/rtk-paths.ts";

/** 反复出现的字面量提到模块级（`sonarjs(no-duplicate-string)` 数到三次就红）。 */
const HISTORY_DB = "history.db";
const RTK_DIR = "rtk";
const DEFAULT_HOME = ".dsh";
const DB_PATH = "/ledger/rtk/history.db";
const RTK_GIT_STATUS = "rtk git status";

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
function withoutInjection(command: string, dbPath: string): string {
  const quoted = `'${dbPath.replaceAll("'", `'\\''`)}'`;
  return command.replaceAll(`RTK_DB_PATH=${quoted} `, "");
}

describe("resolveLedgerPaths", () => {
  it("账本落在 $DSH_HOME/rtk/history.db", async () => {
    const home = await tempDir();
    const paths = resolveLedgerPaths({ DSH_HOME: home });
    assert.deepEqual(paths, { historyDb: path.join(home, RTK_DIR, HISTORY_DB) });
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

describe("withRtkDbPath", () => {
  it("单段命令：在 rtk 前面加一个赋值", () => {
    assert.equal(
      withRtkDbPath(RTK_GIT_STATUS, DB_PATH),
      `RTK_DB_PATH='${DB_PATH}' ${RTK_GIT_STATUS}`,
    );
  });

  it("复合命令：只改承载改写的那一段，分隔符与其它段逐字不动", () => {
    const command = "cd a && rtk cargo test";
    const injected = withRtkDbPath(command, DB_PATH);
    assert.notEqual(injected, command);
    assert.equal(withoutInjection(injected, DB_PATH), command);
    assert.match(injected, /&&\s*RTK_DB_PATH='/u);
  });

  it("多段都承载改写时逐段注入", () => {
    const command = "rtk git status && rtk cargo test";
    const injected = withRtkDbPath(command, DB_PATH);
    assert.equal(injected.split("RTK_DB_PATH=").length - 1, 2);
    assert.equal(withoutInjection(injected, DB_PATH), command);
  });

  it("不是 rtk 的命令原样返回", () => {
    const command = "ls -la && echo done";
    assert.equal(withRtkDbPath(command, DB_PATH), command);
  });

  it("形似的前缀也不动（`rtkx` 不是 rtk）", () => {
    const command = "rtkx run";
    assert.equal(withRtkDbPath(command, DB_PATH), command);
  });

  it("空路径表示本次装配不碰账本：原样返回", () => {
    const command = "rtk git status";
    assert.equal(withRtkDbPath(command, ""), command);
  });

  it("拆不开的命令（引号不配对）原样返回", () => {
    const command = "rtk git status 'unbalanced";
    assert.equal(withRtkDbPath(command, DB_PATH), command);
  });

  it("路径里的单引号按 POSIX 收口，不会提前闭合", () => {
    const tricky = "/a'b/history.db";
    const injected = withRtkDbPath(RTK_GIT_STATUS, tricky);
    assert.equal(injected, `RTK_DB_PATH='/a'\\''b/history.db' rtk git status`);
    assert.equal(withoutInjection(injected, tricky), RTK_GIT_STATUS);
  });
});

describe("withoutRtkDbEnv", () => {
  it("用 undefined tombstone 移除两个 DB 变量，保留其它", () => {
    const env = withoutRtkDbEnv({
      RTK_DB_PATH: "/ambient/history.db",
      DSH_RTK_DB_PATH: "/ambient/x.db",
      RTK_NO_TOML: "1",
    });
    assert.equal(env["RTK_DB_PATH"], undefined);
    assert.equal(env["DSH_RTK_DB_PATH"], undefined);
    assert.equal(env["RTK_NO_TOML"], "1");
  });

  it("改的是副本，入参不被写", () => {
    const source: Record<string, string | undefined> = { RTK_DB_PATH: "/a.db" };
    withoutRtkDbEnv(source);
    assert.equal(source["RTK_DB_PATH"], "/a.db");
  });
});
