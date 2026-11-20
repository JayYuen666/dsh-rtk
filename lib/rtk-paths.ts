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
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

import { hasRtkFront } from "./command-family.ts";
import { splitCommand } from "./command-segments.ts";

/** 本插件账本的文件名。与 rtk 的 `HISTORY_DB` 同名，因为它就是同一个程序写的同一个 schema。 */
const HISTORY_DB = "history.db";

/**
 * rtk 的 recall 库文件名（`src/core/retriever.rs` 的 `RECALL_DB`）。
 *
 * 与 `history.db` 同目录：两个都是 rtk 的库、都由本插件按 dsh 的边界切，分开放只会让「哪份
 * 数据属于 dsh」这件事多一个要记的地方。
 */
const RECALL_DB = "recall.db";

/** dsh 家里放 rtk 账本的子目录（`$DSH_HOME/rtk/`）。 */
const LEDGER_DIR = "rtk";

/**
 * 账本位置。
 *
 * 两个文件同目录（`path.dirname(historyDb)`），所以目录不必再存一份——多一个来源就多一处与
 * 库文件不同步的可能。沙箱登记要的就是目录，调用点自己取一次即可。
 */
export interface RtkPaths {
  /** `history.db`；插件的 `dsh_*` 表也在这个文件里。 */
  readonly historyDb: string;
  /**
   * `recall.db`：rtk 把被折叠的中段存在这里，输出尾巴留 `[+N hidden: rtk recall <hash>]`。
   *
   * 它是**取回通道**而不是统计面，落在这里只为一个理由：不指向它时 rtk 会写进用户的全局
   * recall 库（实测：干净 `HOME` 下跑一次 `rtk ls -la` 就会建出
   * `~/Library/Application Support/rtk/recall.db` 并写一行）。与 `history.db` 同一条口径——
   * 插件碰过的每一份 rtk 数据都落在 dsh 家里。
   */
  readonly recallDb: string;
}

/**
 * 解析账本位置。
 *
 * 装配期调一次就够：`DSH_HOME` 是进程级输入，解析它不该进每次工具调用的热路径。
 * @param env - 环境变量表（只读 `DSH_HOME`，测试注入用）
 * @returns 两个库文件的路径
 */
export function resolveLedgerPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RtkPaths {
  const dir = path.join(resolveDshHome(undefined, env), LEDGER_DIR);
  return { historyDb: path.join(dir, HISTORY_DB), recallDb: path.join(dir, RECALL_DB) };
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
 * 给每段 `rtk …` 前面挂上两个库路径，把它的记账与 recall 都引到 dsh 自己的目录里。
 *
 * `RTK_DB_PATH` 管 `commands` 表（记账），`RTK_RECALL_DB` 管 `recall.db`（被折叠中段的取回
 * 通道）。两个必须一起注入：**只给前者时 rtk 仍会把折叠内容写进用户的全局 recall 库**——
 * 实测在干净 `HOME` 下跑一次 `rtk ls -la`（目录 300 个文件）就会建出
 * `~/Library/Application Support/rtk/recall.db` 并写一行，而那正是本插件要走的那条路径。
 *
 * **只改承载改写的那些段**：复合命令里前面那段（`cd x && rtk git status`）原样留着——往
 * `cd` 前面插一个环境变量赋值会把它变成别的东西（`VAR=x cd y` 在 shell 里其实还成立，但
 * 我们的契约是「分隔符与其它段逐字不动」，见 `lib/prefix-safety.ts` 的 `CommandSegment`）。
 *
 * 拆不开的复合命令（引号不配对、真重定向等）整条原样返回：那种情况下我们连「哪一段是 rtk」
 * 都认不准，宁可不注入让它落回全局库，也不动一条看不清的命令。
 * @param command - `rtk rewrite` 交出来的命令
 * @param paths - 两个库路径；`historyDb` 为空串表示本次装配不碰账本（两个都不注入）
 * @returns 要真正执行的命令
 */
export function withRtkLedgerEnv(command: string, paths: RtkPaths): string {
  if (paths.historyDb === "") {
    return command;
  }
  const segments = splitCommand(command);
  if (segments === undefined) {
    return command;
  }
  const prefix = `RTK_DB_PATH=${shellQuote(paths.historyDb)} RTK_RECALL_DB=${shellQuote(paths.recallDb)}`;
  return segments
    .map((segment) => {
      // 分隔符必须原样带上：只回 `segment.text` 会把第二段起的分隔符吃掉
      // （`cd x && ls` 会拼成 `cd x ls`），那是把命令改成了另一个东西。
      // `env FOO=1 rtk …` 也算：rtk 1.2.1 会把 wrapper 留在外面、只改里面那段，
      // 这时不注入就等于让那一次调用落回用户的全局账本。`hasRtkFront` 只认透明前缀，
      // `sudo` / `uv run` / `timeout` 这些不注入——它们改变的执行语义不该被这里一并接受。
      const isRtk = hasRtkFront(segment.text);
      return isRtk ? `${segment.sep}${prefix} ${segment.text}` : `${segment.sep}${segment.text}`;
    })
    .join("");
}

/**
 * `rtk hook` 这条链要用的三处位置。
 *
 * 为什么它们不像 `RtkPaths` 那样只是两个库文件：`rtk hook` 除了写账本，还要
 * ① 读一份 pipeline 配置（`RTK_CONFIG_DIR`）、② 写两个**只认平台数据目录**的状态文件
 * （`pipeline-status.json` / `pipeline.log`，不认 `RTK_CONFIG_DIR`）。三处都落在
 * `$DSH_HOME/rtk/` 下面——那是同一个「插件碰过的每份 rtk 数据都在 dsh 家里」的口径。
 */
export interface HookPaths {
  /** pipeline 配置目录（`RTK_CONFIG_DIR`）。里面只有本包生成的那一份 `pipeline.toml`。 */
  readonly configDir: string;
  /**
   * 子进程的 `HOME` / `USERPROFILE`（Windows 上还有 `APPDATA` / `LOCALAPPDATA`）。
   *
   * **必须单独给它一个**：`rtk hook` 把 pipeline 状态写到 `user_dirs::data()`（macOS 是
   * `~/Library/Application Support/rtk/`），而那份状态文件的一次干净加载会**删掉**用户
   * 全局的同名文件——实测：干净 `HOME` 下跑一次，用户那份「我的 pipeline 有错」的诊断就没了。
   * 指到这里之后实测 macOS 用户全局目录一个字节不变。Windows 上 rtk 走 Known Folder API，
   * 这四个变量**可能**不被读取，隔离效果尚未在 Windows 真机验证过。
   */
  readonly home: string;
  /**
   * `hook.db`：`rtk hook` 每次都会往 `commands` 表写一行（`original_cmd` 形如 `Bash pnpm`）。
   *
   * 单独一个库、不并进 `history.db`：`commands` 是 Insights「按命令」表的输入，混进
   * `Bash pnpm` 这类不是用户命令的行之后，那张表会同时出现真命令与清洗流水。
   */
  readonly dbPath: string;
}

/** 解析 `rtk hook` 的三处位置（与账本同一个根：`$DSH_HOME/rtk/`）。 */
export function resolveHookPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HookPaths {
  const dir = path.join(resolveDshHome(undefined, env), LEDGER_DIR);
  return {
    configDir: path.join(dir, "config"),
    home: path.join(dir, "home"),
    dbPath: path.join(dir, "hook.db"),
  };
}

/**
 * 写好 pipeline 配置并交回可用的配置目录。
 *
 * 每次装配都重写：那份文件是本包的产物（第一行就写明「改动会被覆盖」），留着旧版本只会让
 * 用户在升级之后继续跑上一条链。父目录建不出来时回 `undefined`——调用方据此**不启用**这条
 * 路径（实测 `RTK_CONFIG_DIR` 指到不存在的目录时 `rtk hook` 回 0 字节，看着像「没收益」，
 * 其实是配置根本没读到）。
 * @param paths - 三处位置
 * @param toml - 配置正文（`lib/rtk-hook.ts` 的 `pipelineToml()`）
 * @returns 建好并写好的配置目录，或 `undefined`
 */
export function prepareHookConfig(paths: HookPaths, toml: string): string | undefined {
  let ready: string | undefined;
  try {
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(paths.configDir, "pipeline.toml"), toml, { mode: 0o600 });
    ready = paths.configDir;
  } catch {
    ready = undefined;
  }
  return ready;
}

/**
 * 抹掉两个 DB 变量，交给 `rtk rewrite` 的子进程。
 *
 * **为什么改写那一路要抹**：`rtk rewrite` 只求改写、不碰任何库（实测 `RTK_DB_PATH` 指到不存在的
 * 目录也照常回 rc=3 与改写串）。把父进程里可能存在的 `RTK_DB_PATH` 带进去，等于让「改写出来
 * 是什么」取决于一个本插件解释不了的环境——抹掉之后 rewrite 的行为只由命令与 rtk 版本决定。
 * （真正执行的那条命令由 `withRtkLedgerEnv` 自己注入，不靠继承。）
 *
 * 值用 `undefined` 而不是删键：宿主的 env 会与父进程合并，只删键抹不掉 shell 里已有的同名变量，
 * 值为 `undefined` 才是 tombstone（`deepEqual` 也把它算作一项，测试据此钉住形状）。
 *
 * `DSH_RTK_DB_PATH` 一并抹：那是本插件早期版本用过的变量名，用户按旧 README 手动导出过，
 * 我们不再读它，也不该让它流进任何子进程。
 *
 * `RTK_RECALL_DB` 也抹：插件自己那两条子进程（`rtk rewrite` / `rtk pipe`）都带
 * `RTK_RECALL=0`（见 `lib/cli.ts` 的两个 ENV 表），本来就不碰 recall 库；抹掉这一个是为了
 * 让「父 shell 里有人导出过它」不至于改变它们的行为——与 `RTK_DB_PATH` 同一条理由。
 * @param env - 装配层造的 env
 * @returns 抹过的副本（入参不被写）
 */
export function withoutRtkDbEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    ...env,
    RTK_DB_PATH: undefined,
    DSH_RTK_DB_PATH: undefined,
    RTK_RECALL_DB: undefined,
  };
}
