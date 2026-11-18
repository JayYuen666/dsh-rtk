/**
 * 账本位置 + 注入：**只统计 dsh 宿主里发生的事**，因此账本落在 dsh 自己的目录下。
 *
 * 位置是 `$DSH_HOME/rtk/history.db`（默认 `~/.dsh/rtk/history.db`），解析走官方
 * `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`：宿主怎么认自己的家目录，插件就怎么认，
 * 两边不会各算一份（显式配置 > `$DSH_HOME` > `~/.dsh`，空白串当未设）。
 *
 * **为什么不共用 rtk 的全局账本**：`history.db` 那张 `commands` 表里躺的是用户在自己终端里跑的
 * 全部 rtk 命令，而本页的其余数字（bash 调用、尝试改写、覆盖率）只有 dsh 会话知道。两者混在
 * 一屏上会出现「改写成功 0 次、却省了 1.7M token」这种自相矛盾的读数——用户看到的第一个反应
 * 是「这些数据到底采没采到」。所以账本按 dsh 的边界切：rtk 只被允许写进我们指定的那个文件。
 *
 * 切边界的机制是 `RTK_DB_PATH`：它是 rtk 自己的第一优先（`src/core/tracking.rs:2001` 的
 * `get_db_path()`），所以「改写出来的 `rtk <cmd>` 往哪记账」由本模块注入的那一段决定。
 * 代价明写：`rtk gain` 因此看不到 dsh 的调用，两边的数字不再相加——这是刻意的。
 */
import { realpathSync } from "node:fs";
import path from "node:path";

import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

import { splitCommand } from "./prefix-safety.ts";

/** 本插件账本的文件名。与 rtk 的 `HISTORY_DB` 同名，因为它就是同一个程序写的同一个 schema。 */
const HISTORY_DB = "history.db";

/** dsh 家里放 rtk 账本的子目录（`$DSH_HOME/rtk/`）。 */
const LEDGER_DIR = "rtk";

/**
 * 账本位置。
 *
 * 只有一个字段是刻意的：目录由 `path.dirname(historyDb)` 一步得出，多存一份就多一个可能与
 * 库文件不同步的来源。沙箱登记要的就是目录，调用点自己取一次即可。
 */
export interface RtkPaths {
  /** `history.db`；插件的 `dsh_*` 表也在这个文件里。 */
  readonly historyDb: string;
}

/**
 * 解析账本位置。
 *
 * 装配期调一次就够：`DSH_HOME` 是进程级输入，解析它不该进每次工具调用的热路径。
 * @param env - 环境变量表（只读 `DSH_HOME`，测试注入用）
 * @returns 库文件路径
 */
export function resolveLedgerPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RtkPaths {
  return { historyDb: path.join(resolveDshHome(undefined, env), LEDGER_DIR, HISTORY_DB) };
}

/**
 * 折成物理路径（解开符号链接）。
 *
 * 沙箱的 `registerWritableRoot` 拿 `realpathSync` 的结果与传入原文比，两者不等就抛
 * `SANDBOX_INVALID_ROOT`（真机现场：`/tmp` 是 `/private/tmp` 的链接）。这里折一次，让上层拿到的
 * 就是物理路径；解析不出来（目录还不存在）时原样返回，交给登记那一层兜底。
 * @param dir - 候选目录
 * @returns 物理路径
 */
export function physicalDirOf(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/** 单引号包裹一个 shell 字面量（值里带单引号时按 POSIX 的 `'\''` 收口）。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 给每段 `rtk …` 前面加一个 `RTK_DB_PATH='…'`，把它的记账引到 dsh 自己的库里。
 *
 * **只改承载改写的那些段**：复合命令里前面那段（`cd x && rtk git status`）原样留着——往
 * `cd` 前面插一个环境变量赋值会把它变成别的东西（`VAR=x cd y` 在 shell 里其实还成立，但
 * 我们的契约是「分隔符与其它段逐字不动」，见 `lib/prefix-safety.ts` 的 `CommandSegment`）。
 *
 * 拆不开的复合命令（引号不配对、真重定向等）整条原样返回：那种情况下我们连「哪一段是 rtk」
 * 都认不准，宁可不注入让它落回全局账本，也不动一条看不清的命令。
 * @param command - `rtk rewrite` 交出来的命令
 * @param dbPath - 注入的库路径；空串表示不注入（本次装配不碰账本）
 * @returns 要真正执行的命令
 */
export function withRtkDbPath(command: string, dbPath: string): string {
  if (dbPath === "") {
    return command;
  }
  const segments = splitCommand(command);
  if (segments === undefined) {
    return command;
  }
  const injected = shellQuote(dbPath);
  return segments
    .map((segment) => {
      // 分隔符必须原样带上：只回 `segment.text` 会把第二段起的分隔符吃掉
      // （`cd x && ls` 会拼成 `cd x ls`），那是把命令改成了另一个东西。
      const isRtk = segment.text.trimStart().startsWith("rtk ");
      return isRtk
        ? `${segment.sep}RTK_DB_PATH=${injected} ${segment.text}`
        : `${segment.sep}${segment.text}`;
    })
    .join("");
}

/**
 * 抹掉两个 DB 变量，交给 `rtk rewrite` 的子进程。
 *
 * **为什么改写那一路要抹**：`rtk rewrite` 只求改写、不碰任何库（实测 `RTK_DB_PATH` 指到不存在的
 * 目录也照常回 rc=3 与改写串）。把父进程里可能存在的 `RTK_DB_PATH` 带进去，等于让「改写出来
 * 是什么」取决于一个本插件解释不了的环境——抹掉之后 rewrite 的行为只由命令与 rtk 版本决定。
 * （真正执行的那条命令由 `withRtkDbPath` 自己注入，不靠继承。）
 *
 * 值用 `undefined` 而不是删键：宿主的 env 会与父进程合并，只删键抹不掉 shell 里已有的同名变量，
 * 值为 `undefined` 才是 tombstone（`deepEqual` 也把它算作一项，测试据此钉住形状）。
 *
 * `DSH_RTK_DB_PATH` 一并抹：那是本插件早期版本用过的变量名，用户按旧 README 手动导出过，
 * 我们不再读它，也不该让它流进任何子进程。
 * @param env - 装配层造的 env
 * @returns 抹过的副本（入参不被写）
 */
export function withoutRtkDbEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...env, RTK_DB_PATH: undefined, DSH_RTK_DB_PATH: undefined };
}
