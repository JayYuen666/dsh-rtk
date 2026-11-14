// dsh-rtk 宿主侧入口。
//
// 三块装配都在本文件：C 形态（per-agent 遮蔽 bash，`installPrefixShadow`）、
// B 形态（post-execute 按 filter 压输出，`installPostExecuteListener`）、以及把它们
// 串起来的 Config 与 `apply`。两个 installer 收**取值函数**（`prefixReadersOf` / `pipeReadersOf`
// 造出来的那一份），不接收已经读好的值——volatile 字段必须在消费点现读，见那两个工厂的注释。
import { readFile } from "node:fs/promises";
import Schema from "@deepseek-ai/schemastery";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextFormed, UserMessage } from "@deepseek-ai/dsh-llm";
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import type {
  PostToolDecision,
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";

import type { Context, Volatile } from "@deepseek-ai/cordis";
import type { SpillRef } from "@deepseek-ai/dsh-spill";
import { isJsonValue } from "@deepseek-ai/dsh-util-values";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { hasMethods, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

import { RTK_REWRITE_ENV, runRtkPipe, runRtkRewrite } from "./lib/cli.ts";
import { DEFAULT_ENABLED_FILTERS, filterOf } from "./lib/command-filter.ts";
import type { RewrittenCalls } from "./lib/dedup.ts";
import { createRewrittenCalls, shouldSkipPipe } from "./lib/dedup.ts";
import { guardCompressed } from "./lib/guard.ts";
import { MESSAGES } from "./lib/messages.ts";
import type { Messages } from "./lib/messages.ts";
import { findOnPath, pipeStructuralReject } from "./lib/prefix-safety.ts";
import { createRewriter } from "./lib/rewrite.ts";
import type { RewriteCache } from "./lib/rewrite-cache.ts";
import { createRewriteCache } from "./lib/rewrite-cache.ts";
import { resolveWorkdir, shouldSkipRewrite } from "./lib/rewrite-gate.ts";
import { verifyRewrite } from "./lib/rewrite-verify.ts";
import { shapeMatches } from "./lib/shape-precheck.ts";
import type { StatsStatus } from "./lib/stats-remote.ts";
import { installStatsRemote } from "./lib/stats-remote.ts";
import { createDeferredStatsStore } from "./lib/stats-store.ts";
import type { StatsDomainFacility, StatsStore } from "./lib/stats-store.ts";
import { capCompressed, spillOriginal } from "./lib/spill.ts";
import type { SpilledOriginal } from "./lib/spill.ts";
import { readSpillFullText } from "./lib/spill-read.ts";
import type { Extracted } from "./lib/stdout-extract.ts";
import { extractBody, reassemble } from "./lib/stdout-extract.ts";
import { tokenPricerOf } from "./lib/tokens.ts";
import type { TokenPricer } from "./lib/tokens.ts";
import { MIN_RTK_VERSION, probeRtkVersion } from "./lib/rtk-version.ts";
import { detectVitestMajor } from "./lib/vitest-major.ts";
import { appendWarnHint, isCargoTest } from "./lib/warn-hint.ts";

/**
 * 本包的消息生产者名。
 *
 * 官方的 `MessageSourceMap` 是合并式可扩展的和类型：每个生产者在自己模块里 `declare module`
 * 声明自己的 `kind`，没有共享的 catch-all —— 这是宿主契约，不是本包的发明。`form: "notice"`
 * 是「一次性发生的事」，官方据此要求带一行 ≤120 字的 `summary`（`ContextFormed` 判别的）。
 */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    rtk: { readonly kind: "rtk" } & ContextFormed;
  }
}

/** 一次 `rtk --version` 探测的预算：够慢机器启动一次二进制，又不至于卡住设置卡。 */
const VERSION_PROBE_MS = 2000;

/** 探测与改写两个 spawn 的上限：一份版本串 / 一条改写命令，都用不到 64KiB 之上。 */
const PROBE_STDOUT_BYTES = 65_536;

/** 子进程面。生产环境是 `ctx.subprocess`；半栈测试从这里塞一个真 spawn 的桩。 */
export interface SubprocessFace {
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
}

/** 工作目录服务里本插件唯一用到的那个方法。 */
export interface WorkingDirectoryFace {
  readonly ensure: (agent: Agent, signal?: AbortSignal) => Promise<string>;
}

/**
 * 工具注册表里本插件唯一用到的那一枚方法。
 *
 * 只有 `get`：注册遮蔽体走的是 `agent.ctx.tools`（per-agent 作用域），不是这个全局表。
 * 返回 `unknown` 而不是宿主的 `ToolDefinition`：那个类型是编译期承诺而非运行期事实，
 * 而遮蔽体会把拿到的字段整份转发出去——形状判不过就不装，判据放在 `isToolDefinition`。
 *
 * **`scope` 不是可选装饰**：宿主的 `get(name, scope?)` 在 `scope` 缺省时只查**全局视图**，
 * 而 `bash` 在这套 web profile 里是 **agent preset 按 agent 作用域**注册的（全局那份
 * `include:tool-bash` 是 disabled）。所以遮蔽层取定义时必须把当前 agent 传进来，
 * 缺了它恒取不到、整层静默失效。类型上留成必填，正是为了让「忘了传」在编译期就红。
 */
export interface ToolsFace {
  readonly get: (name: string, scope?: Agent) => unknown;
}

/**
 * agent 注册表里本插件唯一用到的那一枚读面。
 *
 * 只为了**插件晚装载**这一种情形：`agent/created` 只对之后新建的 agent 触发，而插件在
 * 一个已经跑着的宿主里被装上（HMR、`dsh plugin add` 之后不重启、profile 改动后热更）时，
 * 那些**已经存在**的 agent 就永远拿不到遮蔽层——模型继续走原生的 bash，用户以为开了却
 * 没有任何效果。宿主的 `AgentRegistry.list()` 正好是这份全集
 * （installed `@deepseek-ai/dsh-agent` 的 `list()` 注释：'All live agents, in registration
 * order'），兄弟仓 `dsh-session-rescue` 也用它判存活。
 *
 * `list` 声明成可选：它在 0.2.x 两个 rc 线上都存在，但这一层是按运行期事实判的
 * （与 `isToolDefinition` 同一纪律），拿不到就退回「只听 agent/created」。
 */
export interface AgentsFace {
  readonly list: () => readonly unknown[];
}

/** `hasMethods` 只证明「有个可调用的 list」，这里补类型谓词（与 `isSpillStore` 同一写法）。 */
function isAgentsFace(value: unknown): value is AgentsFace {
  return hasMethods(value, ["list"]);
}

/**
 * `tools/post-execute` 的监听器形状，与宿主 `Events` 里那一条同名事件逐字对齐：
 * 先 `await next()` 拿下游决定，再决定接、换、还是原样退回。
 */
export type PostExecuteListener = (
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  next: () => Promise<PostToolDecision>,
) => Promise<PostToolDecision>;

/** 本插件订阅的两个事件及其载荷。键集就是 `HostContext.on` 的重载面。 */
export interface HostEvents {
  readonly "agent/created": (payload: { agent: Agent }) => void;
  readonly "tools/post-execute": PostExecuteListener;
}

/**
 * 宿主 logger 里本包用到的那一位。官方 `ctx.logger(name)` 返回具名 facade
 * （installed `@deepseek-ai/cordis/lib/types/logger.d.ts:55-58`，方法形如 `(format, ...param)`）。
 * 只声明有结构最小的一份：类类型带 private 字段、要按名义类型比，测试假对象给个同形状对象就够了。
 */
interface Log {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * 宿主上下文里本插件用到的那个子集。
 *
 * 刻意只声明用到的成员：一是让半栈测试能只造这几样就跑起来，二是不把宿主整个 `Context`
 * 的形状压进来（那会让升级 rc 线时多出一片与本事无关的类型面）。
 */
export interface HostContext {
  /** 具名 logger。**可选**：异常 ctx 或测试替身可能没有它（回退 console，见 `loggerOf`）。 */
  readonly logger?: (name: string) => Log;
  readonly tools: ToolsFace;
  readonly subprocess: SubprocessFace;
  readonly workingDirectory: WorkingDirectoryFace;
  /** 服务读取口。`spillStore` 不在 `inject` 里：没装 spill 的 profile 该照常压缩，只是不带全文提示。 */
  readonly get?: (name: string) => unknown;
  readonly on: <EventName extends keyof HostEvents>(
    name: EventName,
    listener: HostEvents[EventName],
  ) => void;
}

/**
 * C 形态的装配参数。收已解析的值而不是整个 `Config`：volatile 与非 volatile 字段的读法不同
 * （前者要 `.get()`），把那个差别收在 `apply` 一处，本函数就能脱离 cordis 的配置投影单独测。
 */
export interface PrefixOptions {
  readonly enabled: () => boolean;
  readonly forms: readonly string[];
  /**
   * 下面五位 volatile 配置项**都是取值函数，不是值快照**。
   *
   * 它们标了 `.volatile()`，宿主把卡片上的改动写进配置后，本插件下一次读就该看到新值。
   * 早先这几位是裸值：`apply` 装配时 `.get()` 一次就固定下来，于是「卡片改了、存了、刷新也持久」
   * 与「运行中的改写行为」是两件互不相干的事——README 承诺的「下一次工具调用即生效」对其中七项
   * 是假话。取值的差别必须收在这一层：消费点每次现读，才与 `enabled` 的口径一致。
   */
  readonly denyCommands: () => readonly string[];
  readonly vitestMaxMajor: number;
  readonly rewriteTimeoutMs: number;
  readonly warnHint: () => boolean;
  /** `RTK_REWRITE_HOST` 的取值；空串 = 不设该变量。 */
  readonly rewriteHostEnv: () => string;
  /** 诊断日志：非 `undefined` 时每次改写记一行（`logFilterMode` 装配，默认关）。 */
  readonly log: ((line: string) => void) | undefined;
  /**
   * 探到的 rtk 是否达下限（`undefined` = 还没探完 / 探不到）。
   *
   * **每次调用现读**，不在装配期判一次：探测是异步的，装配那一刻它通常还没回来——按那一刻
   * 的快照判，会把「rtk 好好的」判成「没装」。`false` 时这一层退回原样执行（见
   * `probeVersion` 注释：版本过低 = 压缩不启用，与 spec §7.1、README 的承诺一致）。
   */
  readonly supported: () => boolean | undefined;
}

/** 跨调用共享的三份依赖，都在 `apply` 顶部造一次。 */
export interface PrefixDeps {
  readonly messages: () => Messages;
  readonly rewriteCache: RewriteCache;
  readonly rewrittenCalls: RewrittenCalls;
  /**
   * 记一次「改写了一回」（spec §6 的按形态分账：prefix 只记命令数）。
   *
   * 从 `PrefixDeps` 而不是 `PrefixOptions` 进来：Options 装的是**配置值**，而这是副作用，
   * 两者装配时机与测试替身都不一样（Options 在 `installPrefixShadow` 的参数里，deps 在
   * 遮蔽层的闭包里）。
   */
  readonly countRewrite: () => void;
}

/**
 * 从模型参数里取出「要转发的参数」与「命令串」。
 *
 * 两者一起返回而不是分成两个函数：命令串非空就意味着 `args` 一定是个对象，把那个事实留在
 * 这一处，调用方拿到的就是已经收窄过的参数表——`{ ...args }` 这种对 `unknown` 的展开也就
 * 不必再在外面写一次分支（那个分支永远走不到 else，属于自欺的覆盖率）。
 */
function readInvocation(
  args: unknown,
): { readonly forwarded: Record<string, unknown>; readonly command: string } | undefined {
  // 单出口：`consistent-return` 按 treatUndefinedAsUnspecified 读，`return undefined;` 与
  // `return 值;` 混在一支函数里就判红。所以整条收在一个 `if` 里、末尾统一 return。
  let invocation:
    | { readonly forwarded: Record<string, unknown>; readonly command: string }
    | undefined;
  if (typeof args === "object" && args !== null) {
    // 逐键拷贝而不是 `args as Record<string, unknown>`：后者是断言（工作区把
    // no-unsafe-type-assertion 判成 error），前者只是把一个已确认是对象的值抄进新表。
    const forwarded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      forwarded[key] = value;
    }
    const { command } = forwarded;
    if (typeof command === "string") {
      invocation = { forwarded, command };
    }
  }
  return invocation;
}

/**
 * rewrite 的子进程 env：三枚行为开关 + 可选 `RTK_REWRITE_HOST`（空串 = 不设该变量）。
 *
 * 用 `RTK_REWRITE_ENV` 而不是 pipe 那一套——后者带 `RTK_NO_TOML=1`，会让 TOML-only 的
 * 命令整类失去改写。
 */
function rewriteEnv(options: PrefixOptions): Record<string, string> {
  const host = options.rewriteHostEnv();
  return host === "" ? { ...RTK_REWRITE_ENV } : { ...RTK_REWRITE_ENV, RTK_REWRITE_HOST: host };
}

/**
 * 认出工具执行上下文里的那个 agent。
 *
 * `Agent` 的最小可判面就是 `id`（`interface Agent { readonly id: SessionId }`，SessionId 是
 * 字符串 brand）。用 `in` 收窄而不是 `as` 断言：这一层不解释 agent 的其余形状，断言只会把
 * 「宿主换了形状」这件事挪到运行期别处去炸。
 */
function isAgent(value: unknown): value is Agent {
  return (
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
  );
}

/**
 * 认出一个真的能执行的工具定义。
 *
 * 类型上 `ToolsService.get` 只会回 `ToolDefinition`，但那个类型是编译期的承诺：别的插件往
 * 注册表里塞一个字段不全的工具时，运行期拿到的东西并不保证有 `execute`。遮蔽体是我们自己
 * 写的，一旦继承了半成品再注册出去，等于把那个缺口盖住、错误挪到每次调用时才炸——
 * 所以这里按运行期事实判一遍，判不过就宁可不装。
 */
function isToolDefinition(value: unknown): value is ToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function" &&
    // `output.render` 也要判：宿主 `ToolsService.register` 会因此抛
    // `TypeError: tool "x" must declare output { schema, render, presentationMeta? }`
    // （installed `@deepseek-ai/dsh-tools/lib/index.js` 的 register 校验）。只判 `execute`
    // 的话，遮蔽体 `{...orig}` 继承到一个半成品 bash 时，抛错点会落在 `agent.ctx.tools.register`
    // 里（一个回调解里），而不是被这道门静默跳过——那条错误的可见度差得多。
    "output" in value &&
    typeof value.output === "object" &&
    value.output !== null &&
    "render" in value.output &&
    typeof value.output.render === "function"
  );
}

/**
 * 跑一次 `rtk --version` 读原始回执。
 *
 * 结果有三个去处：**设置卡的状态行**（路径 + 版本）、**装配期的一条 warn**（探不到与低于下限
 * 各一句）、以及**运行期门禁**（`supported === false` 时两层都停手，见 `PrefixOptions.supported`
 * 与 `PipeOptions.supported`）。早先这里写的是「只用于设置卡、不参与门禁」——那等于把 README
 * 的「below that it reports the version it found and does nothing」只兑现了一半。
 *
 * 超时 / 非零退出 / 读不到一律 `undefined`：探测失败不该让装配失败（**探不到**与**太旧**是
 * 两件事，前者放行、后者停手）。
 */
export async function readRtkVersion(ctx: HostContext): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, VERSION_PROBE_MS);
  let handle: SubprocessHandle | undefined;
  // 单出口（`let` + try/catch 里赋值）：try 块内 `return` 会让 consistent-return 判成
  // 「有的分支返回值、有的不返回」——它在工作区按 treatUndefinedAsUnspecified 生效。
  let text: string | undefined;
  try {
    handle = ctx.subprocess.spawn({
      argv: ["rtk", "--version"],
      cwd: process.cwd(),
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: PROBE_STDOUT_BYTES },
        stderr: { maxBytes: PROBE_STDOUT_BYTES },
      },
      graceMs: VERSION_PROBE_MS,
      env: { ...RTK_REWRITE_ENV },
      signal: controller.signal,
    });
    const outcome = await handle.done;
    // stdout 面本身可能缺席（宿主契约里它是可选的）：那等于「探到了个空」。
    const reader = handle.collected.stdout;
    const raw = reader === undefined ? "" : reader.readFrom(0).text.trim();
    // 三条同时成立才算探到版本：没被信号杀、退出码 0、读到了非空文本。
    text = outcome.signal === null && outcome.exitCode === 0 && raw !== "" ? raw : undefined;
  } catch {
    // ENOENT / provider 失败：探不到就是探不到，装配照常。
  } finally {
    clearTimeout(timer);
    // 幂等：已经退出的进程再 terminate 一次是空操作。
    handle?.terminate();
  }
  return text;
}

/**
 * 前缀形态支持哪些平台。**win32 明确判否**，而不是「没测过就都不支持」那种含糊档。
 *
 * 三条理由（spec §7.2）：
 *   1. rtk 的 Windows 分发面（`winget install rtk-ai.rtk`）没有在真机验过；
 *   2. pwsh 的命令解析与 rtk 的 `.exe`/`.cmd` 存在形态全部未验；
 *   3. 前缀形态一旦把命令写坏（rc=127），损害是「本来能跑的命令不能跑」——比 pipe 形态
 *      「不压缩」严重一个量级。
 *
 * 降级方向也重要：这里返回 false 是**整层不装**（连 `agent/created` 监听器都不挂），
 * 不是「装上一个不干活的壳」。装了壳会让模型看到的 bash 来自本插件、出问题要往这里查；
 * 不装则宿主原生 bash 原样生效，插件在该平台上等于不存在。
 *
 * 注意连带后果：v3.5 的 `enabledForms` 默认是 `['prefix']`、pipe 层默认关，所以在 win32 上
 * **两层都不装**——插件装载但完全不动命令与输出。这不是缺陷，是「默认只开前缀」在那条平台上的
 * 直接投影；要看效果的 Windows 用户得显式把 `enabledForms` 改成 `['pipe']`。
 */
export function prefixSupportedOn(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/**
 * 装配瞬间**已经存在**的 agent 全集。
 *
 * 两条纪律：① 服务面按运行期事实判（`ctx.get?.("agents")` 交回 `unknown`，逐方法判可调用），
 * 拿不到就回空表、退回「只听 `agent/created`」；② 每个元素仍要过 `isAgent`——`list()` 的
 * 元素类型是编译期承诺，而遮蔽层会往它们身上注册工具，形状不对就是一次运行期崩溃。
 */
function readLiveAgents(ctx: HostContext): readonly Agent[] {
  const found = ctx.get?.("agents");
  if (!isAgentsFace(found)) {
    return [];
  }
  const listed: unknown = found.list();
  return Array.isArray(listed)
    ? listed.filter((each: unknown): each is Agent => isAgent(each))
    : [];
}

/**
 * C 形态装配：给每个新 agent 在它自己的作用域里注册一个同名的 bash，内部先求改写再转调。
 *
 * 装配期门禁三条，缺一不装：
 *   1. `options.forms` 含 `prefix`；
 *   2. 平台被认作支持（见 `prefixSupportedOn`）；
 *   3. 装配时 `findOnPath("rtk")` 命中。
 *
 * **`enabled` 不在这三条里**，它在 `execute` 里逐次现读（`options.enabled()`）——与 B 形态同一分工：
 * 装配期只判「形态」与「环境能不能装」，运行期判「用户开没开」。早先这里还有一条 `!options.enabled()`
 * 的早退，而 `enabled` 默认 false，于是**默认路径是坏的**：用户装好插件、在卡片上打开总开关、
 * 下一次调用 bash 时什么都没发生——因为遮蔽层在装配那一刻就没装、`agent/created` 监听器也没挂，
 * 之后再打开开关没有任何东西会去补装。spec §4.0.1 的伪码本来就把这道判断写在 `execute` 里。
 *
 * **版本门也不在这里**：装配期只判「rtk 在不在 PATH 上」，版本要等异步探测回来才知道。所以
 * 「低于下限就停手」落在 `execute` 里的 `options.supported() === false`（逐次现读），不是
 * 这一层的门禁之一。早先这里写的是「版本不在门禁里，rtk 自己对不认识的东西回 rc=1」——
 * 那对 `rewrite` 成立，对 `pipe` 不成立（filter 名它不认识，输出照喂），所以停手得由我们做。
 *
 * 用 `agent.ctx.tools.register` 注册同名工具是宿主的正式语义（scoped 遮蔽 global、随 agent
 * 销毁），不是绕过任何机制：`ToolsService.register` 的 JSDoc 与 `docs/architecture.md`
 * 都明写插件该用 `agent.ctx` 注册 per-agent 工具。
 *
 * `platform` 可注入只为可测，与 `findOnPath` 的第二个参数同一理由：win32 的判定在 POSIX
 * 测试机上永远走不到，若焊死 `process.platform`，那条分支只能靠放宽阈值或 ignore 注释糊过去。
 */
export function installPrefixShadow(
  ctx: HostContext,
  options: PrefixOptions,
  deps: PrefixDeps,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!options.forms.includes("prefix")) {
    return;
  }
  if (!prefixSupportedOn(platform)) {
    return;
  }
  if (findOnPath("rtk") === undefined) {
    return;
  }

  /**
   * 给一个 agent 装上遮蔽层。
   *
   * 抽成具名函数是因为有两个入口：`agent/created`（之后新建的）与装配瞬间**已经存在**的
   * （见下面 `readLiveAgents` 那一段）。两条入口都必须走同一份实现，复制一遍就有两个口径。
   */
  const installOn = (agent: Agent): void => {
    // **必须把 agent 当 scope 传进去**。`ToolsService.get(name, scope)` 的 `scope` 缺省是
    // 「全局视图」（宿主 d.ts 原文 `omitted = the global view`），而 web-app 那套 profile
    // 把 `bash` 交给 **agent preset 按 agent 作用域注册**（`presets/ptc.patch.yml` 的
    // `config.plugins` 里有 `tool-bash`，全局那份 `include:tool-bash` 是 disabled）。
    // 不传 scope 的直接后果是这里恒取不到 `bash`，整层遮蔽**静默失效**——真机症状是
    // `enabledForms: [prefix]` 配好、插件也 active，但裸 `git status` 依然是原生输出，
    // 而日志里一个字都没有。这一格是本仓唯一没法靠单测发现、必须真宿主才暴露的缺陷。
    //
    // 读成 `unknown` 再收窄：`get` 的返回类型是宿主的编译期承诺，不是运行期事实。
    const found: unknown = ctx.tools.get("bash", agent);
    if (!isToolDefinition(found)) {
      // 该 agent 的视图里没有可执行的 `bash`：C 形态无处遮蔽，跳过。
      //
      // 这里**说一声**而不是彻底静默：遮蔽层失效是「功能没了但一切看起来正常」的形态，
      // 唯一能让人发现的线索就是这行日志。`logFilterMode: off`（默认）时 `options.log`
      // 是 undefined，所以它默认不吵；排查时打开日志就能看到。
      options.log?.("[rtk] prefix: this agent has no executable bash tool; shadow not installed");
      return;
    }
    const orig = found;
    // 继承被遮蔽工具的全部字段（description/parameters/output/render 等），不手抄——
    // 手抄会随宿主升级漂移，模型看到的 schema 也会与真实执行面不符。
    //
    // 下面这两条是遮蔽层最容易走偏的地方，别再走回去：
    //
    // ① **一律转调 `orig.execute`，不要自己 spawn。** sandbox 事实、后台任务、
    //    promote-on-timeout、stdout 字节帽、原文落库（spill）、沙箱升档审批
    //    （`sandbox_permissions` → `approveEscalation`）全在原实现里。插件只改一个字符串
    //    （`command`），其余治理一层不动；自己 spawn 等于把这一整层重写一遍、且必然漏。
    //
    // ② **审批看到的是模型原始命令，不是改写后的命令。** 遮蔽发生在 `execute` 内部，也就是
    //    管线 `tools/pre-execute` **之后**：通用命令审批（auto-review / hooks / 别家 guard）
    //    在 pre-execute 求值、读的是冻结的原始参数（`cargo test`），而实际跑的是 rtk 改写出来
    //    的那条（`rtk cargo test`）。这不是缺陷，是遮蔽的必然形态——**别试图在 execute 里重做
    //    审批**，那会审两遍，且第二遍看到的已经不是用户请求的东西。危险命令（`rm -rf`、
    //    `git push --force`）不在 rtk 的改写面里，原样执行、原样受审。
    const shadow: ToolDefinition = {
      ...orig,
      async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
        if (!options.enabled() || options.supported() === false) {
          return orig.execute(args, exec);
        }
        const invocation = readInvocation(args);
        if (invocation === undefined) {
          // 没有可读的命令串：不是本插件认得的调用形状，原样交回去。
          return orig.execute(args, exec);
        }
        const { command } = invocation;
        // 第三位是模型这次调用传的 `workdir`：遮蔽层转调原 execute 时 `args` 原样带下去，
        // 原实现按它跑；插件算 cwd 时不读它就会与「命令实际跑在哪个目录」分叉。
        const cwd = await resolveWorkdir(
          exec,
          async (target) =>
            isAgent(target) ? ctx.workingDirectory.ensure(target, exec.signal) : undefined,
          invocation.forwarded["workdir"],
        );
        const skip = shouldSkipRewrite(command, {
          denyCommands: options.denyCommands(),
          cwd,
          vitestMaxMajor: options.vitestMaxMajor,
        });
        if (skip !== undefined) {
          return orig.execute(args, exec);
        }
        // 改写器按调用造：cache 跨调用共享，而 cwd 每次不同——它既是 spawn 的工作目录，
        // 也是缓存 key 的一半（rtk rewrite 的退出码取决于从 cwd 向上找到的 .claude/settings*）。
        const rewriter = createRewriter({
          cwd,
          runRewrite: (cmd, signal) =>
            runRtkRewrite({
              command: cmd,
              cwd,
              signal,
              timeoutMs: options.rewriteTimeoutMs,
              env: rewriteEnv(options),
              subprocess: ctx.subprocess,
            }),
          cache: deps.rewriteCache,
        });
        // 改写预算 = 调用方 signal 与部署超时「先到的那个」。超时按原样执行（瞬时失败不进缓存），
        // 绝不让一条慢 rewrite 拖住工具调用。
        const budget = AbortSignal.any([
          exec.signal,
          AbortSignal.timeout(options.rewriteTimeoutMs),
        ]);
        const attempt = await rewriter(command, budget);
        if (attempt.kind === "original") {
          return orig.execute(args, exec);
        }
        // P1~P4：改写结果必须只是「在原命令前面加 rtk」那一种形状，其余一律丢弃、原样执行。
        if (verifyRewrite(command, attempt.command) !== undefined) {
          return orig.execute(args, exec);
        }
        // 记账必须在转调之前：background bash 立即返回，post-execute 可能随后几条语句内就跑；
        // 写在后面就有「B 先压了、C 的账还没记上」的窗口。
        deps.rewrittenCalls.mark(exec.callId);
        // 记账紧跟着 mark：这两个都在「命令真的被改写了」这一支上，而 mark 之后
        // post-execute 可能立刻拿 callId 去查表，所以顺序只能是 mark → count → 转调。
        deps.countRewrite();
        options.log?.(`[rtk] rewrite: ${command} -> ${attempt.command}`);
        // 其余参数原样带回，只替换命令这一位（被遮蔽工具的 schema 里可能还有别的字段）。
        const result = await orig.execute(
          { ...invocation.forwarded, command: attempt.command },
          exec,
        );
        if (options.warnHint() && isCargoTest(command)) {
          return appendWarnHint(result, deps.messages().cargoTestWarnHint);
        }
        return result;
      },
    };
    // 注册进 agent 的作用域：宿主据此遮蔽同名 global 工具，并随 agent 销毁自动退场。
    agent.ctx.tools.register(shadow);
  };

  /**
   * 装过的 agent id。**必须有**：`agent/created` 与「装配时补装」两个入口在时间上可能重叠
   * （监听器挂上之后、`list()` 取快照之前新建的那个 agent 会同时被两条路径看到），而在同一个
   * 作用域里重复注册同名工具是宿主明写的错误（`tools.register` 的 JSDoc：'duplicates within
   * one layer … fail'）。去重按 `Agent.id`——它就是 SessionId，宿主内唯一且稳定。
   */
  const installed = new Set<string>();
  const installOnce = (agent: Agent): void => {
    if (installed.has(agent.id)) {
      return;
    }
    installed.add(agent.id);
    installOn(agent);
  };

  ctx.on("agent/created", ({ agent }) => {
    installOnce(agent);
  });

  // 晚装载：插件在一个已经跑着的宿主里装上时，`agent/created` 对已有的 agent 不会再触发。
  // 宿主的 `agents.list()` 是现成的全集读面，不补这一圈就等于「装了插件、模型照旧走原生 bash」。
  for (const live of readLiveAgents(ctx)) {
    installOnce(live);
  }
}

/**
 * B 形态的装配参数。同样只收已解析的值：volatile 与非 volatile 的读法差别留在 `apply` 一处。
 *
 * `forms` 里没有 `pipe` 时整条链路不装——这是「默认关闭但代码保留」的落点
 * （用户裁定：等官方补上 vitest 5 这类缺口后再打开）。
 */
export interface PipeOptions {
  /**
   * 用户总开关。**每次 `tools/post-execute` 都现读**，与 C 形态的 `options.enabled()` 同一口径。
   *
   * 必须是函数而不是布尔值：设置卡把 `enabled` 标成 volatile，用户在卡片上关掉它之后，
   * 这条监听器已经在栈上了——只有现读才让「关掉总开关」对 B 形态也立刻成立。
   * 曾经这里没有这一位，于是 `enabled:false` + `enabledForms:['prefix','pipe']` 时
   * pipe 照样改写模型读到的输出（真宿主实测 2878B → 1299B），违反 `enabled` = 总开关的语义。
   */
  readonly enabled: () => boolean;
  readonly forms: readonly string[];
  /**
   * 下面四位 volatile 配置项与 `PrefixOptions` 的同名项一样**都是取值函数**：卡片改完、
   * 宿主写进配置之后，下一次 `tools/post-execute` 就该用新值。快照写法会让「卡片上的数字」
   * 与「实际生效的数字」长期分叉，而界面上看不出任何异常。
   */
  readonly enabledFilters: () => readonly string[];
  readonly minBytes: () => number;
  readonly minGainRatio: () => number;
  readonly stdoutCapBytes: () => number;
  readonly pipeTimeoutMs: number;
  readonly vitestMaxMajor: number;
  /**
   * 诊断日志：非 `undefined` 时每次管道决策记一行。由 `logFilterMode`（部署级，重启生效）装配，
   * 默认 `undefined` = 关。热路径上不打印，所以它不是常驻开销。
   */
  readonly log: ((line: string) => void) | undefined;
  /** 探到的 rtk 是否达下限；`false` 时这一层整段不跑（与 C 形态同一口径）。 */
  readonly supported: () => boolean | undefined;
}

/** B 形态的四份依赖，都在 `apply` 顶部造一次（`messages`/`rewrittenCalls` 与 C 形态共用）。 */
export interface PipeDeps {
  readonly messages: () => Messages;
  readonly rewrittenCalls: RewrittenCalls;
  readonly stats: StatsStore;
  /**
   * 文本 → token 的定价函数（`lib/tokens.ts` 造）。
   *
   * 由 `apply` 注入而不是在 `finishCompressed` 里直接摸 `ctx.get("tokenMeter")`：定价口径要能
   * 在单测里换成一张确定的表，否则「记的数是宿主给的还是自己估的」这一格只能靠真宿主才能验。
   */
  readonly tokensOf: TokenPricer;
  /** 读 spill 全文的最小文件面（测试塞桩；生产给 `readFile` 的包装）。 */
  readonly fs: { readonly readFile: (path: string) => Promise<string> };
  /** 具名 logger：原文没落成库时要 warn（那意味着压缩后模型手里没有取回通道）。 */
  readonly log: Log;
}

/** B 形态单条输入上限：超过它说明用户要的不是这段输出，读进内存只会白占。 */
const MAX_PIPE_INPUT = 10 * 1024 * 1024;

/**
 * spill 存储里本插件唯一用到的方法。
 *
 * 返回类型用宿主自己的 `SpillRef`（`locator` 是 Branded 字符串），不在这里重述一份
 * `{locator: string; ...}`：重述的那份与真句柄结构上不兼容，而 `spillOriginal` 收的正是
 * `Promise<SpillRef>`。
 */
interface SpillStoreFace {
  readonly saveText: (input: unknown) => Promise<SpillRef>;
}

/** `hasMethods` 是 shared 的现成件（逐方法名判可调用），这里只补类型谓词。 */
function isSpillStore(value: unknown): value is SpillStoreFace {
  return hasMethods(value, ["saveText"]);
}

/**
 * 从服务面读 spill 存储。
 *
 * `spillStore` 刻意不写进 `inject`：没装 spill 的 profile 该照常压缩，只是不带全文提示。
 */
function readSpillStore(ctx: HostContext): SpillStoreFace | undefined {
  const found = ctx.get?.("spillStore");
  return isSpillStore(found) ? found : undefined;
}

/**
 * `isJsonValue` 的谓词版：官方那个签名是 `(value: unknown) => boolean`，收窄不了类型，
 * 而 `PostToolDecision` 的 value 分支要 `JsonValue`。判据仍由官方实现给出，这里只补类型谓词。
 */
function isJson(value: unknown): value is JsonValue {
  return isJsonValue(value);
}

/**
 * 截断判据取结构化回执的 `stdout.truncated`（`CollectedOutput` 的字段）。
 *
 * 截断意味着回执里只是**尾部**（bash 的截断保留 tail），拿它去算压缩收益会把收益算错，
 * 所以这一条要走 spill 全文，而不是压那段残缺的尾巴。
 *
 * 入参取 `Extracted` 而不是裸 `value`：拆解那一步已经把结构化形状收进 `extracted.value`，
 * 这一层不必再判一次「像不像记录」（再判一次会多出一条从外部取不到的假分支）。
 */
function isTruncated(extracted: Extracted): boolean {
  const stdout = extracted.value?.["stdout"];
  return isRecord(stdout) && stdout["truncated"] === true;
}

/**
 * 全文在哪：**locator 与 retrievalHint 两句都要**。
 *
 * 旧写法只把 `retrievalHint` 当正文，于是模型收到的是「Use read with offset/limit, or grep
 * this path to search within it.」——一句话里没有那个路径（实测 `dsh-spill-local` 的
 * retrievalHint 是固定串，不含 locator）。取回通道看起来在、实际上不存在。
 *
 * 逐字照抄宿主的两句、不自己造措辞：官方的 `dsh-spill-policy` 拼的是
 * `${LOCATION}${ref.locator}. ${ref.retrievalHint}`，我们在同一位置只换成自己的前缀句。
 * `locator` 是 Branded 字符串，这里只做插值，不解析、不裁剪。
 */
function spillNotice(readMessages: () => Messages, spilled: SpilledOriginal): UserMessage {
  const messages = readMessages();
  return createUserMessage({
    content: [
      {
        type: "text",
        // 模板缺席时退到裸 locator：这句是**取回通道**，模板只是包装。拿不到模板就整条
        // notice 抛异常，会把「压缩成功、路径也说得出」的那一次退化成「什么都没压」——
        // 装饰品的失败不该吃掉本体。
        text:
          typeof messages.spillLocation === "string"
            ? messages.spillLocation
                .replace("{path}", spilled.locator)
                .replace("{hint}", spilled.retrievalHint)
            : spilled.locator,
      },
    ],
    source: { kind: "rtk", form: "notice", summary: messages.spillSummary },
  });
}

/** 跑完前置判据之后要压的那一份：filter、工作目录、拆好的回执、真正喂给 pipe 的正文。 */
interface PipePlan {
  readonly filter: string;
  readonly cwd: string;
  readonly extracted: Extracted;
  readonly input: string;
}

/** `planPipe` 一圈判定的共同入参（参数过五个会被 lint 判红，而这几样本就属于同一次判定）。 */
interface PlanContext {
  readonly ctx: HostContext;
  readonly options: PipeOptions;
  readonly deps: PipeDeps;
  readonly exec: ToolExecution;
  readonly result: Readonly<ToolExecutionResult>;
}

/**
 * 宿主给持久 shell 的截断/丢头提示的开头（`tool-bash-persistent` 的 `TRUNCATED_MESSAGE`
 * 与 `LOST_PREFIX_MESSAGE` 都以它起头，见宿主 `packages/shell/tool-bash-persistent/src/index.ts`）。
 *
 * 裸字符串形状（persistent bash）**没有 `spillPath`**，也就是没有取回通道：拿这段残缺尾巴
 * 去压，得到的是一个看起来精确、其实算错的数（§2.9 的谎报）。所以只要见到它就原样放行。
 */
const CLIPPED_MARK = "<response clipped>";

/** 要喂给 pipe 的正文：截断过就走 spill 全文，否则就是拆出来的那一段 stdout。 */
async function pipedInput(
  value: unknown,
  extracted: Extracted,
  files: PipeDeps["fs"],
): Promise<string | undefined> {
  let candidate: string | undefined;
  if (extracted.shape === "structured" && isTruncated(extracted)) {
    // 截断输出走 spill 全文：压半截尾巴既算错收益、又压不出有用信息。
    candidate = await readSpillFullText(value, files);
  } else if (extracted.shape === "string" && extracted.stdout.includes(CLIPPED_MARK)) {
    // 裸字符串形状没有 spillPath：见到宿主的截断/丢头提示就放弃，绝不压这条尾巴。
    candidate = undefined;
  } else {
    candidate = extracted.stdout;
  }
  return candidate;
}

/** 模型可见面 = 正文 + stderr 段 + marker（护栏与收益都按这一面算）。 */
function visibleSurface(extracted: Extracted): string {
  let visible = extracted.stdout;
  if (extracted.stderr !== "") {
    visible = `${visible}\n[stderr]\n${extracted.stderr}`;
  }
  if (extracted.marker !== "") {
    visible = `${visible}\n${extracted.marker}`;
  }
  return visible;
}

/** vitest 的版本门：主版本判不出来也算不通过（宁可这条不压）。 */
function vitestAllowed(cwd: string, command: string, maxMajor: number): boolean {
  const major = detectVitestMajor(cwd, command);
  return major !== undefined && major < maxMajor;
}

/**
 * 「值得压」的两条量：长度落在 `[minBytes, MAX_PIPE_INPUT]`（按 **UTF-8 字节**）、形态预检通过。
 *
 * 字节而不是字符：模型可见面里混着中文测试名与 emoji，`String.length` 会把 300 个汉字
 * 当成 300 字节，让「看着够长」的输出被当成太短而白丢收益。
 */
function worthPiping(candidate: string, filter: string, options: PipeOptions): boolean {
  const bytes = Buffer.byteLength(candidate, "utf8");
  return bytes >= options.minBytes() && bytes <= MAX_PIPE_INPUT && shapeMatches(filter, candidate);
}

/** 回执拆解与输入判据那一段。 */
async function pipedPlan(
  input: PlanContext & { readonly filter: string; readonly cwd: string },
): Promise<PipePlan | undefined> {
  const { options, deps, result, filter, cwd } = input;
  const extracted = extractBody(result.value);
  let plan: PipePlan | undefined;
  if (extracted !== undefined) {
    const candidate = await pipedInput(result.value, extracted, deps.fs);
    if (candidate !== undefined && worthPiping(candidate, filter, options)) {
      plan = { filter, cwd, extracted, input: candidate };
    }
  }
  return plan;
}

/**
 * filter 拿到了之后的判定：工作目录、vitest 版本门、回执形状、输入长度与形态。
 *
 * 全部走单出口（`let plan` + 末尾 `return plan`）：工作区的 `consistent-return` 把
 * `return undefined` 读成「这一支不返回值」，与 `return plan` 混用会判红；而这条链上
 * 「不通过」有七八处，逐处早退写不进这个规则。
 */
async function planForFilter(
  input: PlanContext & { readonly filter: string; readonly command: string },
): Promise<PipePlan | undefined> {
  const { ctx, exec, command, filter } = input;
  // 与 C 形态同一真源：模型按调用传的 `workdir` 优先（宿主 `tool-bash` 也按它跑），
  // 其次是会话 cwd 的两级兜底。vitest 版本门要从这个目录向上找 `node_modules/vitest`，
  // 拿错起点会判错主版本——该压的不压，或把 5.x 上会吞输出的 filter 放过去。
  const cwd = await resolveWorkdir(
    exec,
    async (target) =>
      isAgent(target) ? ctx.workingDirectory.ensure(target, exec.signal) : undefined,
    readInvocation(exec.arguments)?.forwarded["workdir"],
  );
  // vitest 不走版本门就会在 5.x 上把输出压成一句「PASS/FAIL 计数」——实测那条 filter
  // 在 vitest 5 上只剩 57B，会把失败断言原文丢掉。版本判不出来也按不压处理。
  let plan: PipePlan | undefined;
  if (filter !== "vitest" || vitestAllowed(cwd, command, input.options.vitestMaxMajor)) {
    plan = await pipedPlan({ ...input, cwd });
  }
  return plan;
}

/** 命令拿到了之后的判定：共用拒绝层、去重、filter 查表，然后交给 `planForFilter`。 */
async function planForCommand(
  input: PlanContext & { readonly command: string },
): Promise<PipePlan | undefined> {
  const { options, deps, exec, command } = input;
  // spec §4.2 的拒绝层是**两层共用**的，pipe 层只取对它有意义的那两条（见 `pipeStructuralReject`）。
  // `detail-flag` 是**承重**的那一条：`cargo test -- --nocapture` 命中 cargo-test 这一行，
  // 缺了它 stdout 会被压成一句「1 passed」，`--nocapture` 打出来的整段证据消失（实测 189B→37B、
  // 标记出现 0 次）。`already-rtk` 是保险而非主防线——pipe 表每行都锚 `^`，`rtk cargo test`
  // 本来就命中不了；留着它是因为「表将来若加非锚定行」时这条不能跟着失守。
  let plan: PipePlan | undefined;
  if (
    pipeStructuralReject(command) === undefined &&
    !shouldSkipPipe({ callId: exec.callId }, options.forms, deps.rewrittenCalls)
  ) {
    // 白名单**在这里现读**（不是装配期快照一份 Set）：`enabledFilters` 标了 volatile，
    // 用户在卡片上勾掉一个 filter 之后，下一次 post-execute 就该按新集合查表。
    const filter = filterOf(command, new Set(options.enabledFilters()));
    if (filter !== undefined) {
      plan = await planForFilter({ ...input, filter });
    }
  }
  return plan;
}

/** 把一条回执喂给 pipe 之前要过的全部判据。每一条不通过都返回 `undefined`（= 原样放行）。 */
async function planPipe(input: PlanContext): Promise<PipePlan | undefined> {
  const invocation = readInvocation(input.exec.arguments);
  // `readInvocation` 已经保证「拿到了就一定有字符串 command」，所以这里判的是它自己有没有值，
  // 不再对 `invocation.command` 判一次（那一判的另一支从外部永远取不到）。
  let plan: PipePlan | undefined;
  if (invocation !== undefined) {
    plan = await planForCommand({ ...input, command: invocation.command });
  }
  return plan;
}

/** `renderCompressed` 的入参：同一次判定的产物 + 谁在调用。 */
interface RenderInput {
  readonly ctx: HostContext;
  readonly options: PipeOptions;
  readonly deps: PipeDeps;
  readonly exec: ToolExecution;
  readonly plan: PipePlan;
}

/** 压成功之后：落 spill、记账、拼回原形状。 */
async function finishCompressed(
  input: RenderInput & { readonly visible: string; readonly output: string },
): Promise<PostToolDecision | undefined> {
  const { ctx, options, deps, exec, plan, visible, output } = input;
  const capped = capCompressed(output, options.stdoutCapBytes());
  // 原文落 spill 用的 owner 是会话 id：`Agent.id` 就是 `SessionId`，不必绕去 header。
  const sessionId = isAgent(exec.agent) ? exec.agent.id : undefined;
  const spilled =
    sessionId === undefined
      ? undefined
      : await spillOriginal({
          spillStore: readSpillStore(ctx),
          owner: sessionId,
          toolName: exec.name,
          callId: exec.callId,
          text: plan.input,
        });
  // 取回通道成不成，四个后果里只有「模型看不到原文」是不可见的：
  // - 落了库：诊断日志留一行 locator（默认关时这行不花一次字符串拼接）；
  // - 没落成：warn 一次。压缩照常生效，但模型手里没有取回通道 —— 那是配置或后端的问题，
  //   不该在静默里过去（真宿主上第一次实测就是这么发现的）。
  if (spilled === undefined) {
    deps.log.warn(
      "[rtk] spill: no backend or saveText failed; compressed output has no retrieval path",
    );
  } else if (options.log !== undefined) {
    options.log(`[rtk] spill: saved ${spilled.locator}`);
  }
  deps.stats.accumulate({
    form: "pipe",
    filter: plan.filter,
    originalBytes: Buffer.byteLength(visible, "utf8"),
    compressedBytes: Buffer.byteLength(capped, "utf8"),
    // token 与字节各算一次：宿主扣钱按前者、可复算的物理量是后者。两侧都用同一个定价函数，
    // 「省下多少」才是同一把尺子量出来的（`savedTokens` 与 `savedBytes` 因此不会互相矛盾）。
    originalTokens: deps.tokensOf(visible),
    compressedTokens: deps.tokensOf(capped),
  });
  const rebuilt = reassemble(plan.extracted, capped);
  let accepted: PostToolDecision | undefined;
  /* v8 ignore next —— `reassemble` 只会把 JSON 值原样传回或包一层 `{...value, stdout}`，
     而 `value` 来自一次成功的工具执行（`ToolExecutionSuccess.value` 的类型就是 `JsonValue`），
     所以失败分支不可达；留着它是为了让「拼回来不是 JSON」这件事有个明确的退路而不是硬转。 */
  if (isJson(rebuilt)) {
    accepted =
      spilled === undefined
        ? { kind: "accept", value: rebuilt }
        : {
            kind: "accept",
            value: rebuilt,
            additionalContexts: [spillNotice(deps.messages, spilled)],
          };
  }
  return accepted;
}

/** pipe 成功了：过护栏，然后交给 `finishCompressed`。 */
async function acceptCompressed(
  input: RenderInput & { readonly piped: string },
): Promise<PostToolDecision | undefined> {
  const visible = visibleSurface(input.plan.extracted);
  const guarded = guardCompressed({
    filter: input.plan.filter,
    input: visible,
    output: input.piped,
    minGainRatio: input.options.minGainRatio(),
  });
  let accepted: PostToolDecision | undefined;
  if (guarded.ok) {
    input.options.log?.(
      `[rtk] pipe ${input.plan.filter}: ${String(Buffer.byteLength(visible, "utf8"))}B -> ${String(Buffer.byteLength(guarded.output, "utf8"))}B`,
    );
    accepted = await finishCompressed({ ...input, visible, output: guarded.output });
  } else {
    // 护栏拒是最值得记的一格：用户开诊断日志通常就是为了问「为什么这次没压」。
    input.options.log?.(`[rtk] pipe ${input.plan.filter}: skipped (${guarded.reason})`);
  }
  return accepted;
}

/**
 * 真正压一次：spawn `rtk pipe`、过护栏、落 spill、记账、把压缩体拼回原形状。
 *
 * 返回 `undefined` 表示这一条不该换值（pipe 失败 / 护栏拒 / 拼回来不是 JSON 值）。
 */
async function renderCompressed(input: RenderInput): Promise<PostToolDecision | undefined> {
  const { ctx, options, plan } = input;
  const piped = await runRtkPipe({
    subprocess: ctx.subprocess,
    filter: plan.filter,
    stdin: plan.input,
    cwd: plan.cwd,
    timeoutMs: options.pipeTimeoutMs,
  });
  let accepted: PostToolDecision | undefined;
  if (piped.ok) {
    accepted = await acceptCompressed({ ...input, piped: piped.stdout });
  }
  return accepted;
}

/**
 * 一次 `tools/post-execute` 的完整判定。
 *
 * 合约约束：先 `await next()` 把决定权交给下游，再决定要不要换；给**失败**结果换 value 会抛
 * `TypeError`，`accept` 同时带 value 与 content 也会抛——所以前置条件全挤进一个 `if`，
 * 而「换不换」只体现在 `output` 的赋值上（单出口，任何意外都让它保持下游的决定）。
 */
async function decide(
  input: PlanContext,
  next: () => Promise<PostToolDecision>,
): Promise<PostToolDecision> {
  // 改名绕开 `node(callback-return`：那条规则把形参名 `next` 认成 node 风格回调，
  // 只要调用后还继续执行就要求「立刻 return」，与这里的 try/catch 单出口写法直接冲突。
  const upstream: () => Promise<PostToolDecision> = next;
  const decision = await upstream();
  let output: PostToolDecision = decision;
  try {
    // 下游已经换过值：那是它算好的结果，二次改写只会把两边口径搅在一起。
    //
    // `options.enabled()` 必须在**每次**判定时现读，不能在装配期判一次：`enabled` 是 volatile
    // 字段，用户可以在卡片上随时关掉它，而这条监听器那时已经在栈上了。装配期只判 `forms`
    // （形态是启动期决定），运行期判 `enabled`（总开关）——C 形态在 `installPrefixShadow`
    // 的 execute 里也是这么分工的。
    if (
      input.options.enabled() &&
      input.options.supported() !== false &&
      decision.kind === "accept" &&
      !Object.hasOwn(decision, "value") &&
      !input.result.isError &&
      (input.exec.name === "bash" || input.exec.name === "pwsh")
    ) {
      const plan = await planPipe(input);
      const compressed =
        plan === undefined ? undefined : await renderCompressed({ ...input, plan });
      if (compressed !== undefined) {
        output = compressed;
      }
    }
  } catch (error) {
    // 诊断开关打开时把成因写出来：默认吃掉异常是对的（帮忙不该毁掉这次调用），
    // 但**完全无声**会让「为什么这次没压」变成只能靠猜。
    input.options.log?.(`[rtk] pipe: internal error (${String(error)})`);
    // 监听器抛异常会被 pipeline 收成 isError 结果——那等于「插件想帮忙」反而毁掉这次调用，
    // 所以任何意外都退回下游已经给出的决定。
  }
  return output;
}

/**
 * B 形态装配：挂 `tools/post-execute`，按命令命中的 filter 把**输出**压小。
 *
 * 定位要读准：B **不是** C 失败时的兜底，而是「C 够不着的那一格」——C 只改命令串
 * （`rtk rewrite` 决定范围），B 在结果侧按 filter 压输出。两者默认不同开：`enabledForms`
 * 默认只有 `prefix`，而这条链路在打开 `pipe` 之前不装。
 */
export function installPostExecuteListener(
  ctx: HostContext,
  options: PipeOptions,
  deps: PipeDeps,
): void {
  if (!options.forms.includes("pipe")) {
    return;
  }
  const base = { ctx, options, deps };
  ctx.on("tools/post-execute", (exec, result, next) => decide({ ...base, exec, result }, next));
}

/**
 * 插件配置面。
 *
 * 值名退避为 `configSchema`：与下面同名 `interface Config` 在类型/值两个命名空间里各占一位，
 * 直接 `const Config = …` 会触发 `no-redeclare`（兄弟仓 dsh-zvec-grep 同款写法）。
 *
 * `.volatile()` 的语义（宿主 0.2.x）：标了它的字段进设置表单（卡片能改），没标的只能改
 * `cordis.yml` 的 `config:` 并重启。所以**运行期调参项**标 volatile，**部署级预算项**不标。
 */
const configSchema = Schema.object({
  /** 用户开关。默认关闭：宿主不该在用户知情前改写命令。 */
  enabled: Schema.boolean().default(false).volatile(),
  /**
   * 启用的形态。默认只开 C（prefix）：B 的 vitest filter 在 5.x 上只剩一行 passthrough，
   * 且会在用户仓库里落 `.vitest/json/output.json`，等官方修好再默认打开。
   *
   * **volatile 但只在装配期消费**：卡片要能写它（非 volatile 的字段宿主根本不投影进
   * `describe()`，卡上就不会出现这一格），而两层——C 形态在 `agent/created` 里读、B 形态
   * 按它决定挂不挂 post-execute——都是装配期读一次。所以它的效果与其他 volatile 不同：
   * **改完要重启**，不是「下一次工具调用即生效」。这一位必须在文档里写明，否则卡片是在
   * 承诺一件它做不到的事。
   */
  enabledForms: Schema.array(Schema.union(["prefix", "pipe"]))
    .default(["prefix"])
    .volatile(),
  /** 用户追加的拒绝前缀（首词字面量）。内置的信息损失拒绝表不受它影响，只增不减。 */
  denyCommands: Schema.array(Schema.string()).default([]).volatile(),
  /** B 形态的 filter 白名单。vitest 刻意不在默认里（见 enabledForms 的理由）。 */
  enabledFilters: Schema.array(Schema.string())
    .default([...DEFAULT_ENABLED_FILTERS])
    .volatile(),
  /** 小于这个字节数不压：压了反而多出说明行。 */
  minBytes: Schema.natural().min(0).default(256).volatile(),
  /** 压缩后必须小于输入的这一比例才采用。 */
  minGainRatio: Schema.number().min(0).max(1).default(0.95).volatile(),
  /** 压缩结果的硬上限（字节）。 */
  stdoutCapBytes: Schema.natural().min(1).default(64_000).volatile(),
  /** cargo test 丢编译警告时追加一行常量提示。 */
  warnHint: Schema.boolean().default(true).volatile(),
  /**
   * `RTK_REWRITE_HOST` 的取值；空串 = **不设这个环境变量**（默认，推荐）。
   * 填 `openclaw` 可让 rtk 不再读 `~/.claude/settings*.json` 的权限规则（实测只有 openclaw
   * 会把审批权交给 delegate）。不填它也能用——rc=2 一律按原样执行，插件不会因此拦命令。
   */
  rewriteHostEnv: Schema.string().default("").volatile(),
  /** B 形态 rtk pipe 的超时。部署级预算项：跟着仓库规模调，不是用户日常旋钮。 */
  pipeTimeoutMs: Schema.natural().min(1).default(3000),
  /** `rtk rewrite` 的超时。实测单次 spawn 20~50ms，2000ms 是给冷启动留的余量。 */
  rewriteTimeoutMs: Schema.natural().min(1).default(2000),
  /** 改写结论缓存条数（key 含 cwd）。 */
  rewriteCacheSize: Schema.natural().min(1).default(256),
  /** vitest 主版本上界：主版本 < 它才允许改写（5.x 上 rtk 的解析器已失效）。 */
  vitestMaxMajor: Schema.natural().min(1).default(5),
  /** 诊断日志。默认 off：热路径上不打印。 */
  logFilterMode: Schema.union(["off", "on"]).default("off"),
});

export { configSchema as Config };

/**
 * `apply` 收到的配置面。**九项 volatile 是引用（要 `.get()`），五项非 volatile 是普通值**——
 * 这个差别是官方 `.volatile()` 的语义（`SchemaOutput<T, 'volatile'> = Volatile<T | undefined>`），
 * 不是本包自选。声明里把 volatile 的值写成 `| undefined`：官方 `Volatile.get()` 的 d.ts 原文是
 * 「including undefined for an absent value」，条目没被 volatile 投影 / 宿主退化时交回来的就是空引用，
 * schema 的 `.default()` 只保证正常装载下不空。所以下面每个读取点的 `?? default` 是**必要分支**。
 */
export interface Config {
  enabled: Volatile<boolean | undefined>;
  enabledForms: Volatile<readonly string[] | undefined>;
  denyCommands: Volatile<readonly string[] | undefined>;
  enabledFilters: Volatile<readonly string[] | undefined>;
  minBytes: Volatile<number | undefined>;
  minGainRatio: Volatile<number | undefined>;
  stdoutCapBytes: Volatile<number | undefined>;
  warnHint: Volatile<boolean | undefined>;
  rewriteHostEnv: Volatile<string | undefined>;
  /** 以下五项是部署级预算项：普通值，改 cordis.yml 的 `config:` 后重启生效。 */
  pipeTimeoutMs: number;
  rewriteTimeoutMs: number;
  rewriteCacheSize: number;
  vitestMaxMajor: number;
  logFilterMode: "off" | "on";
}

/**
 * 设置服务里本插件用到的两枚方法（读 locale 偏好 + 声明本插件的设置页）。
 *
 * `configure` 的返回类型是**disposer**（官方 `SettingsForms.configure(presentation, owner?)`
 * 原文 `@returns Disposer`），它正好也是 cordis `SyncEffect` 的形状——所以
 * `child.effect(() => child.settings.configure(...))` 这句话在类型上成立，不需要一个包一层的包装。
 * 声明成 `unknown` 会让 `effect` 的重载全部落空（`Type 'unknown' is not assignable to Effect`）。
 */
export interface SettingsFace {
  readonly describe: () => readonly { readonly ns: string; readonly value: unknown }[];
  readonly configure: (presentation: { readonly auto?: boolean }, owner?: unknown) => () => void;
}

/** 注入子上下文的形状：只经它挂 `settings.configure`（兄弟仓 dsh-zvec-grep 同款）。 */
interface InjectedContext {
  readonly settings: SettingsFace;
  readonly effect: Context["effect"];
}

/**
 * `apply` 用的宿主面：在本文件既有的 `HostContext`（四个服务面 + `get`/`on`）之上补装配点要的那几位。
 *
 * 独立成一层而不是往 `HostContext` 里加字段：`installPrefixShadow` /
 * `installPostExecuteListener` 的半栈测试只造四个服务就能跑，加进去会让那些桩全部失配。
 */
export interface HostServices extends HostContext {
  readonly settings: SettingsFace;
  /** 存储设施本身（不是句柄）：`openStatsTable` 的入参形状就是它的下限。 */
  readonly storageDomain: StatsDomainFacility;
  readonly get: NonNullable<HostContext["get"]>;
  /**
   * 注入口。回调收到的子上下文**只声明本插件真正用到的那两位**（`settings` 与 `effect`）：
   * 取官方 `Context["inject"]` 的话回调参数是完整 `Context`，而 `settings` 是它上面的服务成员，
   * 在本包「类型面按成员投影、不重述官方签名」的纪律下反而不该凭空引用。
   */
  readonly inject: (deps: readonly string[], callback: (child: InjectedContext) => void) => unknown;
  readonly effect: Context["effect"];
  readonly fiber: unknown;
}

/**
 * 具名方法在不在位。
 *
 * 只看 `typeof x === "object"` 会放过「有对象、没方法」的错注入，运行到第一次调用才炸；
 * 逐个数方法名，检查才名副其实（与 shared `hasMethods` 同一判据，这里多一层嵌套成员）。
 */
function hasMethod(
  container: Record<string, unknown>,
  name: string,
  methods: readonly string[],
): boolean {
  return hasMethods(container[name], methods);
}

/**
 * 六个注入都必须是带相应方法的对象。失败即 `apply` 抛错（fail-fast）：
 * 比「装配成功、某次调用才 undefined」可诊断得多。
 */
function isRtkHost(value: unknown): value is HostServices {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasMethod(value, "settings", ["describe", "configure"]) &&
    hasMethod(value, "tools", ["get"]) &&
    hasMethod(value, "subprocess", ["spawn"]) &&
    hasMethod(value, "workingDirectory", ["ensure"]) &&
    hasMethod(value, "storageDomain", ["open"]) &&
    typeof value["get"] === "function" &&
    typeof value["on"] === "function" &&
    typeof value["inject"] === "function" &&
    typeof value["effect"] === "function"
  );
}

/**
 * `enabledForms` 的兜底：volatile 读到空引用时按 v3.5 的默认跑（只有 prefix）。
 *
 * 三处装配（status、C 形态、B 形态）都读它，而且必须是**同一份**兜底：三处各写一份字面量时，
 * 改了形态默认值就只改到一处，剩下两处照旧——这种偏差只在退化态出现，装出来看不出来。
 */
export function formsOr(forms: readonly string[] | undefined): readonly string[] {
  return forms ?? ["prefix"];
}

/**
 * volatile 字段的兜底口径（`get()` 交回 `undefined` 时用哪个值）。
 *
 * 九处读面都过它，而不是各自写 `?? 字面量`：那些字面量里每一个都必须与 schema 的 `.default()`
 * 同值，散在九处就会「改了一处、八处照旧」——而这条偏差只在退化态（volatile 拿到空引用）
 * 出现，装出来永远看不见。集中成一处之后，两边的同源由测试直接钉。
 */
export function withDefault<TValue>(value: TValue | undefined, fallbackValue: TValue): TValue {
  return value ?? fallbackValue;
}

/**
 * C 形态那几位 volatile 的取值函数（装配时原样交给 `installPrefixShadow`）。
 *
 * 单独成件而不是就地写成 `apply` 里面的箭头，有两个理由：
 *   · **可测**。`apply` 只跑一次，那些闭包体在整条装配栈里几乎走不到（要一个真 agent、
 *     一个真 bash 工具体、一次真 execute），于是「闭包到底是不是现读」这件事没有直接判据，
 *     只剩覆盖率裂隙。提到这一层之后，用例拿一个假的 `Config` 就能钉住。
 *   · **一处口径**。`enabled` 在 C/B 两层都要读，而两层各自的兜底必须同值；写成两个内联
 *     箭头时它们是两份独立的字面量，改一处不算改了另一处。
 *
 * 交回来的每一个都是**取值函数**：`apply` 只跑一次，快照下来的值此后永不更新，而标了
 * volatile 的字段名义上是「下一次工具调用即生效」。
 */
export function prefixReadersOf(config: Config): {
  readonly enabled: () => boolean;
  readonly denyCommands: () => readonly string[];
  readonly warnHint: () => boolean;
  readonly rewriteHostEnv: () => string;
} {
  return {
    enabled: () => withDefault(config.enabled.get(), false),
    denyCommands: () => withDefault(config.denyCommands.get(), []),
    warnHint: () => withDefault(config.warnHint.get(), true),
    rewriteHostEnv: () => withDefault(config.rewriteHostEnv.get(), ""),
  };
}

/** B 形态那几位 volatile 的取值函数；理由同 `prefixReadersOf`。 */
export function pipeReadersOf(config: Config): {
  readonly enabled: () => boolean;
  readonly enabledFilters: () => readonly string[];
  readonly minBytes: () => number;
  readonly minGainRatio: () => number;
  readonly stdoutCapBytes: () => number;
} {
  return {
    enabled: () => withDefault(config.enabled.get(), false),
    // 兜底与 schema 的 `.default()` 读同一个常量：两处各写一份字面量时，改一处另一处不变，
    // 而只有退化态（volatile 读到空引用）才会走兜底，正常装出来的行为看不出来。
    enabledFilters: () => withDefault(config.enabledFilters.get(), DEFAULT_ENABLED_FILTERS),
    minBytes: () => withDefault(config.minBytes.get(), 256),
    minGainRatio: () => withDefault(config.minGainRatio.get(), 0.95),
    stdoutCapBytes: () => withDefault(config.stdoutCapBytes.get(), 64_000),
  };
}

/**
 * `logFilterMode` → 诊断日志函数（`'off'` 时是 `undefined`，热路径连字符串都不拼）。
 *
 * 单独成函数是为了让它可测：直接写在 `apply` 里的话，唯一能证明「开关真的接通了」的地方
 * 就只剩「真跑一次改写」——那要真 rtk 二进制，而这一位的判据其实是「模式串认不认」。
 */
export function diagOf(mode: string, log: Log): ((line: string) => void) | undefined {
  return mode === "on"
    ? (line: string): void => {
        log.info(line);
      }
    : undefined;
}

/**
 * spec §6 的 prefix 分账：只知道「改写了一次」，字节记不到（原始输出从未流经本插件）。
 * 同样是可测的独立件——把它内联进 `apply` 的 deps 里，就只有真跑改写才走得到。
 */
export function makeCountRewrite(stats: StatsStore): () => void {
  return (): void => {
    stats.accumulate({ form: "prefix" });
  };
}

/**
 * 取具名 logger；没有 logger 服务时回退 console。
 *
 * 回退是**兼容路径**而非正常路径：cordis 的 `ctx.logger` 是核心服务，正常装配一定在。
 * 留着它是因为「探测失败要留一条痕迹」这件事不该因为 ctx 异常就整条消失——
 * 那种环境下 console 是唯一还写得到的地方。
 */
export function loggerOf(ctx: HostContext): Log {
  const facade = typeof ctx.logger === "function" ? ctx.logger("rtk") : undefined;
  const log: Log = facade ?? {
    info: (...args) => {
      console.info(...args);
    },
    warn: (...args) => {
      console.warn(...args);
    },
  };
  return log;
}

/**
 * 装配期探版本，并把结果记进 `assign`。
 *
 * 探不到就**记一条 warn**（spec §7.1）：用户开了开关却没有任何效果时，日志里必须有一句话
 * 说明为什么，否则「装了插件、什么都没发生」是零线索的。不阻断装载——rtk 缺失时插件仍然
 * 装得上，只是两层都 fail-open 成原样放行。
 */
async function probeVersion(
  ctx: HostContext,
  assign: (probing: { readonly raw: string; readonly supported: boolean } | undefined) => void,
): Promise<void> {
  const log = loggerOf(ctx);
  const probed = await probeRtkVersion(() => readRtkVersion(ctx));
  if (probed === undefined) {
    log.warn(
      `[rtk] rtk not found on PATH (or \`rtk --version\` gave no version): compression stays inert until it is installed`,
    );
  } else if (!probed.supported) {
    log.warn(
      `[rtk] found ${probed.raw} but the minimum supported version is ${MIN_RTK_VERSION}: compression stays inert until rtk is upgraded`,
    );
  }
  assign(probed === undefined ? undefined : { raw: probed.raw, supported: probed.supported });
}

/** 文案 thunk：每次现读 locale 偏好，用户切语言后无需重载插件。 */
export function createLocaleMessages(ctx: HostServices): () => Messages {
  return () => {
    const row = ctx.settings.describe().find((entry) => entry.ns === LOCALE_SETTINGS_NAMESPACE);
    // 归一与按语言取表都由 shared 的 `messagesFor` 负责（`en-US` → `en`、非法值回退默认语言）。
    // 这里**不做**自己的 `=== "en" ? "en" : "zh"` 收窄：那是抄一份归一逻辑，宿主加第三门
    // 语言时还会静默取不到文案而编译通过。
    return messagesFor(MESSAGES, resolveLocalePreference(row?.value));
  };
}

/**
 * 插件总装。
 *
 * 装配顺序有依赖，不能随意调换：设置页（卡片要读 config）→ 文案 thunk → 缓存与账本
 * （两个 installer 共享）→ 存储 → C 遮蔽 → B 监听 → 读面（读面要前两者的 stats/status）。
 */
function apply(ctx: unknown, config: Config): void {
  if (!isRtkHost(ctx)) {
    throw new Error(
      "[rtk] required services (settings/tools/subprocess/workingDirectory/storageDomain) missing",
    );
  }
  const host = ctx;

  // 1. 设置页注册。owner 必须是本插件 fiber：缺省是 settings 服务自己的 fiber，插件卸载时清不掉。
  //    经注入子上下文挂，随注入子上下文回收（兄弟仓 dsh-zvec-grep 的 configureSettingsPage 同款）。
  host.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, host.fiber), "rtk: settings page");
  });

  // 2. 文案 thunk（每次现读 locale 偏好）。
  const messages = createLocaleMessages(host);

  // 3. 结论缓存与去重账本：跨调用共享，所以必须建在 apply 层而不是 execute 里。
  //    `rewriteCacheSize` 是普通值（部署级）；`rewrittenCalls` 的 512 只是防泄漏兜底，
  //    正确性靠「读后即删」而不是容量。
  const rewriteCache = createRewriteCache(config.rewriteCacheSize);
  const rewrittenCalls = createRewrittenCalls(512);

  // 4. 自记账存储：先落内存，`load()` 后台换到持久化账本。
  const stats = createDeferredStatsStore(host);
  void stats.load();

  // 5. 运行时状态（卡片顶部那行）。`probed` 是探测回来的整份结果（原始串 + 是否达下限），
  //    探测是异步且可失败的，所以它是 apply 闭包里的可变位、status 每次现读——卡片轮询到的
  //    那次自然就是最新的。存整份而不是只存串：`supported` 是「版本过低」那句话的唯一依据，
  //    只留串会让卡片分不出「没装」与「装了但太旧」（前者 rtkVersion 也是 null）。
  let probed: { readonly raw: string; readonly supported: boolean } | undefined;
  const status = (): StatsStatus => ({
    rtkPath: findOnPath("rtk") ?? null,
    rtkVersion: probed?.raw ?? null,
    supported: probed?.supported ?? null,
    enabled: withDefault(config.enabled.get(), false),
    // 复制一份：`StatsStatus` 的 `forms` 是可变数组（zod 的 `z.array` 交出来的是 `string[]`），
    // 而 `config.enabledForms` 是只读的 —— 直接把那个引用塞进投影，会让读面拿到一个能反改
    // 配置的对象。
    forms: [...formsOr(config.enabledForms.get())],
  });
  void probeVersion(host, (result) => {
    probed = result;
  });

  /**
   * 版本门：探到「低于下限」时两层都退回原样执行。
   *
   * `probed === undefined`（还在探 / 探不到）时**放行**——放行才是保守的一侧吗？这里刻意
   * 与前缀层的装配期门禁分开：rtk 装得到、pipe 跑得动，就让它工作；只有明确读到「低于 1.0.0」
   * 才停手。README 承诺的正是这一条（「below that it reports the version it found and does
   * nothing」），而卡片上那句「请升级 rtk 后再打开压缩」也只有这一条能让它成真。
   */
  const supported = (): boolean | undefined => probed?.supported;

  // 诊断日志：`logFilterMode` 是部署级开关（重启生效），开则两层各自在决策点记一行。
  // 热路径不打印，所以默认 'off' 时不产生任何字符串拼接。
  const diag = diagOf(config.logFilterMode, loggerOf(host));

  // 6. C 形态。**每一位 volatile 都传取值函数、不传 `.get()` 的结果**：`apply` 只跑一次，
  //    在这里快照下来的值此后永不更新，而标了 volatile 的字段名义上是「下一次工具调用即生效」。
  //    `?? 默认值` 的必要性见 `Config` 的注释（退化态下 `.get()` 交回空引用）。
  installPrefixShadow(
    host,
    {
      ...prefixReadersOf(config),
      forms: formsOr(config.enabledForms.get()),
      vitestMaxMajor: config.vitestMaxMajor,
      rewriteTimeoutMs: config.rewriteTimeoutMs,
      log: diag,
      supported,
    },
    {
      messages,
      rewriteCache,
      rewrittenCalls,
      // spec §6 按形态分账：prefix 只知道「改写了一次」，字节记不到（原始输出没过本插件）。
      countRewrite: makeCountRewrite(stats),
    },
  );

  // 7. B 形态。取值面与 C 形态同一口径：volatile 全部传闭包，运行期现读。
  installPostExecuteListener(
    host,
    {
      ...pipeReadersOf(config),
      forms: formsOr(config.enabledForms.get()),
      pipeTimeoutMs: config.pipeTimeoutMs,
      vitestMaxMajor: config.vitestMaxMajor,
      log: diag,
      supported,
    },
    {
      messages,
      rewrittenCalls,
      stats,
      // 定价口径的唯一入口：服务在就用宿主的 tokenMeter，不在就按同密度字节估算。
      tokensOf: tokenPricerOf(host),
      fs: { readFile: (target) => readFile(target, "utf8") },
      log: loggerOf(host),
    },
  );

  // 8. 统计读面。可选：注册失败只让卡片少一栏统计。
  //    不传断言：`installStatsRemote` 收 `unknown`，凭 `reflect.provide` 可调用自己收窄。
  installStatsRemote(host, { store: stats, status });
}

export default {
  inject: ["settings", "storageDomain", "subprocess", "tools", "workingDirectory"],
  Config: configSchema,
  apply,
};
