// dsh-rtk 宿主侧入口。
//
// 三块装配都在本文件：C 形态（per-agent 遮蔽 bash，`installPrefixShadow`）、
// B 形态（post-execute 按 filter 压输出，`installPostExecuteListener`）、以及把它们
// 串起来的 Config 与 `apply`。两个 installer 收**取值函数**（`prefixReadersOf` / `pipeReadersOf`
// 造出来的那一份），不接收已经读好的值——volatile 字段必须在消费点现读，见那两个工厂的注释。
import { readFile } from "node:fs/promises";
import path from "node:path";
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
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { hasMethods, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
// 双路径装载的自保：dshmarket 运行期热装时会在 `<profile>/.dsh-market/` 下造一棵它自己的
// Include 子树（条目 id 形如 `mkt-<包>`），把同一份 host.js 再挂一次；而 profile 的
// `dsh.profile.bundles` 那条 bundle 行仍会被宿主按 patch 重新组装。于是同一个进程里
// `apply` 跑两遍，第二遍的注册面（工具 / 设置页策略 / Typert Remote 服务）撞「同名已注册」
// 而抛，那条 fiber 落 failed —— 用户在插件页看到「启动失败」。抢这把锁把第二遍挡在注册面
// 之外；锁随在册那一份的 fiber 卸载自动释放，所以后续装配仍能抢到。
import { claimInstance } from "@jayyuen66/dsh-plugin-shared/lib/instance-lock";

import { RTK_REWRITE_ENV, runRtkHook, runRtkPipe, runRtkRewrite } from "./lib/cli.ts";
import { commandFamilyOf, rewrittenFamilies } from "./lib/command-family.ts";
import {
  ALL_FILTERS,
  DEFAULT_ENABLED_FILTERS,
  filterOf,
  HOOK_FILTER,
  WINDOW_FILTER,
} from "./lib/command-filter.ts";
import type { RewrittenCalls } from "./lib/dedup.ts";
import { createRewrittenCalls, shouldSkipPipe } from "./lib/dedup.ts";
import { guardCompressed, keptOutputOf } from "./lib/guard.ts";
import type { PipeRecord, PipeSkipReason, PrefixRecord } from "./lib/insights-shape.ts";
import { createInsightsService } from "./lib/insights-service.ts";
import { createDeferredInsights } from "./lib/insights-sink.ts";
import { MESSAGES } from "./lib/messages.ts";
import type { Messages } from "./lib/messages.ts";
import { findOnPath, pipeStructuralReject } from "./lib/prefix-safety.ts";
import { registerUsageSkill, USAGE_ORDER, USAGE_SECTION } from "./lib/skill.ts";
import { createRewriter } from "./lib/rewrite.ts";
import type { RewriteCache } from "./lib/rewrite-cache.ts";
import { createRewriteCache } from "./lib/rewrite-cache.ts";
import { resolveWorkdir, restoreGatedSegments, shouldSkipRewrite } from "./lib/rewrite-gate.ts";
import type { RewriteGateOptions } from "./lib/rewrite-gate.ts";
import { verifyRewrite } from "./lib/rewrite-verify.ts";
import { createRtkLedger, ensureRtkDir, registerRtkWritableRoot } from "./lib/rtk-ledger.ts";
import {
  prepareHookConfig,
  resolveHookPaths,
  resolveLedgerPaths,
  withRtkLedgerEnv,
  withoutRtkDbEnv,
} from "./lib/rtk-paths.ts";
import type { RtkPaths } from "./lib/rtk-paths.ts";
import { buildHookPayload, hookEnvOf, parseHookOutput, pipelineToml } from "./lib/rtk-hook.ts";
import {
  DEFAULT_WINDOW_HEAD_LINES,
  DEFAULT_WINDOW_TAIL_LINES,
  isLogTarget,
  isReadingTarget,
  windowOf,
} from "./lib/output-window.ts";
import { shapeMatches } from "./lib/shape-precheck.ts";
import type { StatsStatus } from "./lib/stats-remote.ts";
import { installStatsRemote } from "./lib/stats-remote.ts";
import { loadLegacyAccumulator } from "./lib/stats-store.ts";
import { capCompressed, spillOriginal } from "./lib/spill.ts";
import type { CappedText, SpilledOriginal } from "./lib/spill.ts";
import { readSpillFullText } from "./lib/spill-read.ts";
import type { Extracted } from "./lib/stdout-extract.ts";
import { extractBody, reassemble } from "./lib/stdout-extract.ts";
import { tokenPricerOf } from "./lib/tokens.ts";
import type { TokenPricer } from "./lib/tokens.ts";
import { MIN_RTK_VERSION, probeRtkVersion } from "./lib/rtk-version.ts";
import { localDayKey } from "./lib/time-buckets.ts";
import { stripPassingTests } from "./lib/vitest-strip.ts";
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
 * 官方 SystemPrompt（`@deepseek-ai/dsh-system-prompt` 的 cordis Service，带 private 字段 →
 * 名义比较）的方法子集投影：本包只 `section()` 注册常驻摘要段。
 *
 * 与兄弟仓 dsh-zvec-grep 同一条纪律：**只 Pick 本包调的那一位**，签名一个字都不重述——
 * 入参即官方 `PromptSection`（name/order/text，text 允许 `string | (ctx) => string`），
 * 返回值是官方承诺的 Cordis effect disposer。注册在 `apply` 里、随插件 fiber 回收，
 * 故不接这个 disposer（`section()` 内部的 `layers.effect` 已经把它挂在调用方 ctx 上）。
 */
type SystemPromptFace = Pick<SystemPrompt, "section">;

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
 * C 形态在 `HostContext` 之上多要的那一位：把 disposer 挂到**本插件 fiber** 的口。
 *
 * 为什么非它不可：`agent.ctx.tools.register()` 交回的 disposer 归**调用方 ctx** 所有，而这里的
 * 调用方是 `agent.ctx`（agent 的作用域 fiber），不是插件 fiber。裸调用的后果是遮蔽体在插件卸载后
 * 仍留在 agent 作用域里，下一次装配再注册就撞 `tool "bash" is already registered in this scope`
 * （真机现场，`probe-scope5` 的 A 行复现）。经 `ctx.effect` 转手之后，回收权才落在插件手里。
 *
 * 独立成一层而不是往 `HostContext` 里加：`HostContext` 是「四个服务面 + `get`/`on`」，
 * 其余几个 installer 与半栈夹具都只造那几样，加进去会让它们全部失配。
 */
export interface PrefixContext extends HostContext {
  readonly effect: Context["effect"];
}

/**
 * C 形态的装配参数。收已解析的值而不是整个 `Config`：volatile 与非 volatile 字段的读法不同
 * （前者要 `.get()`），把那个差别收在 `apply` 一处，本函数就能脱离 cordis 的配置投影单独测。
 */
export interface PrefixOptions {
  readonly enabled: () => boolean;
  /**
   * 启用的形态，运行期现读。装配期不再按它决定装不装：层常驻，execute 每次判
   * `forms().includes("prefix")`；卡片改完形态后下一次工具调用就生效，不需要重启宿主。
   */
  readonly forms: () => readonly string[];
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
   * 故障播报口：**与 `log` 分开**，因为它不该跟着 `logFilterMode` 关掉。
   *
   * `log` 是「想不想看每一步决策」的诊断开关（默认关）；这里说的是「这次装配的记账已经
   * 不可能成功」——目录建不出来、沙箱不给写权限。两者混用一个口时，默认配置下这类故障
   * 一个字都不留，而它们的症状是「Insights 页永远空白」，从页面侧看不出是没采到还是没数据。
   * 宿主 logger 在 web 与 headless 下都可读，走它。
   */
  readonly warn?: ((line: string) => void) | undefined;
  /**
   * 探到的 rtk 是否达下限（`undefined` = 还没探完 / 探不到）。
   *
   * **每次调用现读**，不在装配期判一次：探测是异步的，装配那一刻它通常还没回来——按那一刻
   * 的快照判，会把「rtk 好好的」判成「没装」。`false` 时这一层退回原样执行（见
   * `probeVersion` 注释：版本过低 = 压缩不启用，与 spec §7.1、README 的承诺一致）。
   */
  readonly supported: () => boolean | undefined;
  /**
   * 本插件的两个库路径（`$DSH_HOME/rtk/`，默认 `~/.dsh/rtk/`）：
   * `history.db`（记账 + 本插件的 `dsh_*` 表）与 `recall.db`（rtk 折叠中段的取回通道）。
   *
   * 三处用它：① 改写出来的每段 `rtk …` 前面注入 `RTK_DB_PATH` 与 `RTK_RECALL_DB` 指到它们
   * （rtk 因此只往这里写）；② 自己那几张 `dsh_*` 表写进 `history.db`；③ 清零时把两侧一起清。
   *
   * **为什么不指向 rtk 的全局库**：那张 `commands` 表里是用户自己终端跑的全部命令，混进本页
   * 就会与「只统计 dsh 会话」的计数自相矛盾（用户裁决原话：「数据都只统计 dsh 宿主中的」）。
   * recall 库同理，而且它更隐蔽：只注入 `RTK_DB_PATH` 时 rtk 仍会把折叠内容写进用户的全局
   * recall 库（实测干净 `HOME` 下一次 `rtk ls -la` 就建出并写一行）。
   *
   * `historyDb` 为空串 = 用户显式关掉了记账：两个都不注入、统计面报不可用。**目录不可建不算
   * 空串**——那时照样注入，因为拿不到变量 rtk 会写进全局库（见 `prepareLedgerDir` 的
   * `LedgerPlan`）。
   */
  readonly ledgerPaths: RtkPaths;
}

/** 跨调用共享的三份依赖，都在 `apply` 顶部造一次。 */
export interface PrefixDeps {
  readonly messages: () => Messages;
  readonly rewriteCache: RewriteCache;
  readonly rewrittenCalls: RewrittenCalls;
  /**
   * 统计埋点（spec §6 的按形态分账，prefix 侧）。
   *
   * 收的是**整条 `PrefixRecord`**而不是几个数字：记录形状（含 `ts`）由 `lib/insights-shape.ts`
   * 定义，装配层只负责在对的时候交出去；把它拆成参数会让「哪几个字段在哪个时刻已知」
   * 散落在两个文件里。从 `PrefixDeps` 而不是 `PrefixOptions` 进来：Options 装的是**配置值**，
   * 而这是副作用，两者的装配时机与测试替身都不一样。
   */
  readonly insights: { readonly recordPrefix: (input: PrefixRecord) => void };
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
 *
 * **最后过一遍 `withoutRtkDbEnv`**：用户 shell 里可能有 `RTK_DB_PATH`（有人手动指过全局库），
 * 而 `rtk rewrite` 只求改写、不记账——把那个变量带进它的子进程等于让行为取决于本插件解释
 * 不了的环境。剔除用 tombstone 而不是删键：宿主的 env 会与父进程合并（见该函数注释）。
 */
function rewriteEnv(options: PrefixOptions): Record<string, string | undefined> {
  const host = options.rewriteHostEnv();
  const base =
    host === "" ? { ...RTK_REWRITE_ENV } : { ...RTK_REWRITE_ENV, RTK_REWRITE_HOST: host };
  return withoutRtkDbEnv(base);
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
 * 遮蔽体自己的记号。**必须是全局注册表里的 Symbol**（`Symbol.for`）：market 的热挂子树与本包
 * 的 bundle 层是**两次 `apply`、同一份模块**（`file://` 与裸包名解析到同一个实例，实测同一 id），
 * 两次装配各自新建闭包，普通字段区分不了「这是不是我写的那个遮蔽体」。
 *
 * 它解决的是「两份实例同时存活」这一形态：第一份已把遮蔽体注册进 agent 作用域，第二份的
 * `get("bash", agent)` 解析出来的就是它——没有记号时只能去 `register` 然后撞同名，而那条错误
 * 会把**整个插件**打成 `fiberPhase: failed`（真机现场：`tool "bash" is already registered in
 * this scope`）。有记号就能认出「本插件已经装过了」，让路而不是抛。
 */
const RTK_SHADOW_MARKER = Symbol.for("jayyuen66.dsh-rtk.shadow");

/** 这个工具体是不是本插件装上去的遮蔽体（按运行期事实判，不靠类型断言）。 */
function isRtkShadow(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, RTK_SHADOW_MARKER) === true
  );
}

/**
 * 给遮蔽体打上记号并原样交回。
 *
 * 用 `Reflect.set` 而不是在对象字面量里写 `[RTK_SHADOW_MARKER]: true`：`ToolDefinition` 是宿主
 * 的类型，收不下一个插件私有的 Symbol 键，字面量写法会被 `tsc` 判成多余属性（实测 `TS2353`）。
 * 而这一位本来就不是类型面——它是运行期记号，只给 `isRtkShadow` 读。
 */
function markAsShadow<Tool extends object>(target: Tool): Tool {
  Reflect.set(target, RTK_SHADOW_MARKER, true);
  return target;
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
 * 账本的两个事实：**往哪注入**，以及**目录核没核过**。
 *
 * 这两件事以前合成一个返回值（空串 = 都不做），后果是「目录建不出来」时连注入都不做——而
 * rtk 拿不到 `RTK_DB_PATH` 就退回它自己 `get_db_path()` 的默认，把 dsh 会话的每一行写进
 * **用户终端那份全局账本**。实测：`HOME=<空目录> rtk git status` 会在
 * `~/Library/Application Support/rtk/history.db` 建库并写 1 行。
 *
 * 拆开之后各归各的：
 * - `inject` 只表达「这个库是我们的」，**配了就注入**，哪怕目录还没建出来；
 * - `writableDir` 表达「目录真能写」，沙箱写根登记与「统计可用」以它为准。
 *
 * 为什么注入一个建不出来的目录是对的：rtk 写不进去时**静默丢弃那一行**（实测 exit 0、
 * stdout 正常、stderr 零字节），命令照跑、账本不脏。少记一行是「统计不可用」，
 * 记进全局账本则是**污染用户的数据**——两者严重性不在一个量级。
 */
interface LedgerPlan {
  /** 注入用的两个库路径；`historyDb` 空串 = 用户把路径配空了，本次不碰账本。 */
  readonly paths: RtkPaths;
  /** 核过的目录；undefined = 建不出来，统计会报不可用，也不登记沙箱写根。 */
  readonly writableDir: string | undefined;
}

/**
 * 备好 rtk 库目录，并交出上面那两个事实。
 *
 * 抽成函数只为让 `installPrefixShadow` 的门禁区两行读得懂：rtk 门 → 账本门。
 *
 * 建目录是**三个写者共同的前提**：rtk 要往 `$DSH_HOME/rtk/history.db` 记账、往 `recall.db`
 * 写折叠中段，我们自己的 `dsh_*` 表也落进 `history.db`。目录建不出来（只读 home、权限不对）
 * 时仍然注入，见 `LedgerPlan`。
 */
function prepareLedgerDir(options: PrefixOptions): LedgerPlan {
  const { ledgerPaths } = options;
  if (ledgerPaths.historyDb === "") {
    return { paths: ledgerPaths, writableDir: undefined };
  }
  const dir = path.dirname(ledgerPaths.historyDb);
  if (ensureRtkDir(dir)) {
    return { paths: ledgerPaths, writableDir: dir };
  }
  // 两个口都留：`log` 是开了诊断才看的逐步流水，`warn` 是默认就能看到的故障播报。
  const line = `[rtk] prefix: cannot prepare ${dir}; statistics will report themselves unavailable`;
  options.log?.(line);
  options.warn?.(line);
  return { paths: ledgerPaths, writableDir: undefined };
}

/**
 * 记一条统计，**绝不把异常漏进工具执行路径**。
 *
 * `InsightsSink` 内部已经包了一层 try/catch，这里再包一层不是重复防御：`deps.insights` 是注入
 * 进来的（测试会换成随手写的假 sink），而统计是纯派生数据——它写坏了只该少一行数字，
 * 不该让一条 `cargo test` 失败。两层各自守自己的边界：sink 守存储，这里守装配。
 */
function safeRecord(record: () => void, log: ((line: string) => void) | undefined): void {
  try {
    record();
  } catch (error) {
    log?.(`[rtk] insights: record failed (${String(error)})`);
  }
}

/**
 * `RewriteAttempt` 的失败原因翻成统计口径的四种结局。
 *
 * 只有 `timeout` 与 `no-rewrite` 有专名：前者是「太慢」，后者是「rtk 不认识这条命令」，两者的
 * 用户动作完全不同（调超时 vs 什么都不用做）。其余（`denied` / `exit-N` / `empty-stdout` /
 * `spawn-failed`）都归 `rewrite-error`——原始原因仍随 `reason` 落库，面板上不丢证据。
 */
function outcomeOf(reason: string): "no-rewrite" | "rewrite-error" | "timeout" {
  if (reason === "timeout") {
    return "timeout";
  }
  return reason === "no-rewrite" ? "no-rewrite" : "rewrite-error";
}

/**
 * 改写决策的两种结局。`rewritten` 支把落地所需的全部东西一次带出去：改写后的命令、原始命令、
 * 转调时要原样回填的其余参数、耗时、被改的家族、以及工作目录（记账要用）。
 */
type PrefixPlan =
  | { readonly kind: "pass-through" }
  | {
      readonly kind: "rewritten";
      readonly command: string;
      readonly raw: string;
      readonly forwarded: Record<string, unknown>;
      readonly latencyMs: number;
      readonly families: readonly string[];
      readonly workdir: string;
    };

/**
 * `pass-through` 只有一个形状，而且它不可变：共用一份比四处各写一个对象字面量更省，
 * 也让「哪些出口是直通」在文件里一眼数得出来。
 */
const PASS_THROUGH: PrefixPlan = { kind: "pass-through" };

/**
 * 一次遮蔽调用的判断段：读命令串 → 算工作目录 → 过闸门 → 跑改写 → 校验形状。
 *
 * 抽成模块级函数是被 `max-lines-per-function`（120 行）逼出来的，但这条上限在这里不是形式主义：
 * 下面每一段都是一道独立判据（能不能读、该不该改、改完像不像），挤在一个函数里时最容易
 * 顺手改错顺序。返回 `pass-through` 的四种结局（读不到命令串、闸门命中、rtk 没给出等价改写、
 * 校验不过）都已经把统计记完，调用方只需要把控制权交回原实现。
 */
async function planPrefixRewrite(
  ctx: PrefixContext,
  options: PrefixOptions,
  deps: PrefixDeps,
  args: unknown,
  exec: ToolRunContext,
): Promise<PrefixPlan> {
  const invocation = readInvocation(args);
  const raw = invocation?.command;
  const commandFamily = raw === undefined ? "unknown" : commandFamilyOf(raw);
  // 统计口径的**分母**：走到这里的每一次 bash 调用都算一次（enabled/forms/supported 三关
  // 之前早退的不算——那不是「统计问题」而是「这一层根本没开」）。
  //
  // 读不到命令串的调用仍要计（family 落 `unknown`），否则「覆盖率」会把「模型发来的形状
  // 不对」这一整类悄悄从分母里划掉。`workdir` 在 `prefix-bash-call` 上不参与任何聚合
  // （`lib/insights-store.ts` 的 `applyPrefix` 对它只跑一条 `SQL_PREFIX_BASH_CALL`），
  // 所以这里给空串，不为了凑字段去 await 一次工作目录解析。
  safeRecord(() => {
    deps.insights.recordPrefix({
      kind: "prefix-bash-call",
      ts: Date.now(),
      commandFamily,
      workdir: "",
    });
  }, options.log);
  if (raw === undefined || invocation === undefined) {
    // 没有可读的命令串：不是本插件认得的调用形状，原样交回去。
    return PASS_THROUGH;
  }
  // 第三位是模型这次调用传的 `workdir`：遮蔽层转调原 execute 时 `args` 原样带下去，
  // 原实现按它跑；插件算 cwd 时不读它就会与「命令实际跑在哪个目录」分叉。
  const cwd = await resolveWorkdir(
    exec,
    /* v8 ignore next —— 真宿主只把作用域键（agent）交给 ensure；这个 undefined 是 ensure
       契约里「没有会话身份」那一位的兜底，进程内没有一条路径会把非 agent 的形状递进来。 */
    async (target) =>
      isAgent(target) ? ctx.workingDirectory.ensure(target, exec.signal) : undefined,
    invocation.forwarded["workdir"],
  );
  // 闸门只在「**全部**段都不能改写」时才整条跳；只要有一段能改，整条就交给 rtk，
  // 再由下面 `restoreGatedSegments` 把不能改的那几段还原。为什么必须这样分两步：
  // `rtk rewrite` 自己是逐段改写的，它会连同不能改的段一起加前缀（实测
  // `aws s3 ls && cargo test` → 两段都加），所以「整条交出去 + 逐段还原」才能既拿到
  // 能改的那部分、又不让不能改的段被改。用户裁定（2026-11）：默认形态 = rtk 支持什么
  // 就改写什么，输出变短是缩略该做的事，不是拒绝改写的理由。
  const gateOptions: RewriteGateOptions = {
    denyCommands: options.denyCommands(),
    cwd,
    vitestMaxMajor: options.vitestMaxMajor,
  };
  const skip = shouldSkipRewrite(raw, gateOptions);
  if (skip !== undefined) {
    safeRecord(() => {
      deps.insights.recordPrefix({
        kind: "prefix-gate-skip",
        ts: Date.now(),
        reason: skip,
        commandFamily,
        workdir: cwd,
      });
    }, options.log);
    return PASS_THROUGH;
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
  const budget = AbortSignal.any([exec.signal, AbortSignal.timeout(options.rewriteTimeoutMs)]);
  // 一次改写尝试的计时起点。**只在这一处取**，差值随下面两条结局各记一次——attempt 本身
  // 不带耗时，否则 store 会把同一次改写的时间加两遍（latency_count 会翻倍）。
  const startedAt = performance.now();
  safeRecord(() => {
    deps.insights.recordPrefix({ kind: "prefix-attempt", ts: Date.now() });
  }, options.log);
  const attempt = await rewriter(raw, budget);
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (attempt.kind === "original") {
    safeRecord(() => {
      deps.insights.recordPrefix({
        kind: "prefix-outcome",
        ts: Date.now(),
        outcome: outcomeOf(attempt.reason),
        reason: attempt.reason,
        commandFamily,
        workdir: cwd,
        latencyMs,
      });
    }, options.log);
    return PASS_THROUGH;
  }
  // P1~P4：改写结果必须只是「在原命令前面加 rtk」那一种形状，其余一律丢弃、原样执行。
  //
  // 先还原被闸门挡住的段，再校验形状：还原用的是 `segment.text` 原样（含段尾空白），
  // 少一个空格会让那一段过不了「未改动段」的判据、把整条丢回原样执行。
  const restored = restoreGatedSegments(raw, attempt.command, gateOptions);
  const rejected = verifyRewrite(raw, restored);
  if (rejected !== undefined) {
    safeRecord(() => {
      deps.insights.recordPrefix({
        kind: "prefix-outcome",
        ts: Date.now(),
        outcome: "verify-rejected",
        reason: rejected,
        commandFamily,
        workdir: cwd,
        latencyMs,
      });
    }, options.log);
    return PASS_THROUGH;
  }
  return {
    kind: "rewritten",
    command: restored,
    raw,
    forwarded: invocation.forwarded,
    latencyMs,
    families: rewrittenFamilies(raw, restored),
    workdir: cwd,
  };
}

/**
 * 落地段：记账 → 注入账本路径 → 转调原实现 → 补 warn hint。
 *
 * 与 `planPrefixRewrite` 的分界是**有没有副作用**：上面那半只做判断与统计，这一半才动记账钩子
 * 与工具调用。分界的实际收益是下面这几步的顺序要求（mark → 记账 → 转调）集中在一屏里看得见，
 * 而它们正是最容易写错的地方。
 */
async function runShadowedBash(input: {
  readonly ctx: PrefixContext;
  readonly options: PrefixOptions;
  readonly deps: PrefixDeps;
  readonly orig: ToolDefinition;
  readonly args: unknown;
  readonly exec: ToolRunContext;
  /**
   * 装配期定下的注入路径（`prepareLedgerDir` 的 `paths`，`historyDb` 空串 = 用户把路径配空了）。
   *
   * 走装配期那一份、而不是每次现读 `options.ledgerPaths` 原文，是为了让「配了」与「不碰」
   * 这两个事实在整层里只算一次：原文是「打算用的路径」，而这一位是「本次装配接受的那条」。
   * 目录建不出来时**它照样有值**（照样注入，理由是 rtk 拿不到变量会写进用户的全局库），
   * 那时统计面报不可用、沙箱登记跳过——这三件事各自独立，别把「目录没核过」读成「不注入」。
   */
  readonly ledgerPaths: RtkPaths;
}): Promise<unknown> {
  const plan = await planPrefixRewrite(
    input.ctx,
    input.options,
    input.deps,
    input.args,
    input.exec,
  );
  if (plan.kind === "pass-through") {
    return input.orig.execute(input.args, input.exec);
  }
  const { options, deps, exec } = input;
  // 记账必须在转调之前：background bash 立即返回，post-execute 可能随后几条语句内就跑；
  // 写在后面就有「B 先压了、C 的账还没记上」的窗口。
  // 记的是**改写后的命令**：结果侧要分辨「改写成 rtk read（逐字节透传）」与「改写成
  // rtk cargo test（真的在压）」这两件事，只记一个「已改写」的 boolean 分辨不出来。
  deps.rewrittenCalls.mark(exec.callId, plan.command);
  // 记账紧跟着 mark：这两个都在「命令真的被改写了」这一支上，而 mark 之后
  // post-execute 可能立刻拿 callId 去查表，所以顺序只能是 mark → 记账 → count → 转调。
  safeRecord(() => {
    deps.insights.recordPrefix({
      kind: "prefix-rewritten",
      ts: Date.now(),
      latencyMs: plan.latencyMs,
      families: plan.families,
      workdir: plan.workdir,
    });
  }, options.log);
  options.log?.(`[rtk] rewrite: ${plan.raw} -> ${plan.command}`);
  // 注入库路径之后再转发：每段 `rtk …` 前面挂 `RTK_DB_PATH='<dsh 库>' RTK_RECALL_DB='<dsh 库>'`。
  //
  // **这是「只统计 dsh 会话」的机制本体**：rtk 按 `get_db_path()` 的第一优先读 `RTK_DB_PATH`，
  // 于是它把行写进 `$DSH_HOME/rtk/history.db`，而用户自己终端里的 `rtk` 仍写全局那份——两条流
  // 从此不相交，本页每个数字都只关于 dsh。`RTK_RECALL_DB` 是同一个决定的另一半：不给它时 rtk
  // 会把折叠掉的输出存进**用户的全局** `recall.db`（实测干净 `HOME` 下跑一次 `rtk ls -la` 就会
  // 建库并写一行），那既是污染、也让「到哪取回」这件事说不清。
  //
  // 空串（用户把路径配空了）时两个都不注入，那是显式选择；**目录建不出来时照样注入**：rtk
  // 写不进去会静默丢掉那一行，而拿不到变量它会写进用户的全局库——污染别人的数据比少记一行
  // 严重得多。
  //
  // 其余参数原样带回，只替换命令这一位（被遮蔽工具的 schema 里可能还有别的字段）。
  const command = withRtkLedgerEnv(plan.command, input.ledgerPaths);
  const result = await input.orig.execute({ ...plan.forwarded, command }, exec);
  if (options.warnHint() && isCargoTest(plan.raw)) {
    return appendWarnHint(result, deps.messages().cargoTestWarnHint);
  }
  return result;
}

/**
 * C 形态装配：给每个新 agent 在它自己的作用域里注册一个同名的 bash，内部先求改写再转调。
 *
 * 装配期门禁一条：装配时 `findOnPath("rtk")` 命中。三平台的 rtk 名称档位
 * （win32 的 `.exe`/`.cmd`/裸名，POSIX 只看裸名）由 `lib/prefix-safety.ts` 的
 * `findOnPath` 按宿主平台处理。
 *
 * **`forms` 与 `enabled` 都不在这条里**：层常驻，`execute` 每次现读
 * `forms().includes("prefix")`、`enabled()` 与 `supported()`。卡片改完形态后下一次工具调用
 * 就生效，不需要重启宿主。早先 `forms` 是装配期门禁，于是「切到 prefix」必须重启；
 * `enabled` 早退则让默认路径整条不通（装好插件、打开开关，下一次 bash 什么都没发生）。
 * spec §4.0.1 的伪码本来就把这两道判断写在 `execute` 里。
 *
 * **版本门也不在这里**：装配期只判「rtk 在不在 PATH 上」，版本要等异步探测回来才知道。所以
 * 「低于下限就停手」落在 `execute` 里的 `options.supported() === false`（逐次现读），不是
 * 这一层的门禁之一。早先这里写的是「版本不在门禁里，rtk 自己对不认识的东西回 rc=1」——
 * 那对 `rewrite` 成立，对 `pipe` 不成立（filter 名它不认识，输出照喂），所以停手得由我们做。
 *
 * 用 `agent.ctx.tools.register` 注册同名工具是宿主的正式语义（scoped 遮蔽 global、随 agent
 * 销毁），不是绕过任何机制：`ToolsService.register` 的 JSDoc 与 `docs/architecture.md`
 * 都明写插件该用 `agent.ctx` 注册 per-agent 工具。
 */
export function installPrefixShadow(
  ctx: PrefixContext,
  options: PrefixOptions,
  deps: PrefixDeps,
): void {
  if (findOnPath("rtk") === undefined) {
    return;
  }
  // 账本目录在这里建：走到这一行才说明「这次装配真的要记账」。
  //
  // 建不出来（只读、权限不足、`$DSH_HOME/rtk` 是符号链接）时**注入路径照样保留**——这一点
  // 与直觉相反，但实测两条路都不好受、只是程度不同：拿不到 `RTK_DB_PATH` 时 rtk 退回自己的
  // `get_db_path()`，把这一行写进**用户终端用的那份全局账本**（污染别人的数据）；给了变量而
  // 目录写不进去时它 exit 0、stderr 零字节、**静默丢掉那一行**（最坏少记一次）。所以这里
  // 保留注入，只把「目录没核过」这件事记在 `writableDir` 上：统计面报不可用、沙箱登记跳过。
  // 建目录失败**不该**让整层失效：那等于让一个附加功能否决主功能。
  const ledger = prepareLedgerDir(options);
  const { paths: injectedPaths } = ledger;

  /**
   * 故障播报：两个口都走一遍。
   *
   * `options.log` 只在开了 `logFilterMode` 时存在（诊断开关，默认关），而这里说的是
   * 「记账这条链已经断了」——默认配置下它必须留下痕迹，否则症状只剩「Insights 页永远空白」。
   * 混用同一个口的后果是：默认配置里故障与噪音一起消失，用户分不出「没采到」与「没数据」。
   * @param line - 要留的一句
   */
  const report = (line: string): void => {
    options.log?.(line);
    options.warn?.(line);
  };

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
    // **让路**：解析出来的已经是本插件装上去的遮蔽体，说明另一个实例先到了。
    //
    // 这不是理论情形：market 的热挂子树用 `file://…/host.js` 直连产物，与 bundle 层的裸包名
    // 解析到**同一个模块实例**（实测同一个 id），但两条层条目各自起一个 fiber、各跑一次 `apply`。
    // 第一份注册完，第二份的 `get("bash", agent)` 拿到的就是那份遮蔽体；此时若照旧 `register`，
    // 宿主会抛 `tool "bash" is already registered in this scope`，**整条插件被打成
    // `fiberPhase: failed`**——真机现场就是这样，用户看到的是「启动失败」。
    //
    // 让路是正确取舍：功能由先到的那一份提供，两份的装配参数来自同一份配置，行为没有差别。
    if (isRtkShadow(found)) {
      options.log?.("[rtk] prefix: another instance already installed the shadow; skipping");
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
        if (
          !options.enabled() ||
          !options.forms().includes("prefix") ||
          options.supported() === false
        ) {
          return orig.execute(args, exec);
        }
        return runShadowedBash({
          ctx,
          options,
          deps,
          orig,
          args,
          exec,
          ledgerPaths: injectedPaths,
        });
      },
    };
    markAsShadow(shadow);
    // 注册进 agent 的作用域：宿主据此遮蔽同名 global 工具，并随 agent 销毁自动退场。
    //
    // **必须经 `ctx.effect` 转手**（插件 fiber 的 effect，不是 `agent.ctx` 的）：`register` 交回的
    // disposer 归**调用方 ctx** 所有，而调用方是 `agent.ctx`——裸调用等于把回收权交给了 agent 的
    // 作用域 fiber，插件卸载时它不会被触发，遮蔽体就留在那里（`probe-scope5` 的 A 行：卸载后
    // `agent` 视图里仍是 `true`）。下一次装配 `installed` 是新的空 Set，于是又去注册，撞
    // `already registered in this scope`。经插件 fiber 转手之后，卸载即回收（同一探针的 B 行）。
    // 沙箱写许可：账本在 `$DSH_HOME/rtk/`（默认 `~/.dsh/rtk/`），通常在会话工作目录之外，
    // 而 workspace-write 沙箱只允许写工作目录——不登记的话 rtk 记账会 EACCES 静默失败，用户看到的
    // Insights 页永远是空的，且没有任何报错。登记的是**目录**（`registerWritableRoot` 拒文件与符号链接）。
    // 登记是 session 级、runtime-only 的（resume/fork 之后由新一轮装配重新登记）；
    // read-only 下它照样生效不了，此时前缀节省不可用、pipe 统计照常（spec §3.1）。
    if (ledger.writableDir !== undefined) {
      registerRtkWritableRoot(ctx, agent, ledger.writableDir, report);
    }
    ctx.effect(() => agent.ctx.tools.register(shadow), "rtk: prefix shadow");
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
 * `forms` 里没有 `pipe` 时监听器仍在栈上，但 `decide` 每次现读 forms 并原样放行。默认形态
 * 不含 pipe 是刻意的：等官方补上 vitest 5 这类缺口后再打开（用户裁定）。
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
  /**
   * 启用的形态，运行期现读。监听器常驻，`decide` 每次判 `forms().includes("pipe")`；
   * 卡片改完形态后下一次工具结果就按新形态处理，不需要重启宿主。
   */
  readonly forms: () => readonly string[];
  /**
   * 下面四位 volatile 配置项与 `PrefixOptions` 的同名项一样**都是取值函数**：卡片改完、
   * 宿主写进配置之后，下一次 `tools/post-execute` 就该用新值。快照写法会让「卡片上的数字」
   * 与「实际生效的数字」长期分叉，而界面上看不出任何异常。
   */
  readonly enabledFilters: () => readonly string[];
  readonly minBytes: () => number;
  readonly minGainRatio: () => number;
  readonly stdoutCapBytes: () => number;
  /**
   * 日志窗口保留的头部 / 尾部行数（`lib/output-window.ts`）。
   *
   * 与上面几位同样是**取值函数**：用户在卡片上把 200 改成 80 之后，下一次 `cat` 就该按新值切。
   * 默认值与 rtk `cap` method 那一组同值（50 / 200），改它们只是换一个观察口径。
   */
  readonly windowHeadLines: () => number;
  readonly windowTailLines: () => number;
  readonly pipeTimeoutMs: number;
  /**
   * 诊断日志：非 `undefined` 时每次管道决策记一行。由 `logFilterMode`（部署级，重启生效）装配，
   * 默认 `undefined` = 关。热路径上不打印，所以它不是常驻开销。
   */
  readonly log: ((line: string) => void) | undefined;
  /** 探到的 rtk 是否达下限；`false` 时这一层整段不跑（与 C 形态同一口径）。 */
  readonly supported: () => boolean | undefined;
  /**
   * rtk 清理链的三处位置与它的开关心跳。
   *
   * `undefined` = 这条路径不可用（配置目录建不出来、用户没开 `hook`、或 rtk 版本不支持
   * `hook` 子命令），此时行为与接入之前逐字节相同。写成取值函数而不是快照：`hook` 同样
   * 在启用集合里，用户勾掉它之后下一次长输出就该不再 spawn。
   *
   * 每次调用现算三处路径的成本可以忽略（纯字符串拼接），但 `prepareHookConfig` 要写文件，
   * 所以它**不在这里**——目录与配置文件在装配期写一次（`apply`），这里只交位置。
   */
  readonly hook: () => HookEnv | undefined;
}

/** `rtk hook` 一次调用需要的位置：配置目录、隔离的家目录、账本、取回库。 */
export interface HookEnv {
  readonly configDir: string;
  readonly home: string;
  readonly dbPath: string;
  readonly recallDb: string;
}

/** B 形态的四份依赖，都在 `apply` 顶部造一次（`messages`/`rewrittenCalls` 与 C 形态共用）。 */
export interface PipeDeps {
  readonly messages: () => Messages;
  readonly rewrittenCalls: RewrittenCalls;
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
  /**
   * 统计写面。收整条 `PipeRecord` 而不是几个数字：记录形状由 `lib/insights-shape.ts` 定义，
   * 这一层不该知道那些字段怎么落库（与 C 形态的 `PrefixDeps.insights` 同款分工）。
   */
  readonly insights: { readonly recordPipe: (input: PipeRecord) => void };
}

/** B 形态单条输入上限：超过它说明用户要的不是这段输出，读进内存只会白占。 */
const MAX_PIPE_INPUT = 10 * 1024 * 1024;

/**
 * 走「本包原地删通过行」的那一个 filter。
 *
 * 只写一处字面量：`modeOf` 拿它判分支，测试拿它当同一枚常量。
 */
const VITEST_FILTER = "vitest";

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
  /**
   * 这一次的压缩在哪一侧做。
   *
   * `rtk` = spawn 一次 `rtk pipe -f <filter>`；`strip` = 本包原地删掉 vitest 的通过行；
   * `window` = 本包在内存里给日志类输出套一层头尾窗口（`lib/output-window.ts`）。
   *
   * 前两支存在的原因是 rtk 自己的解析器在这两种形状上要么吃掉断言（vitest 5 走 Tier2 正则，
   * 实测 4 个失败的 `AssertionError` 计数 4→0），要么根本没有对应的 filter。
   * `window` 那一支的理由更直接：**rtk 的 `read` 在默认档位下逐字节透传**（`--level none`，
   * 实测 `rtk read ps-native.txt` 与原生 md5 相同），`rtk pipe` 也没有 `cat`/日志这档 filter，
   * 所以日志类输出要压只能由本包自己做——顺带把省掉的那段原文落进 spill，取回路径与其余路径一致。
   */
  readonly mode: PipeMode;
  /** 原始命令串：`hook` 那一支要把它放进 PostToolUse 载荷（`is_rtk_command` 靠它判）。 */
  readonly command: string;
  /**
   * 这一条还要不要再套一层本包的头尾窗口。
   *
   * `window` 档恒 `true`；`hook` 档只在「这条命令是日志类目标、且用户没关掉 `window`」时
   * 为 `true`——先过 rtk 的清理链、再切头尾，实测 792 行构建日志 32,550 B → 9,228 B
   * （只窗口是 10,366 B、只清理链是 23,288 B）。
   */
  readonly window: boolean;
  readonly cwd: string;
  readonly extracted: Extracted;
  readonly input: string;
  /** 命令家族：面板按它聚合，与 C 形态用的是同一个 `commandFamilyOf`。 */
  readonly commandFamily: string;
  /** 模型本来会看到的 token 数（定价函数给的，不是字节数）。 */
  readonly originalTokens: number;
  /** 同一个可见面的字节数：可复算的物理量，与 token 各记一次。 */
  readonly originalBytes: number;
}

/** 压缩落在哪一侧。见 `PipePlan.mode`。 */
type PipeMode = "rtk" | "strip" | "window" | "hook";

/**
 * 一条回执的 pipe 判定结果。
 *
 * 原先这里返回的是 `PipePlan | undefined`，而 `undefined` 分不出**为什么**不压。面板要按原因
 * 分账（spec §6.2），诊断日志里那句 `skipped (reason)` 只是给人看的、读不回来。改成分支类型
 * 之后，「不压」的每一处都必须给一个具名原因：加分支时漏掉原因就编译不过。
 */
type PipeDecision =
  | { readonly kind: "plan"; readonly plan: PipePlan }
  | {
      readonly kind: "skip";
      readonly reason: PipeSkipReason;
      readonly filter?: string;
      readonly commandFamily: string;
      readonly workdir: string;
      readonly originalTokens?: number;
      readonly originalBytes?: number;
    };

/**
 * 一次判定里与「目录」无关的那部分入参。
 *
 * 工作目录要 `await` 才拿得到（`workingDirectory.ensure`），而记录分母那一步（`pipe-bash-call`）
 * 在它之前就该落——所以监听器入口先拿一份 `BaseContext`，解析出 cwd 之后再升成 `PlanContext`。
 */
interface BaseContext {
  readonly ctx: HostContext;
  readonly options: PipeOptions;
  readonly deps: PipeDeps;
  readonly exec: ToolExecution;
  readonly result: Readonly<ToolExecutionResult>;
}

/** `planPipe` 一圈判定的共同入参（参数过五个会被 lint 判红，而这几样本就属于同一次判定）。 */
interface PlanContext {
  readonly ctx: HostContext;
  readonly options: PipeOptions;
  readonly deps: PipeDeps;
  readonly exec: ToolExecution;
  readonly result: Readonly<ToolExecutionResult>;
  /** 工作目录：`decide` 解析一次，闸门与 vitest 门共用（两边各解一次会分叉）。 */
  readonly cwd: string;
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

/**
 * 「值得压」的两条量：长度不低于 `minBytes`（按 **UTF-8 字节**）、形态预检通过。
 *
 * 字节而不是字符：模型可见面里混着中文测试名与 emoji，`String.length` 会把 300 个汉字
 * 当成 300 字节，让「看着够长」的输出被当成太短而白丢收益。
 *
 * 上界不在这里判：`pipedPlan` 在算可见面与定价**之前**就要拒掉超大输入，否则一条 10MB 的
 * 输出会先被完整定一次价再被丢掉。
 */
function worthPiping(
  candidate: string,
  filter: string,
  options: PipeOptions,
): PipeSkipReason | undefined {
  let reason: PipeSkipReason | undefined;
  if (Buffer.byteLength(candidate, "utf8") < options.minBytes()) {
    reason = "too-small";
  } else if (
    filter !== WINDOW_FILTER &&
    filter !== HOOK_FILTER &&
    !shapeMatches(filter, candidate)
  ) {
    // `window` 与 `hook` 这两档没有形态可校：前者只问「这段文本是不是够长」，后者是
    // 「任何一段长输出都值得先做一次 ANSI / 进度条 / 重复行清理」。拿 `shapeMatches` 去问
    // 它们必然落空（两者都不在 `SHAPE_TOKENS` 里，函数会放行），但把判据写成显式的例外，
    // 比依赖「未登记就放行」那条兜底更清楚——将来有人给 `SHAPE_TOKENS` 补一条宽泛的默认值时，
    // 这里不会跟着变严。
    reason = "shape-mismatch";
  }
  return reason;
}

/** 把一次「不压」装成记录（可选字段用条件展开：`exactOptionalPropertyTypes` 下不能塞 `undefined`）。 */
function skipRecordOf(decision: Extract<PipeDecision, { kind: "skip" }>, ts: number): PipeRecord {
  return {
    kind: "pipe-skip",
    ts,
    reason: decision.reason,
    commandFamily: decision.commandFamily,
    workdir: decision.workdir,
    ...(decision.filter === undefined ? {} : { filter: decision.filter }),
    ...(decision.originalTokens === undefined ? {} : { originalTokens: decision.originalTokens }),
    ...(decision.originalBytes === undefined ? {} : { originalBytes: decision.originalBytes }),
  };
}

/** 记一条 pipe 记录，异常绝不漏进工具执行路径（与 C 形态的 `safeRecord` 同一纪律）。 */
function safeRecordPipe(
  deps: PipeDeps,
  record: () => PipeRecord,
  log: ((line: string) => void) | undefined,
): void {
  try {
    deps.insights.recordPipe(record());
  } catch (error) {
    log?.(`[rtk] insights: record failed (${String(error)})`);
  }
}

/** 记一条「这里不压」：`skipRecordOf` 负责把可选字段拼齐。 */
function recordSkip(input: BaseContext, decision: Extract<PipeDecision, { kind: "skip" }>): void {
  safeRecordPipe(input.deps, () => skipRecordOf(decision, Date.now()), input.options.log);
}

/**
 * 这一条 filter 的压缩落在哪一侧。
 *
 * `vitest` 一律走 `strip`，**与 vitest 主版本无关**。理由不是「5.x 有 bug，4.x 没有」：
 * 实测 5.x 上 rtk 三级解析全失败、只回一行通告；而 4.x 上它虽然能把 JSON 解开，代价是
 * 走 `--reporter=json` + 结构化摘要，真实的通过行与失败细节仍要被它自己的渲染重写一遍。
 * 本地删行的输入是**模型本来就会看到的那份文本**，删掉的只有 `✓` 行——失败块逐字不动，
 * 也不依赖 rtk 的版本行为。一条路径胜过两条，所以版本门在 B 形态这一侧不再需要。
 */
function modeOf(filter: string): PipeMode {
  let mode: PipeMode = "rtk";
  if (filter === VITEST_FILTER) {
    mode = "strip";
  } else if (filter === WINDOW_FILTER) {
    mode = "window";
  } else if (filter === HOOK_FILTER) {
    mode = "hook";
  }
  return mode;
}

/** 回执拆解与输入判据那一段。 */
async function pipedPlan(
  input: PlanContext & {
    readonly filter: string;
    readonly command: string;
    /** 这一条还要不要再套一层本包的头尾窗口（只有 `hook` 档可能给 false）。 */
    readonly window?: boolean;
  },
): Promise<PipeDecision> {
  const { options, deps, result, filter, command, cwd } = input;
  const commandFamily = commandFamilyOf(command);
  const base = { filter, commandFamily, workdir: cwd };
  const extracted = extractBody(result.value);
  let decision: PipeDecision = { kind: "skip", reason: "no-output", ...base };
  if (extracted !== undefined) {
    const candidate = await pipedInput(result.value, extracted, deps.fs);
    if (candidate === undefined) {
      decision = { kind: "skip", reason: "no-output", ...base };
    } else if (Buffer.byteLength(candidate, "utf8") > MAX_PIPE_INPUT) {
      // 上界先判：不为一条注定被扔掉的大输出做完整定价。
      decision = { kind: "skip", reason: "too-large", ...base };
    } else {
      const visible = visibleSurface(extracted);
      const originalBytes = Buffer.byteLength(visible, "utf8");
      const originalTokens = deps.tokensOf(visible);
      const reason = worthPiping(candidate, filter, options);
      decision =
        reason === undefined
          ? {
              kind: "plan",
              plan: {
                filter,
                mode: modeOf(filter),
                command,
                window: input.window ?? filter === WINDOW_FILTER,
                cwd,
                extracted,
                input: candidate,
                commandFamily,
                originalTokens,
                originalBytes,
              },
            }
          : { kind: "skip", reason, ...base, originalTokens, originalBytes };
    }
  }
  return decision;
}

/**
 * 「这条命令本来能压，但对应的 filter 没启用」——记一次 potential。
 *
 * 这是面板里 `potential-filter` 建议的唯一来源：用户看到「cargo-test 有 12 次本可以压」
 * 才会去把它勾上，而没有这一条时「没命中」与「没启用」在读面上完全一样。
 */
function recordPotential(input: PlanContext, command: string): void {
  const potential = filterOf(command, new Set(ALL_FILTERS));
  if (potential !== undefined) {
    const ts = Date.now();
    safeRecordPipe(
      input.deps,
      () => ({ kind: "potential", ts, day: localDayKey(ts), filter: potential, matches: 1 }),
      input.options.log,
    );
  }
}

/** 命令拿到了之后的判定：共用拒绝层、去重、filter 查表，然后交给 `pipedPlan`。 */
async function planForCommand(
  input: PlanContext & { readonly command: string },
): Promise<PipeDecision> {
  const { options, deps, exec, command, cwd } = input;
  const commandFamily = commandFamilyOf(command);
  // spec §4.2 的拒绝层是**两层共用**的，pipe 层只取对它有意义的那两条（见 `pipeStructuralReject`）。
  // `detail-flag` 是**承重**的那一条：`cargo test -- --nocapture` 命中 cargo-test 这一行，
  // 缺了它 stdout 会被压成一句「1 passed」，`--nocapture` 打出来的整段证据消失（实测 189B→37B、
  // 标记出现 0 次）。`already-rtk` 是保险而非主防线——pipe 表每行都锚 `^`，`rtk cargo test`
  // 本来就命中不了；留着它是因为「表将来若加非锚定行」时这条不能跟着失守。
  if (pipeStructuralReject(command) !== undefined) {
    return { kind: "skip", reason: "structural-reject", commandFamily, workdir: cwd };
  }
  // 这条命令已经被 C 形态改写过：rtk 的那份输出不再适合按原 filter 再压一次。
  //
  // 但「被改写过」不等于「已经被压过」：`rtk rewrite` 会把 `cat build.log` 改写成
  // `rtk read build.log`，而 `rtk read` 的 `--level` 默认 `none`——实测 22,390 B 进、
  // 22,390 B 出，一个字节都没动。那种改写让路等于白丢一次机会（真实账本里这一支有
  // 1,855,886 input token 是日志扩展名命中的），所以判据放在 `shouldSkipPipe` 里按
  // **改写产物**分辨，见 `lib/dedup.ts` 的 `isVerbatimRewrite`。
  if (shouldSkipPipe({ callId: exec.callId }, options.forms(), deps.rewrittenCalls)) {
    return { kind: "skip", reason: "already-rewritten", commandFamily, workdir: cwd };
  }
  // 白名单**在这里现读**（不是装配期快照一份 Set）：`enabledFilters` 标了 volatile，
  // 用户在卡片上勾掉一个 filter 之后，下一次 post-execute 就该按新集合查表。
  const enabled = new Set(options.enabledFilters());
  const filter = filterOf(command, enabled);
  if (filter !== undefined) {
    // 表里命中的命令**不过清理链**：那一路已经由 `rtk pipe -f <filter>` 一步到位
    // （它自己的 filter 就认该工具的输出格式）。硬要先跑 `rtk hook` 会多一次 spawn 且
    // 让 rtk 的 `cap` / 计数器口径与本包窗口互相干扰。用户裁决的范围本来也只有两条：
    // 日志窗口与「无 filter」。
    return pipedPlan({ ...input, filter });
  }
  // 表里没有这行命令时还剩两条路，次序是**先清理链、后本地窗口**：
  //
  // 1. 清理链（`rtk hook`，`lib/rtk-hook.ts`）：`ansi` / `progress` / `dedup` 三件事
  //    `rtk pipe` 的 27 个 filter 一件都做不到——它不读 pipeline 配置。这条路径接管的是
  //    两批输出：日志类目标（`cat` / `journalctl` / `docker logs` / `ps`；`rtk read` 默认
  //    `--level none` 逐字节透传、`rtk pipe` 没有 `cat` 这档）与**没有任何 filter 命中**的
  //    长输出（构建日志、一次性脚本输出那一类，rtk 的账本里占 44%）。
  // 2. 本地头尾窗口（`lib/output-window.ts`）：清理链不可用、关掉、或没省东西时的兜底。
  //    它只在**日志类目标**上生效——读源码一个字节都不动（`isLogTarget` 是命令 × 扩展名
  //    双判据）。日志类目标两条都开时是「先清理再切头尾」，实测 792 行构建日志 32,550 B →
  //    9,228 B（只窗口 10,366 B、只清理链 23,288 B）。
  //
  // 两次 spawn 的代价要先看清：`rtk hook` 与 `rtk pipe` 同量级（实测小输入 19~21 ms）。
  // 这条分支**不是**每条 bash 调用都走——`pipedPlan` 的 `worthPiping` 先用 `minBytes`
  // （默认 256 字节）挡掉短输出，形态预检对这两档不设限（见那里的注释）。
  //
  // **阅读材料一律不碰**（用户裁决：压缩不能让模型读到的东西变样）。`cat src/app.ts`、
  // `head -1000 lib/guard.ts`、`cat notes.txt` 这些是模型用来判断下一步的正文，两条路都
  // 不许压：窗口会挖掉中段，`dedup` 会把连续重复行折成 `[xN]`（实测 200 行相同文档
  // 6,221 B → 102 B）。判据在 `isReadingTarget`，与 `isLogTarget` 是同一把尺子的反面。
  const reading = isReadingTarget(command);
  const windowTarget = !reading && isLogTarget(command);
  const windowReady = enabled.has(WINDOW_FILTER);
  const hookReady = enabled.has(HOOK_FILTER) && options.hook() !== undefined;
  if (hookReady && !reading) {
    return pipedPlan({
      ...input,
      filter: HOOK_FILTER,
      window: windowReady && windowTarget,
    });
  }
  if (windowReady && windowTarget) {
    return pipedPlan({ ...input, filter: WINDOW_FILTER });
  }
  recordPotential(input, command);
  return { kind: "skip", reason: "no-filter", commandFamily, workdir: cwd };
}

/** 把一条回执喂给 pipe 之前要过的全部判据。 */
async function planPipe(input: PlanContext): Promise<PipeDecision> {
  const invocation = readInvocation(input.exec.arguments);
  // `readInvocation` 已经保证「拿到了就一定有字符串 command」，所以这里判的是它有没有值。
  if (invocation === undefined) {
    return { kind: "skip", reason: "no-command", commandFamily: "unknown", workdir: input.cwd };
  }
  return planForCommand({ ...input, command: invocation.command });
}

/** `renderCompressed` 的入参：同一次判定的产物 + 谁在调用。 */
interface RenderInput {
  readonly ctx: HostContext;
  readonly options: PipeOptions;
  readonly deps: PipeDeps;
  readonly exec: ToolExecution;
  readonly plan: PipePlan;
}

/** 省掉的字节数写成人话：`12345` → `12.1 KB`。只用于那一行正文首行，不参与任何账目。 */
function omittedTextOf(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 放宽放行时写进压缩体首行的取回指引。
 *
 * 形状照抄宿主 `dsh-spill-policy` 的 notice（省了多少 + locator + retrievalHint）：官方自己
 * 也是这三段，只是它进 `additionalContexts`，我们这份必须进正文——这一份正文本身少了东西。
 * 模板缺席时退到裸 locator（与 `spillNotice` 同一取舍）：措辞是装饰，路径才是本体。
 */
function relaxedHeaderOf(
  readMessages: () => Messages,
  spilled: SpilledOriginal,
  omitted: number,
): string {
  const template = readMessages().spillRelaxed;
  const text = typeof template === "string" ? template : "{path} {hint}";
  return text
    .replace("{omitted}", omittedTextOf(omitted))
    .replace("{path}", spilled.locator)
    .replace("{hint}", spilled.retrievalHint);
}

/**
 * 落帽时写进正文首行的提示：帽值、切掉多少、原文在哪。
 *
 * 与 spillRelaxed 分开的键：两件事可以同时发生（放宽放行的正文又超了帽），
 * 那时首行会有两句；合成一句会让「为什么少了」和「少了多少」互相盖住。
 */
function cappedHeaderOf(
  readMessages: () => Messages,
  spilled: SpilledOriginal,
  cap: number,
  omitted: number,
): string {
  const template = readMessages().spillCapped;
  const text = typeof template === "string" ? template : "{cap} {omitted} {path} {hint}";
  return text
    .replace("{cap}", String(cap))
    .replace("{omitted}", omittedTextOf(omitted))
    .replace("{path}", spilled.locator)
    .replace("{hint}", spilled.retrievalHint);
}

interface CappedBodyInput {
  readonly cap: number;
  readonly output: string;
  readonly visible: string;
  readonly relaxed: boolean;
  readonly spilled: SpilledOriginal | undefined;
  /** reassemble 会补回来的退出标记（含前面那个换行）占的字节。 */
  readonly suffixBytes: number;
  readonly readMessages: () => Messages;
}

/** 把提示行与正文拼成一个正文；空段不占换行。 */
function joinBodyLines(lines: readonly string[], text: string): string {
  const parts = [...lines, text].filter((part) => part !== "");
  return parts.join("\n");
}

/** 组成最终正文：提示行 + 帽后的正文；提示占的字节也计入帽。 */
function composeCappedBody(input: CappedBodyInput): CappedText & { readonly body: string } {
  const { cap, output, visible, relaxed, spilled, suffixBytes, readMessages } = input;
  const prefixLinesOf = (capped: CappedText): string[] => {
    /* v8 ignore next 3 —— 只有「压缩输出与原可见面逐字相同（无损）且没落 spill」才会带着
       undefined 走到这里；那种情况没有要提示的省略量，提示行为空。真实数据构造不出
       这一格（护栏的收益阈值会先拒绝零收益的压缩），留着是给无损放行留一条明确分支。 */
    if (spilled === undefined) {
      return [];
    }
    const lines: string[] = [];
    if (relaxed) {
      const visibleBytes = Buffer.byteLength(visible, "utf8");
      const cappedBytes = Buffer.byteLength(capped.text, "utf8");
      lines.push(relaxedHeaderOf(readMessages, spilled, Math.max(visibleBytes - cappedBytes, 0)));
    }
    if (capped.truncated) {
      lines.push(cappedHeaderOf(readMessages, spilled, cap, capped.omittedBytes));
    }
    return lines;
  };
  let budget = Math.max(cap, 0);
  let capped = capCompressed(output, budget);
  let lines = prefixLinesOf(capped);
  // 提示长度依赖「是否截断」，截断又依赖提示让出的预算 —— 固定点最多两三轮：
  // 第一轮保守按整帽落，发现截断后加提示；第二轮把提示的字节从帽里扣掉。
  for (let pass = 0; pass < 4; pass += 1) {
    const prefixBytes =
      (lines.length === 0 ? 0 : Buffer.byteLength(lines.join("\n"), "utf8") + 1) + suffixBytes;
    const next = Math.max(cap - prefixBytes, 0);
    if (next === budget) {
      break;
    }
    budget = next;
    capped = capCompressed(output, budget);
    lines = prefixLinesOf(capped);
  }
  let body = joinBodyLines(lines, capped.text);
  // 提示行本身超过帽（帽被设得极小）时上面的固定点收敛不到：再按超出量往下压一次。
  for (let pass = 0; pass < 2 && Buffer.byteLength(body, "utf8") + suffixBytes > cap; pass += 1) {
    const overflow = Buffer.byteLength(body, "utf8") + suffixBytes - cap;
    budget = Math.max(budget - overflow, 0);
    capped = capCompressed(output, budget);
    lines = prefixLinesOf(capped);
    body = joinBodyLines(lines, capped.text);
  }
  return { ...capped, body };
}

/** 把命令的原始可见面落进 spill：取回通道的唯一实现。 */
async function spillOf(input: RenderInput): Promise<SpilledOriginal | undefined> {
  const { ctx, exec, plan } = input;
  // 原文落 spill 用的 owner 是会话 id：`Agent.id` 就是 `SessionId`，不必绕去 header。
  const sessionId = isAgent(exec.agent) ? exec.agent.id : undefined;
  // 单出口：`consistent-return` 不接受「一支 return、一支 return await」的混写，而
  // `return-await` 又不许在 try 外写 await —— 两个规则夹出来的正解是先赋给局部再 return。
  let spilled: SpilledOriginal | undefined;
  if (sessionId !== undefined) {
    spilled = await spillOriginal({
      spillStore: readSpillStore(ctx),
      owner: sessionId,
      toolName: exec.name,
      callId: exec.callId,
      text: plan.input,
    });
  }
  return spilled;
}

/**
 * 护栏拒：记一格 `guard:<reason>`，并把这一条留给面板解释「为什么这次没压」。
 *
 * 同步函数：拒绝路径上除了记账没有别的异步动作，`async` 只会让调用点多一层 await
 * （`typescript(require-await)` 也是这么判的）。
 */
function rejectCompressed(
  input: RenderInput & { readonly latencyMs: number },
  reason: string,
): PostToolDecision | undefined {
  input.options.log?.(`[rtk] pipe ${input.plan.filter}: skipped (${reason})`);
  safeRecordPipe(
    input.deps,
    () => ({
      kind: "pipe-skip",
      ts: Date.now(),
      reason: `guard:${reason}`,
      filter: input.plan.filter,
      commandFamily: input.plan.commandFamily,
      workdir: input.plan.cwd,
      originalTokens: input.plan.originalTokens,
      originalBytes: input.plan.originalBytes,
      latencyMs: input.latencyMs,
    }),
    input.options.log,
  );
  return undefined;
}

/** 压成功之后：落 spill、记账、拼回原形状。 */
async function finishCompressed(
  input: RenderInput & {
    readonly visible: string;
    readonly output: string;
    readonly latencyMs: number;
    /** 已经落好的原文：给了就不再落第二次（放宽判定那条路会先落一次）。 */
    readonly spilled?: SpilledOriginal | undefined;
    /** 护栏原本拒了、因为原文取得回来才放行：正文首行必须点明路径。 */
    readonly relaxed?: boolean;
  },
): Promise<PostToolDecision | undefined> {
  const { options, deps, plan, visible, output, latencyMs, relaxed = false } = input;
  const cap = options.stdoutCapBytes();
  const spilled = input.spilled ?? (await spillOf(input));
  // 取回通道成不成，四个后果里只有「模型看不到原文」是不可见的：
  // - 落了库：诊断日志留一行 locator（默认关时这行不花一次字符串拼接）；
  // - 没落成：warn 一次。压缩照常生效，但模型手里没有取回通道 —— 那是配置或后端的问题，
  //   不该在静默里过去（真宿主上第一次实测就是这么发现的）。
  if (spilled === undefined) {
    deps.log.warn(
      "[rtk] spill: no backend or saveText failed; compressed output has no retrieval path",
    );
    // 压缩改动了正文（`output !== visible`）就是有信息损失；没有取回通道时这条压缩比原文更坏，
    // 整条放弃、把下游原决定（原文）留给模型。只有压缩输出与原可见面逐字相同（无损）时才继续，
    // 那种情况没有「取不回的内容」，下面 `cap-no-spill` 只拦落帽切字节。
    /* v8 ignore next 3 —— 零收益的压缩会被护栏先拒（minGainRatio 0.95），真实数据走不到
       「无损且没 spill」；这里保留无损放行的分支，防将来阈值放宽后误拒无信息损失的压缩。 */
    if (output !== visible) {
      return rejectCompressed({ ...input, latencyMs }, "spill-unavailable");
    }
  } else if (options.log !== undefined) {
    options.log(`[rtk] spill: saved ${spilled.locator}`);
  }
  // 帽一旦切掉字节，模型必须能同时看到「这里少了东西」和「去哪取回」。没有 spill 时
  // 两者都做不到：残件既没有提示、也没有路径 —— 这种压缩比原文更坏，所以整条放弃。
  // 判据用未落帽的文本先判：正文没超帽就不需要取回通道，压缩照常生效。
  // 退出标记是 reassemble 拼回去的，不占 output 的字节，但占最终正文的字节：
  // 帽要把这一截也预留下来，否则「硬上界」在两个字节的 marker 上失守。
  const suffixBytes =
    plan.extracted.marker === "" ? 0 : Buffer.byteLength(`\n${plan.extracted.marker}`, "utf8");
  /* v8 ignore next 3 —— 有损且没 spill 已在上面按 `spill-unavailable` 拒绝；能到这里的
     无 spill 只可能是「压缩输出与原可见面逐字相同」，而那种零收益的压缩会被护栏先挡掉。
     这一条留着防实现漂移：万一将来护栏放宽，落帽切字节仍然不该在没有取回通道时放行。 */
  if (capCompressed(output, Math.max(cap - suffixBytes, 0)).truncated && spilled === undefined) {
    return rejectCompressed({ ...input, latencyMs }, "cap-no-spill");
  }
  const originalBytes = Buffer.byteLength(visible, "utf8");
  // 放宽放行（护栏原本判 lost-hash / folded-entries）与落帽两件事都可能要往正文首行
  // 加提示。提示本身也花字节，所以帽要给它们让位：先按帽落一版，量出提示长度，再把
  // 正文预算缩到 cap - 提示，反复到稳定；最后仍超帽就整条放弃，不交一件超帽的残品。
  const composed = composeCappedBody({
    cap,
    output,
    visible,
    relaxed,
    spilled,
    suffixBytes,
    readMessages: deps.messages,
  });
  if (Buffer.byteLength(composed.body, "utf8") + suffixBytes > cap) {
    return rejectCompressed({ ...input, latencyMs }, "cap-overflow");
  }
  const { body } = composed;
  // 账目仍按「filter 压出来的正文」计（与改造前同口径）：退出标记不是压缩产物，
  // 它只是回填时跟回来的原字节。硬上界那条判据另把 suffixBytes 算进去。
  const compressedBytes = Buffer.byteLength(body, "utf8");
  // token 与字节各算一次：宿主扣钱按前者、可复算的物理量是后者。两侧都用同一个定价函数，
  // 「省下多少」才是同一把尺子量出来的（`savedTokens` 与 `savedBytes` 因此不会互相矛盾）。
  // 两个都按 `body` 算：放宽放行时那一行首行也在上下文里、也要花 token，漏掉它账就虚了。
  const compressedTokens = deps.tokensOf(body);
  safeRecordPipe(
    deps,
    () => ({
      kind: "pipe-success",
      ts: Date.now(),
      filter: plan.filter,
      commandFamily: plan.commandFamily,
      workdir: plan.cwd,
      originalTokens: plan.originalTokens,
      compressedTokens,
      savedTokens: plan.originalTokens - compressedTokens,
      originalBytes,
      compressedBytes,
      latencyMs,
    }),
    options.log,
  );
  const rebuilt = reassemble(plan.extracted, body);
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
  input: RenderInput & { readonly piped: string; readonly latencyMs: number },
): Promise<PostToolDecision | undefined> {
  const visible = visibleSurface(input.plan.extracted);
  // 这一次判定是**最终判定**：护栏不因为「原文可能落得进 spill」而改变自己的结论——答案是
  // 落库之后才知道的，替它先断言「取得到」就是把条件写在事实之前。所以它只看文本本身。
  const guarded = guardCompressed({
    filter: input.plan.filter,
    input: visible,
    output: input.piped,
    minGainRatio: input.options.minGainRatio(),
  });
  if (guarded.ok) {
    input.options.log?.(
      `[rtk] pipe ${input.plan.filter}: ${String(Buffer.byteLength(visible, "utf8"))}B -> ${String(Buffer.byteLength(guarded.output, "utf8"))}B`,
    );
    return finishCompressed({ ...input, visible, output: guarded.output });
  }
  if (guarded.recoverable !== true) {
    return rejectCompressed(input, guarded.reason);
  }
  // 这一拒的成因是「压完少了东西」（`lost-hash` / `folded-entries`）。少了的东西在原文里，
  // 所以先试着把原文落库：落成了模型一条 read 就能看全，压缩可以放行；落不成（没装 spill、
  // 没有会话 id、saveText 失败）就照旧按拒绝处理——**没有取回通道的有损压缩不该进上下文**。
  // 次序是「先落库、再放行」，不是「先放行、再补路径」。
  const spilled = await spillOf(input);
  if (spilled === undefined) {
    input.options.log?.(
      `[rtk] pipe ${input.plan.filter}: skipped (${guarded.reason}): no retrieval path`,
    );
    return rejectCompressed(input, guarded.reason);
  }
  // 落库成功后取收尾之后的那一段（summary 类要折重复行、补 FAILURES 对账）。这里不再判
  // 「会不会被拒」：能走到这一行，说明第一处违规是可被取回通道救回的那两条
  // （`GUARD_RULES` 里带 `recoverable: true` 的 `lost-hash` / `folded-entries`）——其余各道的
  // 结论与上面那次判定逐条相同，而原文此刻已经有了 locator。
  input.options.log?.(
    `[rtk] pipe ${input.plan.filter}: accepted with the original spilled (${spilled.locator})`,
  );
  return finishCompressed({
    ...input,
    visible,
    output: keptOutputOf({ filter: input.plan.filter, input: visible, output: input.piped }),
    spilled,
    relaxed: true,
  });
}

/**
 * 过一遍 rtk 的清理链，再（可选）套本包的头尾窗口。
 *
 * 次序是实测选出来的：**先清理再切头尾**那一边更好（792 行构建日志 9,228 B vs 反过来
 * 9,309 B）。原因是窗口先砍行会让 `dedup` 少看到重复、`progress` 少看到中间帧，而清理
 * 在前时窗口切的是已经干净了的文本。
 *
 * 三层回退，每一层都保留「不压」的可能：
 * 1. 清理链不可用或失败（`hook()` 给 `undefined`、spawn 失败、`never_worse` 判无收益）→ 用原文继续；
 * 2. 有窗口就切；**窗口没超阈值**（`windowOf` 回 `undefined`）时，只要清理链真的改过内容就
 *    交清理后的全文——那本身已经是一次有效压缩（200 行重复告警 6,200 B → 81 B，远低于任何
 *    窗口阈值）；
 * 3. 两层都没动过 → `undefined`，调用方记 `guard:low-gain`（「本来就没什么可省」，不是故障）。
 *
 * `parseHookOutput` 给出 `undefined` 时**没有第三态**：rtk 的空 stdout 既可能是「无收益」也可能是
 * 「配置没读到」，两种都不该让插件去猜——当作没清理过，安全的一侧。
 */
async function hookedTextOf(input: RenderInput): Promise<string | undefined> {
  const { ctx, options, plan } = input;
  const hook = options.hook();
  let cleaned = plan.input;
  if (hook !== undefined) {
    const ran = await runRtkHook({
      subprocess: ctx.subprocess,
      stdin: buildHookPayload({ command: plan.command, stdout: plan.input }),
      cwd: plan.cwd,
      timeoutMs: options.pipeTimeoutMs,
      env: hookEnvOf(hook),
    });
    const parsed = ran.ok ? parseHookOutput(ran.stdout) : undefined;
    if (parsed !== undefined) {
      cleaned = parsed;
    }
  }
  const windowed = plan.window
    ? windowOf(cleaned, options.windowHeadLines(), options.windowTailLines())?.text
    : undefined;
  if (windowed !== undefined) {
    return windowed;
  }
  return cleaned === plan.input ? undefined : cleaned;
}

/**
 * 按 `plan.mode` 拿到「压完之后的那一段」；拿不到就返回 `undefined`。
 *
 * 四支各有一条不 spawn 的理由，也各有一个「拿不到」的语义：
 *
 * - `strip`（vitest）不 spawn：只在内存里删掉 `✓` 通过行。rtk 在 vitest 上拿不到可用的结构化
 *   输入（见 `lib/vitest-strip.ts` 的头注释），而模型本来会看到的就是这份纯文本——删通过行是
 *   「同一份文本变短」，不是「换一条渲染路径重新描述结果」。一行没删掉时它会返回与输入等长的
 *   文本，由护栏的 `low-gain` 判掉。
 * - `window`（日志）不 spawn：`rtk pipe` 里根本没有日志/`cat` 这档 filter，`rtk read` 的默认档位
 *   又是逐字节透传（`--level none`），所以这一段只能本包自己切。`undefined` 的意思是「这份输出
 *   本来就没超头+尾的阈值」——调用方据此记 `guard:low-gain`，不记 `pipe-failed`。
 * - `hook` 会 spawn 一次 `rtk hook claude`，且**可能什么都没变**：清理链判无收益时 rtk 回 0 字节，
 *   窗口又没超阈值时 `hookedTextOf` 也返回 `undefined`。这时同样是「没什么可省」，不是「出错」。
 * - `rtk` 走 `rtk pipe -f <filter>`，spawn 失败或非 0 退出才返回 `undefined`（记 `pipe-failed`）。
 *
 * 计时口径四支一致：调用方在调这里之前取起点，所以面板里的 `latency_ms` 在 `strip` / `window`
 * 档量到的是纯 CPU 耗时（通常 < 1 ms），在 `hook` / `rtk` 档含一次 spawn（实测同量级，约 20 ms）。
 */
async function pipedTextOf(input: RenderInput): Promise<string | undefined> {
  const { ctx, options, plan } = input;
  if (plan.mode === "strip") {
    return stripPassingTests(plan.input).text;
  }
  if (plan.mode === "window") {
    return windowOf(plan.input, options.windowHeadLines(), options.windowTailLines())?.text;
  }
  if (plan.mode === "hook") {
    return hookedTextOf(input);
  }
  const piped = await runRtkPipe({
    subprocess: ctx.subprocess,
    filter: plan.filter,
    stdin: plan.input,
    cwd: plan.cwd,
    timeoutMs: options.pipeTimeoutMs,
  });
  return piped.ok ? piped.stdout : undefined;
}

/**
 * 真正压一次：spawn `rtk pipe`、过护栏、落 spill、记账、把压缩体拼回原形状。
 *
 * 返回 `undefined` 表示这一条不该换值（pipe 失败 / 护栏拒 / 拼回来不是 JSON 值）。
 */
async function renderCompressed(input: RenderInput): Promise<PostToolDecision | undefined> {
  const { options, plan } = input;
  // 计时起点必须在动手**之前**：这一段本身慢是面板里唯一能解释「为什么这条压缩很迟」的量，
  // 把两行相邻写上量到的永远是 0。
  const startedAt = performance.now();
  const piped = await pipedTextOf(input);
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  let accepted: PostToolDecision | undefined;
  if (piped === undefined) {
    safeRecordPipe(
      input.deps,
      () => ({
        kind: "pipe-skip",
        ts: Date.now(),
        // `window` 与 `hook` 这两支拿不到结果都只有一个原因：**这份输出本来就没得省**——
        // 窗口没超头+尾的阈值，或清理链判无收益（rtk 回 0 字节）而窗口也没超阈值。把它记成
        // `pipe-failed` 会让面板把「本来就没什么可省」误报成「rtk 挂了」，那是两件需要用户做
        // 不同反应的事。`guard:low-gain` 与护栏自己那条判据同名同义（`lib/guard.ts` 的
        // `reason` 就是这个串），读面上两处会归到同一档。
        //
        // `rtk` 那一支才真的是 `pipe-failed`：它只有 spawn 失败 / 非 0 退出 / 空回执时回
        // `undefined`，而 `hook` 的空回执在 `hookedTextOf` 里已经被吸收成「没清理过」。
        reason: plan.mode === "window" || plan.mode === "hook" ? "guard:low-gain" : "pipe-failed",
        filter: plan.filter,
        commandFamily: plan.commandFamily,
        workdir: plan.cwd,
        originalTokens: plan.originalTokens,
        originalBytes: plan.originalBytes,
        latencyMs,
      }),
      options.log,
    );
  } else {
    accepted = await acceptCompressed({ ...input, piped, latencyMs });
  }
  return accepted;
}

/** B 形态是否该在这一次结果上工作（三枚 volatile 都现读）。 */
function pipeActiveIn(options: PipeOptions): boolean {
  return options.enabled() && options.forms().includes("pipe") && options.supported() !== false;
}

/** 这一次调用是不是承载输出的 shell（只有 bash / pwsh 归 B 形态管）。 */
function isShellTool(name: string): boolean {
  return name === "bash" || name === "pwsh";
}

/**
 * 记「这次调用发生了什么」并真正动手：分母、跳过原因、压缩三件事都在这里。
 *
 * 与 `decide` 拆开是为了让 `decide` 只剩「交给下游、兜异常」这件事——它的 `try/catch` 语义
 * 与记录顺序是两件互不相干的事，挤在一起时最容易在加分支时改错顺序。
 */
async function applyPipeDecision(
  input: BaseContext,
  decision: PostToolDecision,
  fallback: PostToolDecision,
): Promise<PostToolDecision> {
  if (!pipeActiveIn(input.options)) {
    return fallback;
  }
  const invocation = readInvocation(input.exec.arguments);
  const command = invocation?.command ?? "";
  const commandFamily = commandFamilyOf(command);
  const { options, deps, exec } = input;
  if (!isShellTool(exec.name)) {
    return fallback;
  }
  // 工作目录解析一次：`PipePlan` 拿它当 spawn 的 cwd（`strip` 档不 spawn，但记账里的
  // `workdir` 仍要是同一个值），与 C 形态同一真源——模型按调用传的 `workdir` 优先，
  // 其次是会话 cwd 的两级兜底。
  const cwd = await resolveWorkdir(
    exec,
    async (target) =>
      isAgent(target) ? input.ctx.workingDirectory.ensure(target, exec.signal) : undefined,
    invocation?.forwarded["workdir"],
  );
  const scoped: PlanContext = { ...input, cwd };
  safeRecordPipe(
    deps,
    () => ({ kind: "pipe-bash-call", ts: Date.now(), commandFamily, workdir: cwd }),
    options.log,
  );
  // **两种「下游接管」分开记**：`block` 是下游拦掉了这次调用，`accept` + `value` 是下游换成了
  // 另一份输出。对读者是两件事——前者说明有条规则不让它跑，后者说明有人在改这份结果——
  // 折成同一个 `downstream-value` 之后，跳过原因榜就把「被拦」算进了「被替换」。
  if (decision.kind !== "accept") {
    recordSkip(scoped, {
      kind: "skip",
      reason: "downstream-block",
      commandFamily,
      workdir: cwd,
    });
    return fallback;
  }
  if (Object.hasOwn(decision, "value")) {
    // 下游已经换过值：那不是我们能压的那一份，但「有多少结果被下游接管」是读面要的一格。
    recordSkip(scoped, {
      kind: "skip",
      reason: "downstream-value",
      commandFamily,
      workdir: cwd,
    });
    return fallback;
  }
  if (input.result.isError) {
    recordSkip(scoped, { kind: "skip", reason: "error", commandFamily, workdir: cwd });
    return fallback;
  }
  const pipeDecision = await planPipe(scoped);
  if (pipeDecision.kind === "skip") {
    recordSkip(scoped, pipeDecision);
    return fallback;
  }
  const compressed = await renderCompressed({
    ctx: input.ctx,
    options,
    deps,
    exec,
    plan: pipeDecision.plan,
  });
  return compressed ?? fallback;
}

/**
 * 一次 `tools/post-execute` 的完整判定。
 *
 * 合约约束：先 `await next()` 把决定权交给下游，再决定要不要换；给**失败**结果换 value 会抛
 * `TypeError`，`accept` 同时带 value 与 content 也会抛——所以前置条件全挤进一个 `if`，
 * 而「换不换」只体现在 `output` 的赋值上（单出口，任何意外都让它保持下游的决定）。
 */
async function decide(
  input: BaseContext,
  next: () => Promise<PostToolDecision>,
): Promise<PostToolDecision> {
  // 改名绕开 `node(callback-return`：那条规则把形参名 `next` 认成 node 风格回调，
  // 只要调用后还继续执行就要求「立刻 return」，与这里的 try/catch 单出口写法直接冲突。
  const upstream: () => Promise<PostToolDecision> = next;
  const decision = await upstream();
  let output: PostToolDecision = decision;
  try {
    output = await applyPipeDecision(input, decision, output);
  } catch (error) {
    // 诊断开关打开时把成因写出来：默认吃掉异常是对的（帮忙不该毁掉这次调用），
    // 但**完全无声**会让「为什么这次没压」变成只能靠猜。
    input.options.log?.(`[rtk] pipe: internal error (${String(error)})`);
    // 监听器抛异常会被 pipeline 收成 isError 结果——那等于「插件想帮忙」反而毁掉这次调用，
    // 所以任何意外都退回下游已经给出的决定。
    safeRecordPipe(
      input.deps,
      () => ({
        kind: "pipe-skip",
        ts: Date.now(),
        reason: "pipe-internal",
        commandFamily: "unknown",
        workdir: "",
      }),
      input.options.log,
    );
  }
  return output;
}

/**
 * B 形态装配：挂 `tools/post-execute`，按命令命中的 filter 把**输出**压小。
 *
 * 定位要读准：B **不是** C 失败时的兜底，而是「C 够不着的那一格」——C 只改命令串
 * （`rtk rewrite` 决定范围），B 在结果侧按 filter 压输出。监听器常驻，`decide` 每次现读
 * `forms().includes("pipe")`；卡片改完形态后下一次工具结果就按新形态处理，不需要重启。
 */
export function installPostExecuteListener(
  ctx: HostContext,
  options: PipeOptions,
  deps: PipeDeps,
): void {
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
  /**
   * 用户总开关。**没有静态默认值**：未显式设置时，有效值跟随 rtk 版本探测
   * （`supported === true` 才默认开启）；探测回来前按关闭处理。手动切换会写入显式值，
   * 此后显式值优先。
   */
  enabled: Schema.boolean().volatile(),
  /**
   * 启用的形态。默认只开 C（prefix）：两种形态都会让模型看到的输出与本机原生命令不同，
   * 而后者才是用户没装插件时的基线——默认只动「命令怎么跑」，不动「输出长什么样」。
   *
   * （这条默认与 vitest 无关：从 0.2.1 起 B 形态的 vitest 那一路完全不调 rtk，改由
   * `lib/vitest-strip.ts` 在内存里删掉通过行，既不 spawn 也不再落 `.vitest/json/output.json`。）
   *
   * **volatile 且运行期现读**：两层常驻，C 在 execute 里读、B 在 decide 里读；卡片改完
   * 下一次工具调用即生效，不需要重启宿主。
   */
  enabledForms: Schema.array(Schema.union(["prefix", "pipe"]))
    .default(["prefix"])
    .volatile(),
  /** 用户追加的拒绝前缀（首词字面量）。内置的信息损失拒绝表不受它影响，只增不减。 */
  denyCommands: Schema.array(Schema.string()).default([]).volatile(),
  /**
   * B 形态的 filter 白名单（`DEFAULT_ENABLED_FILTERS` 是一张判据表，理由写在那个常量上方）。
   *
   * 它装的**不是** rtk 的 filter 全表：`window` 与 `hook` 是本包自己的两档，`vitest` 那一路
   * 也不调 rtk。所以「名单里有什么」与「rtk pipe 认得什么」是两件事。
   */
  enabledFilters: Schema.array(Schema.string())
    .default([...DEFAULT_ENABLED_FILTERS])
    .volatile(),
  /** 小于这个字节数不压：压了反而多出说明行。 */
  minBytes: Schema.natural().min(0).default(256).volatile(),
  /** 压缩后必须小于输入的这一比例才采用。 */
  minGainRatio: Schema.number().min(0).max(1).default(0.95).volatile(),
  /** 压缩结果的硬上限（字节）。 */
  stdoutCapBytes: Schema.natural().min(1).default(64_000).volatile(),
  /**
   * 日志窗口保留的头部行数（`lib/output-window.ts`）。默认 50 = rtk `cap` method 的 `HEAD_LINES`。
   *
   * 为什么做成卡片旋钮：同一份日志「看开头多少行」是观察习惯，不是部署预算。50 行够看出
   * 这一步在干什么，而有人要的是前 200 行。**它是 volatile**，改完下一次 `cat` 就生效。
   */
  windowHeadLines: Schema.natural().min(0).default(DEFAULT_WINDOW_HEAD_LINES).volatile(),
  /** 日志窗口保留的尾部行数。默认 200 = rtk `cap` 的 `TAIL_LINES`（错误通常压在最末）。 */
  windowTailLines: Schema.natural().min(0).default(DEFAULT_WINDOW_TAIL_LINES).volatile(),
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
 * `apply` 收到的配置面。**十一项 volatile 是引用（要 `.get()`），五项非 volatile 是普通值**——
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
  windowHeadLines: Volatile<number | undefined>;
  windowTailLines: Volatile<number | undefined>;
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
  /**
   * systemPrompt 面：只用来注册一段常驻摘要（见 `lib/skill.ts` 头注释里「摘要 + skill 全文」
   * 那个拆分）。它进 `inject` 而 `skills` 不进：摘要段是**必需**的（少了它模型不知道自己
   * 读到的输出可能被压过），而 skill 只是全文的载体，服务缺席时摘要照旧生效。
   */
  readonly systemPrompt: SystemPromptFace;
  readonly get: NonNullable<HostContext["get"]>;
  /**
   * 注入口。回调收到的子上下文**只声明本插件真正用到的那两位**（`settings` 与 `effect`）：
   * 取官方 `Context["inject"]` 的话回调参数是完整 `Context`，而 `settings` 是它上面的服务成员，
   * 在本包「类型面按成员投影、不重述官方签名」的纪律下反而不该凭空引用。
   */
  readonly inject: (deps: readonly string[], callback: (child: InjectedContext) => void) => unknown;
  readonly effect: Context["effect"];
  readonly fiber: unknown;
  /**
   * cordis 的注册口（单实例锁要用）。**可选**：`HostContext` 那四个服务面之外的能力，
   * 半栈夹具不一定造；缺了就是「能力缺席」，锁按放行处理（见 shared 的 lib/instance-lock）。
   * 取值时把**对象本身**交出去，不要包一层 `{ provide }`：包出来的箭头恒是函数，会让
   * 「没有注册口」伪装成「有注册口但 provide 抛错」，让路判据当场误判而把插件整个关掉。
   */
  readonly reflect?:
    | { readonly provide?: ((name: string, value?: unknown) => unknown) | undefined }
    | undefined;
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
 * 五个注入都必须是带相应方法的对象。失败即 `apply` 抛错（fail-fast）：
 * 比「装配成功、某次调用才 undefined」可诊断得多。
 *
 * `storageDomain` **不在其中**：Insights 之后统计落在两本自有账本上（SQLite），宿主的
 * storage domain 只用来读一次旧累计账本，读不到就跳过迁移——它缺席不该让整层装不起来。
 * `skills` 同样不在其中：skill 是口径全文的载体，服务缺席时只丢那一份可加载的正文，
 * 常驻摘要段（`systemPrompt.section`）照旧生效。
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
    hasMethod(value, "systemPrompt", ["section"]) &&
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
 * 形态的取值函数。装配期交出去的是「怎么读」，不是读到的值；卡片改完形态后，
 * 下一次工具调用读到的就是新值。
 */
export function formsReaderOf(config: Config): () => readonly string[] {
  return () => formsOr(config.enabledForms.get());
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
 * `enabled` 的兜底不是写死的 true：未显式设置时，由调用方传入的 `ready`（rtk 版本探测结果）
 * 决定；探测回来前是 false。其余几位仍按 schema 默认值兜底。
 */
export function prefixReadersOf(
  config: Config,
  ready: () => boolean | undefined,
): {
  readonly enabled: () => boolean;
  readonly denyCommands: () => readonly string[];
  readonly warnHint: () => boolean;
  readonly rewriteHostEnv: () => string;
} {
  return {
    enabled: () => config.enabled.get() ?? ready() === true,
    denyCommands: () => withDefault(config.denyCommands.get(), []),
    warnHint: () => withDefault(config.warnHint.get(), true),
    rewriteHostEnv: () => withDefault(config.rewriteHostEnv.get(), ""),
  };
}

/** B 形态那几位 volatile 的取值函数；理由同 `prefixReadersOf`。 */
export function pipeReadersOf(
  config: Config,
  ready: () => boolean | undefined,
): {
  readonly enabled: () => boolean;
  readonly enabledFilters: () => readonly string[];
  readonly minBytes: () => number;
  readonly minGainRatio: () => number;
  readonly stdoutCapBytes: () => number;
  readonly windowHeadLines: () => number;
  readonly windowTailLines: () => number;
} {
  return {
    enabled: () => config.enabled.get() ?? ready() === true,
    // 兜底与 schema 的 `.default()` 读同一个常量：两处各写一份字面量时，改一处另一处不变，
    // 而只有退化态（volatile 读到空引用）才会走兜底，正常装出来的行为看不出来。
    enabledFilters: () => withDefault(config.enabledFilters.get(), DEFAULT_ENABLED_FILTERS),
    minBytes: () => withDefault(config.minBytes.get(), 256),
    minGainRatio: () => withDefault(config.minGainRatio.get(), 0.95),
    stdoutCapBytes: () => withDefault(config.stdoutCapBytes.get(), 64_000),
    windowHeadLines: () => withDefault(config.windowHeadLines.get(), DEFAULT_WINDOW_HEAD_LINES),
    windowTailLines: () => withDefault(config.windowTailLines.get(), DEFAULT_WINDOW_TAIL_LINES),
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
 * 取具名 logger；没有 logger 服务时回退 console。
 *
 * 回退是**兼容路径**而非正常路径：cordis 的 `ctx.logger` 是核心服务，正常装配一定在。
 * 留着它是因为「探测失败要留一条痕迹」这件事不该因为 ctx 异常就整条消失——
 * 那种环境下 console 是唯一还写得到的地方。
 */
/**
 * 部署默认的沙箱模式（`read-only` / `workspace-write` / `danger-full-access`）。
 *
 * 只读 `defaultMode` 这一位，且**只读不写**：service 用它决定「要不要去读 rtk 账本」，因为
 * read-only 下 rtk 根本写不进去（spec §9）。会话级 override 有 `registerWritableRoot` 那条
 * 路承担，这里不重复判——两个来源各说一套时，页面会显示一份没人能复现的口径。
 *
 * 结构判定而不是 `as`：这是宿主的可选服务，缺席（单测、老版本）时返回 `undefined`，调用方
 * 按「不知道」处理，也就是照常去读账本。
 * @param ctx - 宿主上下文
 * @returns 模式名，或不知道
 */
export function sandboxModeOf(ctx: HostContext): string | undefined {
  const policy = typeof ctx.get === "function" ? ctx.get("sandboxPolicy") : undefined;
  // `Reflect.get` 返回 `any`：显式落到 `unknown` 再窄化，否则 `typeof` 之后那条 `undefined`
  // 会被 `no-unsafe-assignment` 与 `consistent-return` 一起判掉。整段只有一个 return，
  // 也就避开了「有的分支带值、有的不带」这条判据。
  const mode: unknown =
    typeof policy === "object" && policy !== null ? Reflect.get(policy, "defaultMode") : undefined;
  return typeof mode === "string" ? mode : undefined;
}

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
 * 故障播报口：诊断日志之外那一条必须默认可见的通道。
 *
 * 三处装配（sink、prefix、service）要的是同一个东西——「记账/读面断了」这句话得进宿主 logger，
 * 而不是跟着 `logFilterMode` 走。抽成一处不是为了少写几行：三份各自的内联闭包在覆盖率门里是
 * 三条彼此独立的路径，写成一个函数之后，任何一条走到就证明这一条对，重复的那两条不再各自
 * 挂着一块测不到的分支。
 * @param ctx - 宿主上下文
 * @returns 收一行文本的播报函数
 */
function warnSinkOf(ctx: HostContext): (line: string) => void {
  return (line) => {
    loggerOf(ctx).warn(line);
  };
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
 * 单实例锁的服务名。取包名形态而**不带随机后缀**：名字必须每一份实例都算出同一个串才可能
 * 互斥，随机后缀等于谁都能抢到。判据与边界见 shared 的 lib/instance-lock 头注释。
 */
const INSTANCE_LOCK_KEY = "@jayyuen66/dsh-rtk/instance";

/**
 * 插件总装。
 *
 * 装配顺序有依赖，不能随意调换：设置页（卡片要读 config）→ 文案 thunk → 缓存与账本
 * （两个 installer 共享）→ 存储 → C 遮蔽 → B 监听 → 读面（读面要前两者的 stats/status）。
 */
function apply(ctx: unknown, config: Config): void {
  if (!isRtkHost(ctx)) {
    throw new Error(
      "[rtk] required services (settings/tools/subprocess/workingDirectory/systemPrompt) missing",
    );
  }
  const host = ctx;

  // 0. 抢单实例锁。抢不到说明同一作用域里已经有一份在册（market 热挂 + bundle 层双路径），
  //    那一份已经把工具、设置页与读取面上齐了，本份再注册一遍不可能成功，只会把 fiber 打成
  //    failed（真机现场：`tool "bash" is already registered in this scope`）。
  //    放在最前面：让路那一份不该建缓存、不该开账本、不该装任何监听。
  //    `get` 包一层箭头（成员的 `this` 不能丢），`reflect` 直接交对象本身。
  const lockContext = {
    get: (name: string): unknown => host.get(name),
    reflect: host.reflect,
  };
  if (!claimInstance(lockContext, INSTANCE_LOCK_KEY)) {
    host
      .logger?.("rtk")
      .warn("detected another live instance in this scope; this assembly steps aside");
    return;
  }

  // 1. 设置页注册。owner 必须是本插件 fiber：缺省是 settings 服务自己的 fiber，插件卸载时清不掉。
  //    经注入子上下文挂，随注入子上下文回收（兄弟仓 dsh-zvec-grep 的 configureSettingsPage 同款）。
  host.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, host.fiber), "rtk: settings page");
  });

  // 2. 文案 thunk（每次现读 locale 偏好）。
  const messages = createLocaleMessages(host);

  // 2a. 常驻摘要（systemPrompt）＋ 口径全文（虚拟 skill）。
  //
  //     为什么拆两份：摘要里只放「不照做会误判」的三条（读文件不压、被压掉的原文取回得到、
  //     要精确判断时 `rtk bypass`），每轮都付这点常驻代价是值的；全文约 3.4KB，只在模型真要
  //     判断「这份输出是不是残件」时才值一次加载。两处各放什么见 `lib/skill.ts` 头注释。
  //
  //     skill 注册**不当作装配前提**：`@deepseek-ai/dsh-skill` 未装载时 `get("skills")` 回
  //     undefined，`registerSkill` 只回 false；摘要段照旧生效。所以 `skills` 不进 inject，
  //     也没必要为它加一条 `isRtkHost` 判据。
  //
  //     段名用 `USAGE_SECTION`（`rtk-usage`），顺序 1565：zvec-grep 1550 / ocr-review 1555 /
  //     lesson-loop 1560 之后、jobs 工具说明 1600 之前。
  const registered = messages();
  host.systemPrompt.section({
    name: USAGE_SECTION,
    order: USAGE_ORDER,
    text: registered.usageSummary,
  });
  registerUsageSkill(host, registered.usageText, registered.skillDescription);

  // 2b. 账本位置：`$DSH_HOME/rtk/history.db`，**在装配期解析一次**——`DSH_HOME` 是进程级输入，
  //     解析它不该出现在每次工具调用的热路径上。这里只算路径、**不建目录**：建目录是这一层
  //     真的要装（rtk 在）之后才该做的事，见 `installPrefixShadow`。
  //
  //     落在 dsh 自己家里（而不是 rtk 的全局目录）是**口径决定**：本页只统计 dsh 会话，
  //     而全局 `commands` 表里还有用户终端自己跑的命令。注入 `RTK_DB_PATH` 把 rtk 的记账引到
  //     这里，两条流因此不相交。
  const ledgerPaths = resolveLedgerPaths();

  // 2c. rtk 清理链（`rtk hook`）的三处位置。配置文件在**装配期写一次**：它是本包的产物
  //     （第一行就写明「改动会被覆盖」），每次调用重写只会白做 IO；而三处路径本身是纯字符串
  //     拼接，所以交给 `PipeOptions.hook` 现算不影响 volatile 语义（用户在卡片上勾掉 `hook`
  //     之后下一次长输出就不再 spawn，那一位由 `enabledFilters` 管，不在这里）。
  //
  //     写不出来就明确关掉这条路径并留一行：实测 `RTK_CONFIG_DIR` 指到不存在的目录时
  //     `rtk hook` 回 0 字节（rc 仍是 0），那一路会静默退化成「没收益」，读面上与
  //     「这条输出本来就没得省」完全一样——两种原因不该共用一个读法。
  //
  //     沙箱写许可不单独登记：三处都在 `$DSH_HOME/rtk/` 之下，C 形态已经为账本登记过
  //     那个目录（`registerRtkWritableRoot` 收的是目录，父目录的授权覆盖子目录）。
  const hookPaths = resolveHookPaths();
  const hookConfigDir = prepareHookConfig(hookPaths, pipelineToml());
  const hookEnv =
    hookConfigDir === undefined
      ? undefined
      : {
          configDir: hookConfigDir,
          home: hookPaths.home,
          dbPath: hookPaths.dbPath,
          recallDb: ledgerPaths.recallDb,
        };
  if (hookEnv === undefined) {
    warnSinkOf(host)(
      `[rtk] hook: cannot prepare ${hookPaths.configDir}; the cleanup chain stays off`,
    );
  }

  // 3. 结论缓存与去重账本：跨调用共享，所以必须建在 apply 层而不是 execute 里。
  //    `rewriteCacheSize` 是普通值（部署级）；`rewrittenCalls` 的 512 只是防泄漏兜底，
  //    正确性靠「读后即删」而不是容量。
  const rewriteCache = createRewriteCache(config.rewriteCacheSize);
  const rewrittenCalls = createRewrittenCalls(512);

  // 4b. 分形态统计账本：插件的 `dsh_*` 表写进**同一个 dsh 账本**（`$DSH_HOME/rtk/history.db`），
  //     因此改写行与压缩计数在同一份文件里、两个进程各写自己的表；用户的全局账本一行不动。
  //     为何不借 `engine_attribution`：那张表被 rtk 的 `reset_all()` 无条件全清，我们的行会被
  //     用户的 `rtk gain --reset` 顺手抹掉；自建表 rtk 从不 DROP（实测跑过 reset 与强制重跑
  //     迁移，`dsh_*` 表原样存活）。
  //     同样先空转、`load()` 后台开库：开库要真的 `import("node:sqlite")` 并跑建表 SQL，
  //     而 `apply` 是同步的。开失败只 warn，两个 installer 照常工作（统计面报 unavailable）。
  //     `legacy` 留到迁移那一步接（Task 11）：这里给 undefined = 本次不迁移旧累计账本，
  //     避免在还没写「读旧账本」的代码之前先把它读坏。
  //     `legacy` 是**一次性的迁移输入**：把旧累计账本（宿主 storage domain 里那份
  //     `rtk_stats`）读出来交给开库那一步，由它写进 `meta.legacy` 快照。读不到就跳过——
  //     服务缺席是「这个部署本来没有存储面」，不是故障，所以只是 null；打不开则由 sink 的
  //     回调 warn 一句（那里已经有一层 try/catch）。
  const insights = createDeferredInsights({
    dbPath: ledgerPaths.historyDb,
    legacy: () => loadLegacyAccumulator(host),
    effect: (run, label) => {
      host.effect(run, label);
    },
    warn: warnSinkOf(host),
  });
  void insights.load();

  // 5. 运行时状态（卡片顶部那行）。`probed` 是探测回来的整份结果（原始串 + 是否达下限），
  //    探测是异步且可失败的，所以它是 apply 闭包里的可变位、status 每次现读——卡片轮询到的
  //    那次自然就是最新的。存整份而不是只存串：`supported` 是「版本过低」那句话的唯一依据，
  //    只留串会让卡片分不出「没装」与「装了但太旧」（前者 rtkVersion 也是 null）。
  let probed: { readonly raw: string; readonly supported: boolean } | undefined;
  const status = (): StatsStatus => ({
    rtkPath: findOnPath("rtk") ?? null,
    rtkVersion: probed?.raw ?? null,
    supported: probed?.supported ?? null,
    // 未显式设置时跟随版本探测：探到受支持版本才默认开启；探测前/失败/过旧都是关闭。
    enabled: config.enabled.get() ?? probed?.supported === true,
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
      ...prefixReadersOf(config, supported),
      forms: formsReaderOf(config),
      vitestMaxMajor: config.vitestMaxMajor,
      rewriteTimeoutMs: config.rewriteTimeoutMs,
      log: diag,
      // 故障播报不走 `diag`：后者默认是 `undefined`，而「记账链断了」必须在默认配置下可见。
      warn: warnSinkOf(host),
      supported,
      ledgerPaths,
    },
    {
      messages,
      rewriteCache,
      rewrittenCalls,
      insights: insights.sink,
    },
  );

  // 7. B 形态。取值面与 C 形态同一口径：volatile 全部传闭包，运行期现读。
  installPostExecuteListener(
    host,
    {
      ...pipeReadersOf(config, supported),
      forms: formsReaderOf(config),
      pipeTimeoutMs: config.pipeTimeoutMs,
      log: diag,
      supported,
      hook: () => hookEnv,
    },
    {
      messages,
      rewrittenCalls,
      // 定价口径的唯一入口：服务在就用宿主的 tokenMeter，不在就按同密度字节估算。
      tokensOf: tokenPricerOf(host),
      fs: { readFile: (target) => readFile(target, "utf8") },
      log: loggerOf(host),
      insights: insights.sink,
    },
  );

  // 8. 统计读面。可选：注册失败只让卡片少一栏统计。
  //    不传断言：`installStatsRemote` 收 `unknown`，凭 `reflect.provide` 可调用自己收窄。
  //
  //    服务层要的三样全是**取值函数**：库是异步打开的（这里只能给读取口）、沙箱模式与
  //    启用名单都是卡片上能改的活值。给快照会让页面在装配那一刻冻住。
  //    `sandboxMode` 只读 `defaultMode`：会话级 override 不在部署汇总面反映（spec §9 的
  //    未验证项之一），所以页面文案按部署默认模式说明。
  const service = createInsightsService({
    store: () => insights.store(),
    ledger: createRtkLedger(ledgerPaths.historyDb, ledgerPaths.recallDb),
    status,
    sandboxMode: () => sandboxModeOf(host),
    enabledFilters: () => [...withDefault(config.enabledFilters.get(), DEFAULT_ENABLED_FILTERS)],
    // 读面读不出来时留一行：那是「窗口里没有数据」与「库读不到」的唯一区别，
    // 而这个区别在界面上只体现为一句空窗口。
    warn: warnSinkOf(host),
  });
  installStatsRemote(host, { service });
}

export default {
  inject: ["settings", "subprocess", "tools", "workingDirectory", "systemPrompt"],
  Config: configSchema,
  apply,
};
