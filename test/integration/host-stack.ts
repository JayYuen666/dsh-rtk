// test/integration/host-stack.ts —— C 形态（遮蔽 bash）的半栈。
//
// 只搭「遮蔽层真正拿得到的那几样」：工具注册表、工作目录服务、子进程面、以及一条假 rtk
// （写进临时目录、注入 PATH）。**不 mock 本包的 runRtkRewrite / createRewriter**——那样测
// 的是桩，而不是装配序；这里的判据是「spawn 了几次」与「最终转调的是哪条命令」。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

import type { Messages } from "../../lib/messages.ts";
import type {
  HostContext,
  PipeDeps,
  PrefixDeps,
  PrefixOptions,
  SubprocessFace,
} from "../../host.ts";
import { installPostExecuteListener, installPrefixShadow } from "../../host.ts";
import type { RewrittenCalls } from "../../lib/dedup.ts";
import { createRewrittenCalls } from "../../lib/dedup.ts";
import { createRewriteCache } from "../../lib/rewrite-cache.ts";
import type { StatsStore } from "../../lib/stats-store.ts";
import type { StatsSummary } from "../../lib/stats-shape.ts";

/** 假 rtk 的一条回执：退出码 + stdout，可选的人为延迟（用来测改写超时）。 */
export interface FakeReply {
  readonly exitCode: number;
  readonly stdout: string;
  readonly delayMs?: number;
}

/** 假 bash 定义 + 它收到的命令（**最终转调的那一条**，不是模型最初发的那条）。 */
export interface FakeBash {
  readonly definition: Record<string, unknown>;
  readonly received: string[];
}

/**
 * 假 bash：记录收到的 command，回一条可控的 foreground 结果。
 * 真实 tool-bash 的 `execute` 是 `(args, exec)` 两个参数，这里保持同样的形状。
 */
export function makeFakeBash(
  reply: (command: string) => unknown,
  onExecute?: (command: string) => void,
): FakeBash {
  const received: string[] = [];
  const definition = {
    name: "bash",
    description: "fake bash",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    output: {
      schema: { type: "object" },
      render: (): unknown[] => [{ type: "text", text: "fake" }],
    },
    async execute(args: unknown): Promise<unknown> {
      const { command } = args as { command: string };
      received.push(command);
      // 转调那一刻的观察点：C 形态要求「记账先于转调」，判据只能在执行体内部取。
      onExecute?.(command);
      return reply(command);
    },
  };
  return { definition, received };
}

/** 假 rtk 的可观测面。`spawned()` 读的是它自己写在 plan.json 里的计数器。 */
export interface FakeRtk {
  readonly dir: string;
  readonly spawned: () => number;
  readonly restore: () => void;
}

/**
 * 在临时目录里造一个 `rtk` 可执行文件并把它加进 PATH。
 *
 * 它只认 `rtk rewrite <command>`：按调用顺序消费 `replies`（最后一条可重复），
 * 并把计数写回 plan.json——「计数器动了」就是「真的 spawn 过」的判据。
 */
export function installFakeRtk(cleanups: string[], replies: readonly FakeReply[]): FakeRtk {
  const dir = mkdtempSync(path.join(tmpdir(), "rtk-bin-"));
  cleanups.push(dir);
  const planPath = path.join(dir, "plan.json");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const planPath = ${JSON.stringify(planPath)};
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const reply = plan.replies[Math.min(plan.counter, plan.replies.length - 1)];
plan.counter += 1;
fs.writeFileSync(planPath, JSON.stringify(plan));
const emit = () => { process.stdout.write(reply.stdout); process.exit(reply.exitCode); };
if (reply.delayMs) { setTimeout(emit, reply.delayMs); } else { emit(); }
`;
  writeFileSync(path.join(dir, "rtk"), script, { mode: 0o755 });
  writeFileSync(planPath, JSON.stringify({ replies, counter: 0 }));
  const saved = process.env["PATH"];
  process.env["PATH"] = `${dir}${path.delimiter}${saved ?? ""}`;
  return {
    dir,
    spawned: () => (JSON.parse(readFileSync(planPath, "utf8")) as { counter: number }).counter,
    restore: () => {
      if (saved === undefined) {
        delete process.env["PATH"];
        return;
      }
      process.env["PATH"] = saved;
    },
  };
}

/**
 * 假子进程面：真的 spawn，并把 `spec.signal` 接到子进程上。
 *
 * **必须接**：改写超时那条用例的判据是「不把命令拖满整个超时」，而 abort 要真的杀掉那个
 * 拖 5s 的假 rtk；忽略 signal 的话 `done` 会一直等到子进程自己退出。
 */
export function fakeSubprocess(): SubprocessFace {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      let aborted = false;
      spec.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          child.kill("SIGTERM");
        },
        { once: true },
      );
      const { promise, resolve } = Promise.withResolvers<{
        readonly exitCode: number | null;
        readonly signal: string | null;
      }>();
      child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        // 被插件 abort 掉的那一路，子进程的 signal 可能是 SIGTERM；显式标出来，
        // 免得实现里那条 `outcome.signal === null` 判据靠平台默认行为。
        resolve({ exitCode, signal: aborted ? "SIGTERM" : signal });
      });
      return {
        done: promise,
        collected: { stdout: { readFrom: () => ({ text: stdout }) } },
        terminate: () => {
          child.kill();
        },
      } as never;
    },
  };
}

/** 被遮蔽的那个 bash 工具体：测试只看 `execute` 这一面。 */
export interface ShadedTool {
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

/** 半栈句柄。`withAgent()` 触发一次 `agent/created`，拿到被遮蔽的那个 bash 工具体。 */
export interface PrefixHost {
  readonly fake: FakeBash;
  readonly installed: boolean;
  readonly deps: PrefixDeps;
  /** 子进程面：改写用例靠它读「spawn 时用的 cwd 是谁给的」。 */
  readonly subprocess: SubprocessFace;
  /** 每次真正注册出去的遮蔽体，按注册顺序；`agentId` 是注册到哪个 agent 上。 */
  readonly registrations: readonly { readonly agentId: string; readonly definition: ShadedTool }[];
  readonly withAgent: (id?: string) => ShadedTool;
  /** 每次「命令真的被改写了」记一次（spec §6 的 prefix 分账就是用这个钩子记账的）。 */
  readonly rewrites: readonly string[];
}

/** C 形态半栈：假 ctx 只需 `on` / `tools` / `workingDirectory` / `subprocess` 四样。 */
export async function startPrefixHost(
  overrides: {
    readonly options?: Partial<PrefixOptions>;
    readonly reply?: (command: string) => unknown;
    readonly subprocess?: unknown;
    /** 工作目录服务的回答；缺省回 `process.cwd()`。 */
    readonly ensure?: () => Promise<string>;
    /** 假 bash 转调那一刻的钩子（用来断言「记账先于转调」）。 */
    readonly onExecute?: (command: string) => void;
    /**
     * 覆盖 `ctx.tools.get("bash")` 的返回值。`null` = 该 profile 没装 bash（get 回 undefined）；
     * 传一个没有 `execute` 的对象 = 装了个不可执行的同名工具。两种情况遮蔽层都该静默跳过。
     */
    readonly bash?: unknown;
    /**
     * 注入平台值（默认跟随运行平台）。win32 的装配期降级在 POSIX 测试机上走不到，
     * 而那条分支正是「按平台关掉一层」的唯一判据，必须可测。
     */
    readonly platform?: NodeJS.Platform;
    /** 诊断日志接收口（对应部署开关 `logFilterMode: 'on'`）；不给 = 关。 */
    readonly log?: (line: string) => void;
    /**
     * 装配瞬间**已经存在**的 agent id。半栈会按这些 id 造出带 `ctx.tools.register` 的
     * agent，交成 `agents.list()` 的回答——晚装载那条分支只有从这里进得来。
     */
    readonly liveAgentIds?: readonly string[];
    /**
     * `agents.list()` 的原样回答（覆盖 `liveAgentIds`）。用来验「元素形状不对时逐个跳过」
     * 与「服务面判不过就退回只听事件」这两条退路。
     */
    readonly listedAgents?: readonly unknown[];
    /**
     * `agents.list()` 的**返回值本身**（覆盖 `listedAgents`）：它连「是不是数组」都不保证，
     * 而那条非数组退路正是 `host.ts` 里唯一的 `Array.isArray` else 分支。
     */
    readonly agentsListReply?: unknown;
    /**
     * 复刻「`bash` 只在 **agent 作用域**注册」的 profile 形状（web-app 那套预设就是）：
     * 打开它之后，`ctx.tools.get("bash")` **不带 scope** 回 undefined，带 scope 才回 bash。
     *
     * 这一位是为那格真机缺陷留的回归判据：遮蔽层早先在 `installOn` 里漏传 scope，
     * 于是每个 agent 都「看不到」bash、整层静默不装，而所有单测（替身不看 scope）全绿。
     */
    readonly bashNeedsScope?: boolean;
  } = {},
): Promise<PrefixHost> {
  const fake = makeFakeBash(
    overrides.reply ?? (() => ({ kind: "foreground", exitCode: 0, stdout: { text: "ok" } })),
    overrides.onExecute,
  );
  const scoped: ShadedTool[] = [];
  const registrations: { readonly agentId: string; readonly definition: ShadedTool }[] = [];
  const handlers = new Map<string, (payload: { agent: unknown }) => void>();
  const subprocess = (overrides.subprocess ?? fakeSubprocess()) as SubprocessFace;
  /**
   * `get("bash")` 该回什么。两个解构点都要用，所以先算出来——`overrides.bash ?? fake.definition`
   * 那种写法在 `get` 内部重复一次就是两份口径。
   */
  const bash: unknown = overrides.bash === undefined ? fake.definition : overrides.bash;
  const makeAgent = (id: string): { readonly id: string; readonly ctx: unknown } => ({
    id,
    ctx: {
      tools: {
        register: (definition: unknown): (() => void) => {
          const shaded = definition as ShadedTool;
          scoped.push(shaded);
          registrations.push({ agentId: id, definition: shaded });
          return () => {
            scoped.pop();
          };
        },
      },
    },
  });
  /** `agents.list()` 的回答：显式给的原样用，只给 id 的按 id 造出真 agent。 */
  const liveAgents: unknown =
    overrides.agentsListReply ??
    overrides.listedAgents ??
    (overrides.liveAgentIds ?? []).map((id: string): unknown => makeAgent(id));

  const ctx = {
    subprocess,
    workingDirectory: { ensure: overrides.ensure ?? (async (): Promise<string> => process.cwd()) },
    tools: {
      // **替身必须复刻宿主的 scope 语义**，否则「忘了传 scope」这一格在单测里永远是绿的。
      //
      // 宿主 `ToolsService.get(name, scope)`：`scope` 缺省 = 只看**全局视图**；给了 scope
      // 才把 agent 作用域那几层（`chainLayers(scope)` 与 own 层）并进来。真实 profile 里
      // `bash` 正是由 **agent preset** 注册的（全局 `include:tool-bash` 是 disabled），
      // 所以「传不传 scope」不是风格问题而是取不取得到的问题。
      //
      // `bashNeedsScope` 那一位就是那个形状的替身：给了它，无 scope 的 `get` 回 undefined
      // （= 全局层没有 bash），带 scope 的 `get` 才回 bash。
      //
      // 单出口：`consistent-return` 把 `unknown` 返回类型当成「可以什么都不回」，
      // 于是 `return undefined` 与 `return 值` 混在一支函数里就判红。
      get: (name: string, scope?: unknown): unknown =>
        name === "bash" &&
        bash !== null &&
        (scope !== undefined || overrides.bashNeedsScope !== true)
          ? bash
          : undefined,
    },
    on: (name: string, handler: (payload: { agent: unknown }) => void): void => {
      handlers.set(name, handler);
    },
    // `agents` 服务面：晚装载时补装已存在的 agent 唯一入口。默认**不给**（= 服务不在），
    // 因为绝大多数用例走的是 `agent/created`，凭空给一个空表只会让「到底走没走晚装载那条路」更难读。
    get: (name: string): unknown => (name === "agents" ? { list: () => liveAgents } : undefined),
  };
  /** 每次改写记账的钩子（`PrefixHost` 把它暴露给用例，验「记账与 mark 同序」）。 */
  const rewrites: string[] = [];
  const deps: PrefixDeps = {
    messages: () => ({
      cargoTestWarnHint: "cargo build / cargo check",
      spillSummary: "",
      spillLocation: "{path} {hint}",
    }),
    rewriteCache: createRewriteCache(16),
    rewrittenCalls: createRewrittenCalls(16),
    countRewrite: () => {
      rewrites.push("rewrite");
    },
  };
  installPrefixShadow(
    ctx as unknown as HostContext,
    {
      enabled: () => true,
      forms: ["prefix"],
      // 诊断日志：默认关（只有专门验它的用例显式打开），否则每条用例都会往控制台写一行。
      log: overrides.log,
      supported: overrides.options?.supported ?? (() => true),
      // 五处 volatile 都给取值函数：与生产装配同一口径，用例才能验「改了值下一次调用就生效」。
      denyCommands: () => [],
      vitestMaxMajor: 5,
      // 半栈的假 rtk 是一次真的 node 启动（冷启动 100~400ms），预算必须宽到不会误伤；
      // 「改写超时」那条用例自己把这个值压到 300ms。
      rewriteTimeoutMs: 5000,
      warnHint: () => true,
      rewriteHostEnv: () => "",
      ...overrides.options,
    },
    deps,
    overrides.platform,
  );

  const withAgent = (id = "s1"): ShadedTool => {
    const agent = makeAgent(id);
    handlers.get("agent/created")?.({ agent });
    const registered = scoped.at(-1);
    if (registered === undefined) {
      throw new Error("遮蔽层没有注册任何工具体");
    }
    return registered;
  };
  return {
    fake,
    installed: handlers.has("agent/created"),
    deps,
    subprocess,
    registrations,
    withAgent,
    rewrites,
  };
}

/**
 * 记账用的子进程面：只记录每次 spawn 的 `cwd` / argv / env，回 rc=1（= 这条不压）。
 * 用来断言「改写用的是宿主 ensure 给的那个目录」与「rewrite 带的 env 是哪一套」。
 */
export function recordingSubprocess(): SubprocessFace & {
  readonly calls: { cwd: string; argv: readonly string[]; env: Record<string, string> }[];
} {
  const calls: { cwd: string; argv: readonly string[]; env: Record<string, string> }[] = [];
  return {
    calls,
    spawn(spec) {
      // 宿主把 `env` 与擦除过的父环境合并；这里只留显式传的那几枚，正是断言要看的面。
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      calls.push({ cwd: spec.cwd, argv: [...spec.argv], env });
      const { promise, resolve } = Promise.withResolvers<{
        readonly exitCode: number | null;
        readonly signal: string | null;
      }>();
      resolve({ exitCode: 1, signal: null });
      return {
        done: promise,
        collected: { stdout: { readFrom: () => ({ text: "" }) } },
        terminate: (): void => {
          // 记账桩不真的起进程，也就没有可终止的东西。
        },
      } as never;
    },
  };
}

/** 清掉临时目录（每个测试文件各自 `afterAll` 一次）。 */
export function makeCleanups(): {
  readonly dirs: string[];
  readonly push: (dir: string) => void;
  readonly drain: () => void;
} {
  const dirs: string[] = [];
  return {
    dirs,
    push: (dir: string) => {
      dirs.push(dir);
    },
    drain: () => {
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
      }
      dirs.length = 0;
    },
  };
}

/**
 * 最小 `StatsStore` 桩。
 *
 * 两个职责都不能省：
 * · `boom=true` 时在 `accumulate` 里抛——用来验监听器整体的 try/catch；
 * · **把每一笔记账原样收进 `recorded`**——早先这里的 `accumulate` 是个空函数、`summary()`
 *   回一份写死的零值，于是「字节数传错、filter 传错、prefix 记成了 pipe」这类错在门禁里
 *   一格都测不出来（实测过：把 `originalBytes` 与 `compressedBytes` 对调、把 `form` 改成
 *   `prefix`，全套测试照样绿）。记账是 spec §6 的交付物之一，桩不能替它猜。
 */
function recordingStats(boom: boolean, recorded: unknown[]): StatsStore {
  const summary: StatsSummary = {
    commands: 0,
    originalBytes: 0,
    compressedBytes: 0,
    savedBytes: 0,
    originalTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    savingsPct: 0,
    byFilter: {},
    byForm: { prefix: 0, pipe: 0 },
  };
  return {
    load: (): void => {
      // 桩没有存量可读。
    },
    accumulate: (input): void => {
      if (boom) {
        throw new Error("stub-stats-boom");
      }
      recorded.push(input);
    },
    summary: (): StatsSummary => summary,
    reset: (): Promise<void> => Promise.resolve(),
    flush: (): Promise<void> => Promise.resolve(),
  };
}

/** `startPipeHost` 的开关。`pipe` 是假 `rtk pipe` 的回执；其余几项分别关掉/打开某一条判据。 */
export interface PipeHostOptions {
  /** 收插件 warn 的数组（原文落库失败时那一条）。 */
  readonly warns?: string[];
  /** 收插件 info 的数组（诊断行）。 */
  readonly infos?: string[];
  readonly pipe?: { readonly exitCode: number; readonly stdout: string };
  readonly forms?: readonly string[];
  /** 总开关。默认 `() => true`（本半栈只测 B 形态，装配已由 `forms` 控制）。 */
  readonly enabled?: () => boolean;
  /** 版本门：默认 `() => true`；给 `() => false` 模拟「探到 rtk 低于下限」。 */
  readonly supported?: () => boolean | undefined;
  readonly throwInListener?: boolean;
  /** 参与 pipe 的 filter 名单（默认只开 cargo-test / pytest；vitest 那两条用例自己加）。 */
  readonly filters?: readonly string[];
  /**
   * 三处数值阈值与 filter 名单都可注入**取值函数**（不是值）：`apply` 只跑一次，而它们标了
   * volatile —— 「卡片改完下一次调用即生效」这件事只有靠「消费点现读」才成立，所以半栈也要能
   * 在用例里中途改值、再断言下一次 `run` 用了新值。不给时用固定值。
   */
  readonly minBytes?: () => number;
  readonly minGainRatio?: () => number;
  readonly stdoutCapBytes?: () => number;
  readonly filtersOf?: () => readonly string[];
  /** 装一份假 spill 存储；不给时 `ctx.get` 读不到服务，走「不带全文提示」那一支。 */
  readonly spillStore?: SpillStoreStub;
  /** 诊断日志接收口（对应部署开关 `logFilterMode: 'on'`）；不给 = 关。 */
  readonly log?: (line: string) => void;
  /** 覆盖消息字典（默认用真字典的那几句）；用来逼「模板缺席」这类降级分支。 */
  readonly messages?: () => Messages;
  /** 本半栈收到的每一笔记账（`StatsStore.accumulate` 的原样入参）。 */
  readonly recorded?: unknown[];
}

/** 假 spill 存储：记下每次落库的原文，回一句固定的取回提示。 */
export interface SpillStoreStub {
  readonly saved: string[];
  readonly saveText: (input: unknown) => Promise<{
    readonly locator: string;
    readonly bytes: number;
    readonly retrievalHint: string;
  }>;
}

/** `run` 的第二参：逐字段覆盖回执形状，用来把监听器逼进某一条分支。 */
export interface PipeRunOverrides {
  readonly isError?: boolean;
  /** 工具名（默认 `bash`；用来钉「别的工具不归本层管」）。 */
  readonly name?: string;
  /** 覆盖整个 `exec.arguments`（默认 `{command}`；`null` = 这次调用根本没有参数）。 */
  readonly args?: unknown;
  readonly callId?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly truncated?: boolean;
  readonly spillPath?: string;
  /** 覆盖 `exec.agent`（默认给一个 `{id:'s1'}` 的 agent 形状；`null` = 这次调用没有会话身份）。 */
  readonly agent?: unknown;
  readonly next?: () => unknown;
  /** 把 `value` 当**裸字符串回执**（persistent bash 的形状）直接用，不包成 foreground 结构化回执。 */
  readonly bareString?: boolean;
}

/** B 形态半栈。 */
export interface PipeHost {
  readonly run: (
    value: unknown,
    over?: PipeRunOverrides,
  ) => Promise<{
    readonly decision: unknown;
    readonly stdin: string;
    readonly piped: number;
    readonly cwd: string;
  }>;
  readonly rewrittenCalls: RewrittenCalls;
  readonly dispose: () => void;
}

type PipeHandler = (
  exec: unknown,
  result: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * B 形态半栈：只搭 `tools/post-execute` 这一条瀑布。
 *
 * `run(value, over)` 直调监听器，回 `{decision, stdin, piped}`——`stdin` 是喂给假 pipe 的内容
 * （判「压的是全文还是截断头」），`piped` 是 pipe 被 spawn 的次数（判「哪一条前置判据拦住了」）。
 * **不 mock 本包的 `runRtkPipe`/`guardCompressed`**：那样测的是桩，测不出「谁先判、谁后判」。
 */
/**
 * 裸字符串按 foreground 回执处理：真 bash 的结构化回执就是
 * `{kind:'foreground', stdout:{text}}`，而持久 shell 的裸字符串形状另有 marker
 * （`[Command finished with exit code N]`）。半栈统一走结构化这一支，
 * 测试才能拿一段自然语言式的输出直接喂。
 */
const asReceipt = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  return typeof value === "string"
    ? { kind: "foreground", exitCode: 0, stdout: { text: value } }
    : {};
};

export function startPipeHost(options: PipeHostOptions = {}): PipeHost {
  const pipe = options.pipe ?? { exitCode: 0, stdout: "" };
  let stdin = "";
  let piped = 0;
  let spawnCwd = "";
  const handlers = new Map<string, PipeHandler>();
  const subprocess: SubprocessFace = {
    spawn(spec): never {
      piped += 1;
      spawnCwd = spec.cwd;
      const stream = spec.stdio.stdin;
      // `SubprocessStdinMode` 有三支，这一层只认「给定字节」那一支（另两支没有正文可记）；
      // `'data' in stream` 已经把 union 收窄到唯一带 data 的分支，无需再判 null。
      stdin = typeof stream === "object" && "data" in stream ? stream.data : "";
      const { promise, resolve } = Promise.withResolvers<{
        readonly exitCode: number | null;
        readonly signal: string | null;
      }>();
      resolve({ exitCode: pipe.exitCode, signal: null });
      return {
        done: promise,
        collected: { stdout: { readFrom: () => ({ text: pipe.stdout }) } },
        terminate: (): void => {
          // 假 pipe 不真的起进程。
        },
      } as never;
    },
  };
  const ctx: HostContext = {
    tools: { get: (): undefined => undefined },
    subprocess,
    workingDirectory: { ensure: (): Promise<string> => Promise.resolve(process.cwd()) },
    get: (name: string): unknown => (name === "spillStore" ? options.spillStore : undefined),
    on: (name: string, listener: never): void => {
      handlers.set(name, listener);
    },
  } as never;
  const rewrittenCalls = createRewrittenCalls(16);
  const defaultMessages: Messages = {
    cargoTestWarnHint: "",
    spillSummary: "压缩前的完整输出已另存为文件",
    // 用真字典里的同一句模板：这里若换一句自造文案，测出来的就不是生产会发的那句。
    spillLocation: "压缩前的完整输出已存为 {path}。{hint}",
  };
  const deps: PipeDeps = {
    messages: options.messages ?? (() => defaultMessages),
    rewrittenCalls,
    // 抛出点落在 stats 上而不是 guard 上：guard 是纯函数，喂坏形状也未必抛；而 stats.accumulate
    // 是这条链上必然走到的一步。实现里不为这个开关加任何分支。
    stats: recordingStats(options.throwInListener === true, options.recorded ?? []),
    // 定价口径在夹具里是确定的：`ceil(字节 / 4)`，与宿主 `CHARS_PER_TOKEN = 4` 同密度。
    // 真装配用的是 `ctx.tokenMeter`（见 lib/tokens.ts），两者只在密度上一致、实现无关。
    tokensOf: (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4),
    fs: { readFile: (target) => readFile(target, "utf8") },
    // 原文没落成库时插件要 warn：桩里收进 `options.warns`，默认丢弃（与真装配的 console 回退同形状）。
    log: {
      info: (...line: unknown[]): void => {
        options.infos?.push(line.map(String).join(" "));
      },
      warn: (...line: unknown[]): void => {
        options.warns?.push(line.map(String).join(" "));
      },
    },
  };
  installPostExecuteListener(
    ctx,
    {
      enabled: options.enabled ?? ((): boolean => true),
      forms: options.forms ?? ["pipe"],
      log: options.log,
      supported: options.supported ?? ((): boolean | undefined => true),
      // 四处 volatile 都给取值函数：中途改值必须影响下一次 `run`，这是被测的行为本身。
      enabledFilters: () => options.filtersOf?.() ?? options.filters ?? ["cargo-test", "pytest"],
      minBytes: () => options.minBytes?.() ?? 16,
      minGainRatio: () => options.minGainRatio?.() ?? 0.95,
      stdoutCapBytes: () => options.stdoutCapBytes?.() ?? 64_000,
      pipeTimeoutMs: 300,
      vitestMaxMajor: 5,
    },
    deps,
  );

  const run = async (
    value: unknown,
    over: PipeRunOverrides = {},
  ): Promise<{
    readonly decision: unknown;
    readonly stdin: string;
    readonly piped: number;
    readonly cwd: string;
  }> => {
    const bare = over.bareString === true && typeof value === "string";
    const bareValue: unknown = value;
    const base = bare ? {} : asReceipt(value);
    const original = isRecord(base["stdout"]) ? base["stdout"] : {};
    const stdout: Record<string, unknown> = { ...original };
    if (over.truncated !== undefined) {
      stdout["truncated"] = over.truncated;
    }
    if (over.spillPath !== undefined) {
      stdout["spillPath"] = over.spillPath;
    }
    const exec: Record<string, unknown> = {
      callId: over.callId ?? "call-x",
      name: over.name ?? "bash",
      arguments:
        over.args === null ? undefined : (over.args ?? { command: over.command ?? "cargo test" }),
      agent: over.agent === null ? undefined : (over.agent ?? { id: "s1" }),
      signal: new AbortController().signal,
    };
    // `session.header.cwd` 挂在 **agent** 上（`Agent.session.header`），不是 exec 上：
    // `resolveWorkdir` 的兜底读的是 `agent.session.header.cwd`。
    if (over.cwd !== undefined) {
      exec["agent"] = {
        ...(exec["agent"] as Record<string, unknown>),
        session: { header: { cwd: over.cwd } },
      };
    }
    // 裸字符串形状（persistent bash）必须原样以字符串交出去：`extractBody` 的字符串分支
    // 只认 `typeof value === "string"`，包成对象就变成走结构化那一支了。
    const result = {
      isError: over.isError ?? false,
      value: bare ? bareValue : { ...base, stdout },
    };
    const next = async (): Promise<unknown> =>
      over.next === undefined ? { kind: "accept" } : over.next();
    const handler = handlers.get("tools/post-execute");
    const decision = handler === undefined ? undefined : await handler(exec, result, next);
    return { decision, stdin, piped, cwd: spawnCwd };
  };
  return {
    run,
    rewrittenCalls,
    dispose: (): void => {
      handlers.clear();
    },
  };
}
