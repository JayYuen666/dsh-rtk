/**
 * 用 rtk 的 pipeline 引擎做「输出卫生」，切段仍交给本包的头尾窗口。
 *
 * 为什么要这一步：`lib/output-window.ts` 只会按行数切头尾，它不认识 ANSI 转义、不认识
 * `\r` 进度条、也不知道 40 行一模一样的 `WARNING` 只是一条信息。那三件事 rtk 的 method
 * 链（`ansi` / `progress` / `dedup` / `base64-elide`）做得很好，而它们**只能**从
 * `rtk hook <agent>` 这条入口到达——`rtk pipe` 是编译期写死的 27 个 filter，不读 pipeline。
 *
 * 实测（792 行 / 32,550 B 的构建日志，`RTK_CONFIG_DIR` 指向本文件写出的那份配置）：
 * 只窗口 → 10,366 B；先过这条链再窗口 → 9,228 B（再省 11%）；而 200 行重复警告那种形状
 * （低于窗口阈值、窗口一个字节都不动）→ 6,200 B 压到 81 B。
 *
 * 三条硬约束（都来自 rtk 自己的源码，不是推测）：
 *
 * 1. **`tool_name` 必须写 `Bash`**（`src/hooks/posthook.rs` 的 `subject_of_for` →
 *    `engine/src/harness.rs` 的 `CLAUDE_TOOLS`）。小写 `bash` 会落到 `Subject::Any`，
 *    而 `rtk:posthook` 没有 any 规则 → stdout 零字节，看起来像「rtk 没装」。
 * 2. **`extends` 必须写在 `[pipeline]` 段下并配 `schema_version = 1`**。写顶层会被判
 *    `E001 unknown section`，而 rc 仍是 0（诊断只落在 `pipeline-status.json`）。
 * 3. **必须自带一条 `[[hook.after_tool.shell]]` 规则**：只 `extends` 时继承来的
 *    `term-default` 带 `when = { is_rtk_command = false }` 且默认 `min_size = 512`，
 *    实测三种载荷全部「不发」。所以本文件写的是**自己的链**，且刻意不含 `cap`：
 *    切段归本包的窗口，两处都切会让省略量对不上、也会让护栏看见两种省略标记。
 *
 * 副作用隔离：`rtk hook` 会写两处 rtk 自己的数据目录（`pipeline-status.json` 与
 * `pipeline.log`），那两处只认平台数据目录、不认 `RTK_CONFIG_DIR`。实测（干净 `HOME`、
 * `RTK_CONFIG_DIR` 指向一份干净的配置）它会**删掉**用户全局那份「我的 pipeline 有错」的
 * 状态文件——因为这次加载没有诊断。所以子进程的 `HOME`/`USERPROFILE`（Windows 上还有
 * `APPDATA`/`LOCALAPPDATA`）也一并指到 `$DSH_HOME/rtk/home`；macOS 上实测之后用户全局目录
 * 一个字节都不变。Windows 上 rtk 走 Known Folder API，这几个变量可能不被读取，尚未真机验证。
 */

/**
 * 链的内容：只做「同一份信息的更短写法」，**不含 `cap`** 与任何会丢内容的方法。
 *
 * `progress` 与 `base64-elide` 在 rtk 自己的 `MethodInfo` 里标了 `lossy`（前者丢掉
 * 进度条的中间帧、后者把长 base64 换成长度注记），其余两个是无损变换。要它们是因为
 * 这两类内容在本包窗口里占着大量行数却零信息量。
 *
 * **刻意排除 `base64-elide`**（它也在 rtk 的 `term` 出厂链里）：它的 `recovery` 是
 * `Recovery::None`，长 base64 换成长度注记之后**再也取不回原文**。实测把它从链里去掉，
 * 792 行构建日志的压缩结果**逐字节相同**（两种配置都是 23,288 B）——它省下的那点空间
 * 换的是不可逆的损失。
 */
const HOOK_CHAIN: readonly string[] = ["ansi", "progress", "dedup"];

/**
 * 写进 `RTK_CONFIG_DIR` 的那份 `pipeline.toml`。
 *
 * `min_size` 取 256（不是出厂 512）：本包只在这条输出已经过了 `minBytes` 之后才来问，
 * 再叠一道 512 只会让「200 行重复警告」那种形状（6,200 B）永远拿不到压缩。
 * @returns 配置文件正文
 */
export function pipelineToml(): string {
  const use = HOOK_CHAIN.map((each) => `"${each}"`).join(", ");
  return [
    "# 由 dsh-rtk 生成；改动会在下一次调用时被覆盖。",
    "# 目的只有一个：让 rtk 的 pipeline 引擎做 ANSI / 进度条 / 相邻重复的清理，切段交给插件。",
    "schema_version = 1",
    "",
    "[pipeline]",
    'extends = "rtk:posthook"',
    "",
    "[guards]",
    "never_worse = true",
    "min_size = 256",
    "",
    "[[hook.after_tool.shell]]",
    'name = "dsh-clean"',
    "when = { is_rtk_command = false, bytes_gte = 256 }",
    `use = [${use}]`,
    "",
  ].join("\n");
}

/** `rtk hook` 要求的最小载荷（字段名与 `src/hooks/posthook.rs` 逐字对齐）。 */
export interface HookPayloadInput {
  readonly command: string;
  readonly stdout: string;
}

/**
 * 这条子进程的环境：三处隔离 + 关遥测。
 *
 * 逐项的理由：
 * - `RTK_CONFIG_DIR` → `$DSH_HOME/rtk/config`：链是**本包的**配置，不该读出用户全局那份。
 *   实测指到不存在的目录时 `rtk hook` 回 0 字节（看着像「没收益」），所以调用方必须先
 *   把目录建出来（`prepareHookConfig`）。
 * - `RTK_DB_PATH` → 单独一个 `hook.db`：`rtk hook` 每次都往 `commands` 写一行
 *   （`original_cmd` 形如 `Bash pnpm`）。并进主账本会让 Insights 的「按命令」表混进不是
 *   用户命令的行。
 * - `RTK_RECALL_DB` → 与 C 形态同一个 `recall.db`：`progress` 那一步标了 `recovery: Recall`，
 *   指针必须有个活着的库可指。用 dsh 自己那份，页脚那句「被折叠的输出另存了 N 条」因此
 *   把两条路径都算进去。
 * - `HOME` / `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` → `$DSH_HOME/rtk/home`：见
 *   `HookPaths.home`（不隔离会删掉用户全局的 `pipeline-status.json`）。Windows 上 rtk 走
 *   Known Folder API，这几个变量**可能**不被读取；这一项尚未在 Windows 真机验证过。
 * - `RTK_TELEMETRY_DISABLED`：与另外两条子进程同一口径。
 * @param input - 三处位置
 * @returns 直接交给 `spawn({env})` 的表
 */
export function hookEnvOf(input: {
  readonly configDir: string;
  readonly home: string;
  readonly dbPath: string;
  readonly recallDb: string;
}): Record<string, string> {
  return {
    RTK_CONFIG_DIR: input.configDir,
    RTK_DB_PATH: input.dbPath,
    RTK_RECALL_DB: input.recallDb,
    HOME: input.home,
    USERPROFILE: input.home,
    APPDATA: input.home,
    LOCALAPPDATA: input.home,
    RTK_TELEMETRY_DISABLED: "1",
  };
}

/**
 * 拼 PostToolUse 载荷。
 *
 * `tool_name` 写死 `Bash`：见模块头第 1 条。`tool_response` 只给 `stdout`/`stderr`/
 * `interrupted`/`isImage` 四位——`process_shell` 只读这四个。
 * @param input - 命令与要清洗的正文
 * @returns JSON 字符串
 */
export function buildHookPayload(input: HookPayloadInput): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: input.command },
    tool_response: { stdout: input.stdout, stderr: "", interrupted: false, isImage: false },
  });
}

/** 判「是能取字段的对象」：`typeof === "object"` 单独一条会把数组与 null 也放进来。 */
function isFieldBag(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取一层对象字段；不是对象就给 `undefined`（三层判空只写一次）。 */
function fieldOf(value: unknown, key: string): unknown {
  return isFieldBag(value) ? value[key] : undefined;
}

/** 按三级路径取 `stdout`；只认非空字符串。 */
function stdoutOf(parsed: unknown): string | undefined {
  const specific = fieldOf(parsed, "hookSpecificOutput");
  const updated = fieldOf(specific, "updatedToolOutput");
  const stdout = fieldOf(updated, "stdout");
  return typeof stdout === "string" && stdout !== "" ? stdout : undefined;
}

/**
 * 从 `rtk hook` 的 stdout 里取回清洗后的正文。
 *
 * 三种「不该当成成功」的形状一起给 `undefined`：什么都不发（`never_worse` 判无收益、
 * `min_size` 没过、或 `is_rtk_command` 挡住了）、发出来的不是 JSON（OSS 版没有引擎）、
 * JSON 里没有 `hookSpecificOutput.updatedToolOutput.stdout`。
 * @param raw - 子进程 stdout 原文
 * @returns 清洗后的正文，或 `undefined`（调用方回落到本地窗口）
 */
export function parseHookOutput(raw: string): string | undefined {
  let stdout: string | undefined;
  const trimmed = raw.trim();
  if (trimmed !== "") {
    try {
      stdout = stdoutOf(JSON.parse(trimmed));
    } catch {
      stdout = undefined;
    }
  }
  return stdout;
}
