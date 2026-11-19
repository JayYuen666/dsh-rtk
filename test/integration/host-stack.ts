// test/integration/host-stack.ts —— 台架只**脚本化进程执行**这一条边界，其余全真。
//
// 早先这一层用手搓的假 ctx + 手搓 exec/result，问题在它只复述了本包已经相信的宿主契约：
// 收据形状、post-execute 的调用位置、工具注册归属全由夹具自己写死，于是「遮蔽体在真流水线里
// 拿得到吗」「插件交回的 value 还能过 tool-bash 的 output schema 吗」这两类问题在桩里恒真。
// 现在：真 Cordis Context + 真 SystemPrompt + 真 ToolRuntime + 真 tool-executor-native +
// 真 dsh-tool-bash；agent 走 dsh-scope 造的真作用域；工具调用走 ctx.tools.execute 整条流水线。
// 唯一替身是 ShellExecutor（进程执行本来就是允许脚本化的边界，见上游 docs/testing.md），
// 它把用例给的 legacy 回执映射成官方 ShellRunResult，并记下真 tool-bash 递进来的命令原文。
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Context as CordisContext } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import { ShellExecutor } from "@deepseek-ai/dsh-shell";
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import { apply as applyShellEnv, inject as shellEnvInject } from "@deepseek-ai/dsh-shell-env";
import { apply as applyToolBash, inject as toolBashInject } from "@deepseek-ai/dsh-tool-bash";
import {
  apply as applyNativeExecutor,
  inject as nativeExecutorInject,
} from "@deepseek-ai/dsh-tool-executor-native";
import { LocalSpillStore } from "@deepseek-ai/dsh-spill-local";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";

import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

import type {
  HookEnv,
  HostContext,
  PipeDeps,
  PrefixContext,
  PrefixDeps,
  PrefixOptions,
  SubprocessFace,
} from "../../host.ts";
import { installPostExecuteListener, installPrefixShadow } from "../../host.ts";
import type { RewrittenCalls } from "../../lib/dedup.ts";
import { createRewrittenCalls } from "../../lib/dedup.ts";
import type { PipeRecord, PrefixRecord } from "../../lib/insights-shape.ts";
import type { Messages } from "../../lib/messages.ts";
import { createRewriteCache } from "../../lib/rewrite-cache.ts";

/** 假 rtk 的一条回执：进程产出的原文与退出码。 */
export interface FakeReply {
  readonly exitCode: number;
  readonly stdout: string;
  /** 真起进程时要等这么久才吐出回执（模拟冷启动）。 */
  readonly delayMs?: number;
}

/** 脚本化 shell 的记账面：received 是真 tool-bash 递进来的命令原文。 */
export interface FakeBash {
  readonly definition: Record<string, unknown>;
  readonly received: string[];
}

/** 一份已装进 PATH 的假 rtk：subprocess 是同一份剧本的内存答案，给不走真进程的用例用。 */
export interface FakeRtk {
  readonly dir: string;
  spawned: () => number;
  restore: () => void;
  readonly subprocess: SubprocessFace;
}

/** 一个 agent 作用域里看到的遮蔽体。execute 与宿主同形：(args, exec)。 */
export interface ShadedTool {
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

/** 假 rtk 的进程脚本：按 plan.json 里的计数器取剧本，最后一条可重复。 */
const FAKE_RTK_SCRIPT = [
  "#!/usr/bin/env node",
  'const { readFileSync, writeFileSync } = require("node:fs");',
  'const { join } = require("node:path");',
  'const plan = JSON.parse(readFileSync(join(__dirname, "plan.json"), "utf8"));',
  "const index = Math.min(plan.counter, plan.replies.length - 1);",
  "plan.counter += 1;",
  'writeFileSync(join(__dirname, "plan.json"), JSON.stringify(plan), "utf8");',
  "const reply = plan.replies[index];",
  "setTimeout(() => {",
  "  if (reply.stdout.length > 0) { process.stdout.write(reply.stdout); }",
  "  process.exit(reply.exitCode);",
  "}, reply.delayMs || 0);",
].join("\n");

const AGENT_CREATED = "agent/created";

/** 模块级「当前那份假 rtk」：startPrefixHost 不显式给 subprocess 时就复用它。 */
let activeFakeRtk: FakeRtk | undefined;

/** 装一份假 rtk 到 PATH 前端，同时给出一份同剧本的内存子进程面。 */
export function installFakeRtk(
  cleanups: readonly string[],
  replies: readonly FakeReply[],
): FakeRtk {
  const dir = mkdtempSync(path.join(tmpdir(), "rtk-bin-"));
  (cleanups as string[]).push(dir);
  writeFileSync(path.join(dir, "rtk"), FAKE_RTK_SCRIPT, "utf8");
  if (process.platform !== "win32") {
    // POSIX 的门禁看执行位；没有 shebang + 0755 时 `findOnPath` 会漏掉这份夹具，
    // 测试于是偷偷依赖机器上真正的 rtk——判据跟着跑测环境走，而不是跟着夹具。
    chmodSync(path.join(dir, "rtk"), 0o755);
  }
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ replies, counter: 0 }), "utf8");
  if (process.platform === "win32") {
    writeFileSync(
      path.join(dir, "rtk.cmd"),
      ["@echo off", 'node "%~dp0rtk" %*', ""].join("\r\n"),
      "utf8",
    );
  }
  const savedPath = process.env["PATH"];
  process.env["PATH"] = `${dir}${savedPath === undefined ? "" : `${path.delimiter}${savedPath}`}`;
  let spawned = 0;
  const subprocess: SubprocessFace = {
    spawn(spec): never {
      const index = Math.min(spawned, replies.length - 1);
      const reply = replies[index]!;
      spawned += 1;
      const { promise, resolve } = Promise.withResolvers<{
        readonly exitCode: number | null;
        readonly signal: string | null;
      }>();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve({ exitCode, signal });
      };
      const emit = (): void => {
        finish(reply.exitCode, null);
      };
      if (reply.delayMs === undefined || reply.delayMs <= 0) {
        emit();
      } else {
        timer = setTimeout(emit, reply.delayMs);
      }
      const { signal } = spec;
      if (signal?.aborted === true) {
        finish(null, "SIGTERM");
      } else {
        signal?.addEventListener(
          "abort",
          () => {
            finish(null, "SIGTERM");
          },
          { once: true },
        );
      }
      return {
        done: promise,
        collected: {
          stdout: { readFrom: (): { text: string } => ({ text: reply.stdout }) },
        },
        terminate: (): void => {
          finish(null, "SIGTERM");
        },
      } as never;
    },
  };
  const fake: FakeRtk = {
    dir,
    spawned: (): number => spawned,
    restore: (): void => {
      activeFakeRtk = undefined;
      if (savedPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = savedPath;
      }
    },
    subprocess,
  };
  activeFakeRtk = fake;
  return fake;
}

/** 一次 spawn 的记账（不含 stdout：这一层只验 argv/cwd/env）。 */
interface RecordedSpawn {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
}

/** 真起子进程的子进程面：假 rtk 脚本、真 rtk 二进制都走这条。 */
export function fakeSubprocess(): SubprocessFace {
  return {
    spawn(spec): never {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      let aborted = false;
      const { promise, resolve, reject } = Promise.withResolvers<{
        readonly exitCode: number | null;
        readonly signal: string | null;
      }>();
      child.on("error", reject);
      spec.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          child.kill("SIGTERM");
        },
        { once: true },
      );
      child.on("close", (exitCode, signal) => {
        resolve({ exitCode, signal: aborted ? "SIGTERM" : signal });
      });
      return {
        done: promise,
        collected: { stdout: { readFrom: (): { text: string } => ({ text: stdout }) } },
        terminate: (): void => {
          child.kill();
        },
      } as never;
    },
  };
}

/** 只记账、不执行：给「命令跑在哪、带了什么 env」这类判据用。 */
export function recordingSubprocess(): SubprocessFace & {
  readonly calls: readonly RecordedSpawn[];
} {
  const calls: RecordedSpawn[] = [];
  return {
    calls,
    spawn(spec): never {
      const env: Record<string, string | undefined> = {};
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
        collected: { stdout: { readFrom: (): { text: string } => ({ text: "" }) } },
        terminate: (): void => {
          // 记账桩不起进程。
        },
      } as never;
    },
  };
}

// ----------------------------------------------------------------------------
// 真实 rtk CLI 回路：环境变量控制，默认 `auto`（装了就真跑，没装就跳过）。
// ----------------------------------------------------------------------------

/** 真实 CLI 回路的开关变量。`real` = 必须有真 rtk（缺了当场红）；`fake` = 一律用假 rtk。 */
export const RTK_TEST_MODE_ENV = "DSH_RTK_TEST_MODE";

export type RtkTestMode = "real" | "fake" | "auto";

/** 读开关。缺省与非法值一律按 `auto`（本地装了就真跑、没装就跳过；CI 显式安装 rtk 并以 `real` 跑）。 */
export function rtkTestMode(env: NodeJS.ProcessEnv = process.env): RtkTestMode {
  const raw = (env[RTK_TEST_MODE_ENV] ?? "").trim().toLowerCase();
  return raw === "real" || raw === "fake" ? raw : "auto";
}

/**
 * 本机 PATH 上那支真 rtk 的自述版本；没有就 undefined（探针自己就起一次真进程）。
 *
 * `error` 必须接住：二进制缺席时只监听 `close` 会让 ENOENT 变成未捕获的 error 事件，
 * 而探针若在模块顶层 await，vitest 收集阶段会静默挂死。超时是第二道保险：PATH 上
 * 若有一支会卡住的 `rtk`，探针也不能把整个文件拖到 hookTimeout。
 */
export async function probeRealRtk(): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const child = spawn("rtk", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    resolve(undefined);
  }, 5000);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.on("error", () => {
    clearTimeout(timer);
    resolve(undefined);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve(code === 0 && stdout.trim() !== "" ? stdout.trim() : undefined);
  });
  return promise;
}

/** 真子进程面：真起 `rtk`，把 stdout/stderr 收进 `collected`（形状照官方 SubprocessHandle）。 */
export function realSubprocess(): SubprocessFace & { readonly spawns: readonly RecordedSpawn[] } {
  const spawns: RecordedSpawn[] = [];
  return {
    spawns,
    spawn(spec): never {
      const env: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      spawns.push({ cwd: spec.cwd, argv: [...spec.argv], env });
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stream = spec.stdio.stdin;
      child.stdin.end(typeof stream === "object" && "data" in stream ? stream.data : undefined);
      child.stdin.on("error", () => {
        // 子进程可能不读 stdin 就退出（EPIPE）；判据看 done 与 stdout，不看这条流。
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let aborted = false;
      const { promise, resolve, reject } = Promise.withResolvers<{
        readonly exitCode: number | null;
        readonly signal: string | null;
      }>();
      child.on("error", reject);
      spec.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          child.kill("SIGTERM");
        },
        { once: true },
      );
      child.on("close", (exitCode, signal) => {
        resolve({ exitCode, signal: aborted ? "SIGTERM" : signal });
      });
      return {
        done: promise,
        collected: {
          stdout: {
            readFrom: (): { text: string; lossy: boolean; truncated: boolean } => ({
              text: stdout,
              lossy: false,
              truncated: false,
            }),
          },
          stderr: {
            readFrom: (): { text: string; lossy: boolean; truncated: boolean } => ({
              text: stderr,
              lossy: false,
              truncated: false,
            }),
          },
        },
        terminate: (): void => {
          child.kill();
        },
      } as never;
    },
  };
}

/** 临时目录的去重账本：每个用例组各自推自己的目录，组结束时一次清掉。 */
export function makeCleanups(): {
  readonly dirs: string[];
  push: (dir: string) => void;
  drain: () => void;
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

/** 脚本化 shell 的配置：用例给的那份 legacy 回执与一个「命令已到达」的观察钩子。 */
interface ScriptedShellConfig {
  readonly reply?: ((command: string) => unknown) | undefined;
  readonly onExecute?: ((command: string) => void) | undefined;
}

/** 一条命令的脚本化结果（官方 ShellRunResult 之外只需要这三样）。 */
interface ScriptedOutcome {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 真真 read 的 ShellExecutor：进程执行是本层唯一允许脚本化的边界。
 *
 * 它所在的装配是真的（tool-bash 用官方的 OneOf 收据 schema、真流水线做 schema 校验与渲染），
 * 于是插件交回的 value 一旦偏离官方形状就会当场变 isError，而不是被夹具悄悄接受。
 */
export class ScriptedShell extends ShellExecutor {
  public readonly received: string[] = [];
  /**
   * 用普通字段而不是 `#private`：宿主交来的是 cordis 的服务代理，方法体里的 `this` 是那层
   * 代理——读私有成员会当场抛 `Cannot read private member … from an object whose class did not
   * declare it`，真流水线里第一次改写就整条变 isError（实测）。公开字段经代理转发，行为不变。
   */
  public readonly replyOf: (command: string) => unknown;
  public readonly observed: ((command: string) => void) | undefined;

  public constructor(ctx: CordisContext, config: ScriptedShellConfig = {}) {
    super(ctx);
    this.replyOf = config.reply ?? ((): undefined => undefined);
    this.observed = config.onExecute;
  }

  /** 把用例给的 legacy 回执（{kind:'foreground', exitCode, stdout:{text}}）折成官方结果。 */
  public outcomeOf(command: string): ScriptedOutcome {
    const reply = this.replyOf(command);
    const record = isRecord(reply) ? reply : {};
    const stdoutOf = record["stdout"];
    const stderrOf = record["stderr"];
    const stdout =
      isRecord(stdoutOf) && typeof stdoutOf["text"] === "string" ? stdoutOf["text"] : "";
    const stderr =
      isRecord(stderrOf) && typeof stderrOf["text"] === "string" ? stderrOf["text"] : "";
    const exitCode = typeof record["exitCode"] === "number" ? record["exitCode"] : 0;
    return { exitCode, signal: null, stdout, stderr };
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- resolve 只读进程事实，不持实例状态；静态化会破覆写契约
  public override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 20_000,
      onExpiry: request.onExpiry ?? "none",
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      sandboxPolicy: request.sandboxPolicy,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
    };
  }

  public override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    this.received.push(spec.command);
    this.observed?.(spec.command);
    const outcome = this.outcomeOf(spec.command);
    const stdout = { text: outcome.stdout, truncated: false };
    const stderr = { text: outcome.stderr, truncated: false };
    const run: ShellRunResult = {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout,
      stderr,
    };
    return {
      status: "completed",
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      done: Promise.resolve(),
      observed: {
        stdout: { readFrom: () => ({ text: outcome.stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: outcome.stderr, lossy: false }) },
      },
      readOutput: () => ({ stdout, stderr }),
      kill: (): boolean => false,
      result: async (): Promise<ShellRunResult> => run,
    } as unknown as ShellExecution;
  }
}

/** 会话头里的 cwd（真实宿主一定带着它；是 `workingDirectory.ensure` 的兜底读数）。 */
function sessionCwdOf(agent: unknown): string | undefined {
  const session = isRecord(agent) ? agent["session"] : undefined;
  const header = isRecord(session) ? session["header"] : undefined;
  const cwd = isRecord(header) ? header["cwd"] : undefined;
  return typeof cwd === "string" ? cwd : undefined;
}

/** 真 agent 的最省形状判据，与 `host.ts` 的 `isAgent`（对象 + 字符串 id）同口径。 */
function isAgentLike(value: unknown): boolean {
  return isRecord(value) && typeof value["id"] === "string";
}

/** 把用例给的 legacy 回执（`{kind:'foreground', exitCode, stdout:{text}}`）当结构化值用。 */
function asReceipt(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return typeof value === "string"
    ? { kind: "foreground", exitCode: 0, stdout: { text: value } }
    : {};
}

/**
 * 给只带 `command` 的调用补一份 `description`。
 *
 * 真 tool-bash 的作者面参数表要求 description 非空（模型调用时必然带）；夹具里那些只给 command
 * 的用例在这里补一份同形的建模事实，否则真参数校验会先把调用判成 isError。
 */
function prepareArgs(args: unknown): unknown {
  if (!isRecord(args) || typeof args["command"] !== "string") {
    return args ?? {};
  }
  if (typeof args["description"] === "string") {
    return args;
  }
  return { ...args, description: "fixture bash call" };
}

/**
 * 临时把宿主交来的会话头 cwd 盖到本 agent 的 header 上，跑完还原。
 *
 * scope key 就是这同一个对象（`createScope` 按引用认作用域），所以不能换新对象；而
 * `tool-bash` 的 cwd 取自 `workingDirectory.ensure(exec.agent)`，与插件那条同源。
 */
async function withSessionCwd<Result>(
  agent: Record<string, unknown>,
  cwd: string | undefined,
  action: () => Promise<Result>,
): Promise<Result> {
  const session = isRecord(agent["session"]) ? agent["session"] : undefined;
  const header =
    session !== undefined && isRecord(session["header"]) ? session["header"] : undefined;
  if (cwd === undefined || header === undefined) {
    return action();
  }
  const previous = header["cwd"];
  header["cwd"] = cwd;
  try {
    return await action();
  } finally {
    header["cwd"] = previous;
  }
}

/** 真外壳装配的输入：子进程面、工作目录答案、命令剧本。 */
interface ShellRigOptions {
  readonly subprocess: SubprocessFace;
  readonly ensure: (agent?: unknown) => Promise<string>;
  readonly reply: (command: string) => unknown;
  readonly onExecute?: ((command: string) => void) | undefined;
  readonly sandboxPolicy?: unknown;
}

/** 真外壳装配的产物：根上下文、带 inject 的子上下文、脚本化 shell。 */
interface ShellRig {
  readonly root: CordisContext;
  readonly inner: CordisContext;
  readonly shell: ScriptedShell;
}

/**
 * 起重最小真装配：SystemPrompt → ToolRuntime → 原生执行器 → shellEnv → 脚本化 shell → 真 tool-bash。
 *
 * 这套顺序来自官方 `packages/core/tools/tests/tools.spec.ts` 的最小组合；少挂任何一位，
 * tool-bash 的 apply 就会在 `ctx.shell` / `ctx.shellEnv` 上取空。
 */
async function mountShellRig(options: ShellRigOptions): Promise<ShellRig> {
  const root = new CordisContext();
  await root.plugin(SystemPrompt);
  await root.plugin(ToolRuntime);
  await root.plugin({ inject: nativeExecutorInject, apply: applyNativeExecutor });
  await root.plugin({ inject: shellEnvInject, apply: applyShellEnv });
  root.provide("subprocess", options.subprocess);
  root.provide("workingDirectory", {
    ensure: (agent?: unknown): Promise<string> => options.ensure(agent),
    get: (): string => process.cwd(),
    change: async (): Promise<string> => process.cwd(),
  });
  if (options.sandboxPolicy !== undefined) {
    root.provide("sandboxPolicy", options.sandboxPolicy);
  }
  await root.plugin(
    ScriptedShell,
    options.onExecute === undefined
      ? { reply: options.reply }
      : { reply: options.reply, onExecute: options.onExecute },
  );
  const shell = root.get("shell");
  if (shell === undefined) {
    throw new Error("真装配没有装上 shell 服务");
  }
  await root.plugin({ inject: toolBashInject, apply: applyToolBash });
  const innerRef: { current?: CordisContext | undefined } = {};
  await root.plugin(
    Object.assign(
      (ctx: CordisContext, _config: unknown) => {
        innerRef.current = ctx;
      },
      { inject: ["tools", "subprocess", "workingDirectory", "shellEnv"] },
    ) as never,
    {} as never,
  );
  const inner = innerRef.current;
  if (inner === undefined) {
    throw new Error("真装配没有造出带 inject 的子上下文");
  }
  return { root, inner, shell: shell as ScriptedShell };
}

/** startPrefixHost 的开关（语义见各字段注释；与旧夹具逐条对齐）。 */
interface PrefixHostOverrides {
  /** 插件自身的 options；与本层开关重名时后者优先（supported / forms）。 */
  readonly options?: Partial<PrefixOptions> | undefined;
  /** 命令 → legacy 回执。默认 {`kind:'foreground'`, exitCode 0, stdout 'ok'}。 */
  readonly reply?: ((command: string) => unknown) | undefined;
  /** 子进程面；缺省复用 installFakeRtk 那份，再缺省用真 spawn。 */
  readonly subprocess?: SubprocessFace | undefined;
  /** workingDirectory.ensure 的答案；缺省 process.cwd()。 */
  readonly ensure?: (() => Promise<string>) | undefined;
  /** 每次命令到达 shell 时先调一次（记账先于转调）。 */
  readonly onExecute?: ((command: string) => void) | undefined;
  /** 该 profile 的 bash 定义：null = 没装；对象 = 用它替代全局那份。 */
  readonly bash?: unknown;
  readonly log?: ((line: string) => void) | undefined;
  readonly warn?: ((line: string) => void) | undefined;
  /** 装配瞬间就存在的 agent（走真 agent/created 之前的那条 readLiveAgents 路）。 */
  readonly liveAgentIds?: readonly string[] | undefined;
  /** agents.list 的回答（形状不保证，给非数组用）。 */
  readonly listedAgents?: readonly unknown[] | undefined;
  /** 连数组都不保证的服务面替身：原样交给插件，验它的守卫。 */
  readonly agentsListReply?: unknown;
  /** bash 只在 agent 作用域注册（全局视图取不到）。 */
  readonly bashNeedsScope?: boolean | undefined;
  readonly sandboxPolicy?: unknown;
  /** 统计收件箱；缺省记进 prefixRecords。 */
  readonly insights?: PrefixDeps["insights"] | undefined;
}

/** 半栈对外的那一份：fake 是记账面，withAgent 是「真 agent 作用域里的遮蔽体」。 */
export interface PrefixHost {
  readonly fake: FakeBash;
  readonly installed: boolean;
  readonly deps: PrefixDeps;
  readonly subprocess: SubprocessFace;
  readonly registrations: readonly { readonly agentId: string; readonly definition: ShadedTool }[];
  withAgent: (id?: string) => ShadedTool;
  readonly prefixRecords: readonly PrefixRecord[];
  disposeFiber: () => Promise<void>;
  visibleShadows: () => readonly ShadedTool[];
}

/**
 * 真装配下的 prefix 台架：真 ctx + 真 tool-bash，agent 是真 dsh-scope 作用域。
 *
 * 与旧夹具的差别全在「谁定义契约」：旧版自己造 tools.get 与 exec/result，本版让
 * `ctx.tools.execute` 走完整流水线，插件看到的 exec/result 由宿主产出。
 */
export async function startPrefixHost(overrides: PrefixHostOverrides = {}): Promise<PrefixHost> {
  const subprocess = overrides.subprocess ?? activeFakeRtk?.subprocess ?? fakeSubprocess();
  /**
   * 会话工作目录的答案：真 agent 形状问用例给的 `ensure`（缺省读会话头、再缺省 process.cwd()），
   * 非 agent 形状退到会话头——与 `lib/rewrite-gate.ts` 的 `resolveWorkdir` 两级同源，这样插件算出来
   * 的 cwd 与 `tool-bash` 实际跑命令的那个目录一致。
   */
  const ensure = (agent?: unknown): Promise<string> => {
    if (isAgentLike(agent) && overrides.ensure !== undefined) {
      return overrides.ensure();
    }
    return Promise.resolve(sessionCwdOf(agent) ?? process.cwd());
  };
  const reply =
    overrides.reply ??
    ((): unknown => ({ kind: "foreground", exitCode: 0, stdout: { text: "ok" } }));
  const rig = await mountShellRig({
    subprocess,
    ensure,
    reply,
    ...(overrides.onExecute === undefined ? {} : { onExecute: overrides.onExecute }),
    ...(overrides.sandboxPolicy === undefined ? {} : { sandboxPolicy: overrides.sandboxPolicy }),
  });
  const prefixRecords: PrefixRecord[] = [];
  const scopes: { dispose?: () => Promise<void>; rawDispose: () => void | Promise<void> }[] = [];
  const scopesById = new Map<
    string,
    { ctx: CordisContext; rawDispose: () => void | Promise<void> }
  >();
  const agentsById = new Map<string, Record<string, unknown>>();
  const makeAgent = (id: string): Record<string, unknown> => {
    const key: Record<string, unknown> = { id };
    const scope = createScope(rig.inner, key);
    key["ctx"] = scope.ctx;
    key["session"] = { id: `sess-${id}`, header: { cwd: process.cwd() } };
    agentsById.set(id, key);
    scopesById.set(id, { ctx: scope.ctx, rawDispose: scope.rawDispose });
    scopes.push({ rawDispose: scope.rawDispose });
    return key;
  };
  const liveAgents = (overrides.liveAgentIds ?? []).map((id) => makeAgent(id));
  /** 插件读到的那份 `agents.list()`：用例可以整表替换（形状不保证的那几条靠它）。 */
  const listedForPlugin: readonly unknown[] = overrides.listedAgents ?? liveAgents;
  rig.root.provide("agents", {
    list: (): unknown => overrides.agentsListReply ?? listedForPlugin,
  });
  const messages: Messages = {
    cargoTestWarnHint: "cargo build / cargo check",
    spillSummary: "",
    spillLocation: "{path} {hint}",
    spillRelaxed: "{omitted} {path} {hint}",
    spillCapped: "{cap} {omitted} {path} {hint}",
    usageSummary: "",
    skillDescription: "",
    skillPointer: "",
    usageText: "",
  };
  const deps: PrefixDeps = {
    messages: (): Messages => messages,
    rewriteCache: createRewriteCache(16),
    rewrittenCalls: createRewrittenCalls(16),
    insights: overrides.insights ?? {
      recordPrefix: (input: PrefixRecord) => {
        prefixRecords.push(input);
      },
    },
  };
  const pluginOptions = {
    enabled: (): boolean => true,
    forms: (): readonly string[] => ["prefix"],
    log: overrides.log,
    warn: overrides.warn,
    supported: (): boolean => true,
    denyCommands: (): readonly string[] => [],
    vitestMaxMajor: 5,
    rewriteTimeoutMs: 5000,
    warnHint: (): boolean => true,
    rewriteHostEnv: (): string => "",
    ledgerPaths: { historyDb: "", recallDb: "" },
    ...overrides.options,
  } as unknown as PrefixOptions;
  const getTool = (name: string, scope?: unknown): unknown =>
    (rig.inner.tools.get as unknown as (toolName: string, toolScope?: unknown) => unknown)(
      name,
      scope,
    );
  const toolsGet = (name: string, scope?: unknown): unknown => {
    if (name !== "bash") {
      return getTool(name, scope);
    }
    // 「这个 profile 没有 bash」的两种形状（显式 null、只在 agent 作用域注册）都靠查一个
    // 不存在的名字表达：返回字面量 undefined 会让 consistent-return 把整条函数读成无返回值。
    if (overrides.bash === null || (overrides.bashNeedsScope === true && scope === undefined)) {
      return getTool("__rtk:no-bash", scope);
    }
    return overrides.bash ?? getTool(name, scope);
  };
  const baseline = toolsGet("bash");
  const registrations: { readonly agentId: string; readonly definition: ShadedTool }[] = [];
  const listenerNames: string[] = [];
  let agentCreated: ((payload: { agent: unknown }) => void) | undefined;
  const facadeOf = (child: CordisContext): PrefixContext =>
    ({
      tools: { get: toolsGet },
      subprocess,
      workingDirectory: {
        ensure,
        get: (): string => process.cwd(),
        change: (): Promise<string> => Promise.resolve(process.cwd()),
      },
      get: (name: string): unknown => rig.root.get(name),
      on: (name: string, listener: never): void => {
        listenerNames.push(name);
        if (name === AGENT_CREATED) {
          agentCreated = listener as (payload: { agent: unknown }) => void;
        }
        child.on(name as never, listener);
      },
      effect: ((execute: () => unknown, label?: string) =>
        child.effect(execute as never, label)) as never,
      fiber: child.fiber,
      logger: undefined,
    }) as unknown as PrefixContext;
  const prefixFiber = rig.inner.plugin(
    Object.assign(
      (child: CordisContext) => {
        installPrefixShadow(facadeOf(child), pluginOptions, deps);
      },
      { inject: ["tools", "subprocess", "workingDirectory", "shellEnv"] },
    ) as never,
    {} as never,
  ) as unknown as { dispose: () => Promise<void> } & PromiseLike<unknown>;
  // 等装载完成：插件体（installPrefixShadow）是在 inject 满足之后才跑的，不等就会读到
  // 一个还没挂好监听器的 ctx，「装没装」这类判据也就变成时序问题。
  await prefixFiber;
  // 装配期补装（`readLiveAgents` 那一路）不经过 `withAgent`，所以这里按「agent 视图里的 bash
  // 已经不是装配前那份」反推一份注册账：真 registry 不会告诉我们谁被注册了。
  for (const listed of liveAgents) {
    if (isRecord(listed) && typeof listed["id"] === "string") {
      const { id } = listed;
      const tool = toolsGet("bash", listed);
      if (
        tool !== undefined &&
        tool !== baseline &&
        !registrations.some((entry) => entry.agentId === id)
      ) {
        registrations.push({ agentId: id, definition: tool as unknown as ShadedTool });
      }
    }
  }
  const executeBatch = async (
    input: unknown,
  ): Promise<{
    readonly results: readonly {
      readonly result: { readonly isError: boolean; readonly value?: unknown };
    }[];
  }> =>
    (
      rig.inner.tools.execute as unknown as (input: unknown) => Promise<{
        readonly results: readonly {
          readonly result: { readonly isError: boolean; readonly value?: unknown };
        }[];
      }>
    )(input);
  const runThroughPipeline = async (
    agent: Record<string, unknown>,
    args: unknown,
    exec: unknown,
  ): Promise<unknown> => {
    const extra = isRecord(exec) ? exec : {};
    const callId = typeof extra["callId"] === "string" ? extra["callId"] : "call-x";
    const name = typeof extra["name"] === "string" ? extra["name"] : "bash";
    const signal =
      extra["signal"] instanceof AbortSignal ? extra["signal"] : new AbortController().signal;
    const incoming = isRecord(exec) && isRecord(exec["agent"]) ? exec["agent"] : undefined;
    const batch = await withSessionCwd(agent, sessionCwdOf(incoming), async () =>
      executeBatch({
        calls: [
          { type: "tool-call", id: callId, name, arguments: JSON.stringify(prepareArgs(args)) },
        ],
        signal,
        agent,
      }),
    );
    const [first] = batch.results;
    if (first === undefined) {
      throw new Error("真流水线没有交回结果");
    }
    return first.result.isError ? first.result : first.result.value;
  };
  const withAgent = (id = "s1"): ShadedTool => {
    const agent = agentsById.get(id) ?? makeAgent(id);
    const scope = scopesById.get(id);
    const before = toolsGet("bash", agent);
    if (scope === undefined) {
      throw new Error("真装配没有为 agent 留下作用域");
    }
    (scope.ctx.emit as unknown as (name: string, payload: unknown) => void)(AGENT_CREATED, {
      agent,
    });
    let resolved = toolsGet("bash", agent);
    if (resolved === before && before === baseline) {
      // cordis 的事件本轮已进 waterfall 链，但监听器可能因为门禁没注册；直调那份补一刀，
      // 这样「该装却没装」只会表现为「没有工具体」，不会静默变成「原生 bash 也能跑」。
      agentCreated?.({ agent });
      resolved = toolsGet("bash", agent);
    }
    // 判据是「这一格看到的已经不是装配前那份原生 bash」。让路那条用例把遮蔽体本身当
    // `baseline` 传进来，于是这里仍判成「没注册」——与插件自己的让路分支同一口径。
    if (resolved === undefined || resolved === baseline) {
      throw new Error("遮蔽层没有注册任何工具体");
    }
    const tool = resolved as ShadedTool & Record<string, unknown>;
    if (!registrations.some((entry) => entry.agentId === id)) {
      registrations.push({ agentId: id, definition: tool });
    }
    // 返回一份**字段齐全**的视图（name/description/parameters/output 逐字段来自宿主注册的那份）：
    // 用例要拿它验「继承而不是手抄」，而执行仍走真流水线。
    return {
      ...tool,
      execute: (args: unknown, exec: unknown): Promise<unknown> =>
        runThroughPipeline(agent, args, exec),
    };
  };
  let disposed = false;
  const disposeFiber = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    await prefixFiber.dispose();
    await Promise.all(
      scopes.map(async (scope) => {
        await scope.rawDispose();
      }),
    );
    await rig.root.fiber.dispose();
  };
  return {
    fake: { definition: baseline as Record<string, unknown>, received: rig.shell.received },
    installed: listenerNames.includes(AGENT_CREATED),
    deps,
    subprocess,
    registrations,
    withAgent,
    prefixRecords,
    disposeFiber,
    visibleShadows: (): readonly ShadedTool[] => registrations.map((entry) => entry.definition),
  };
}

/** 假 spill 存储：记下写进来的原文，回一句固定取回提示（形状与已发布的 dsh-spill-local 同）。 */
export interface SpillStoreStub {
  readonly saved?: readonly string[];
  saveText: (input: unknown) => Promise<{
    readonly locator: string;
    readonly bytes: number;
    readonly retrievalHint: string;
  }>;
}

/** 造一份 spill 存储替身：记下原文，回固定取回句（locator/bytes/retrievalHint 三件与官方同形）。 */
export function spillStub(): SpillStoreStub {
  const saved: string[] = [];
  return {
    saved,
    saveText: (input: unknown) => {
      const { content } = input as { content?: unknown };
      const text = typeof content === "string" ? content : "";
      saved.push(text);
      return Promise.resolve({
        locator: `/tmp/dsh-spill/stub/result-${String(saved.length)}.txt`,
        bytes: Buffer.byteLength(text, "utf8"),
        retrievalHint: "Use read with offset/limit, or grep this path to search within it.",
      });
    },
  };
}

/** startPipeHost 的开关。pipe 是假 rtk pipe 的回执；其余几项分别关掉/打开某一条判据。 */
export interface PipeHostOptions {
  readonly warns?: string[];
  readonly infos?: string[];
  readonly pipe?: { readonly exitCode: number; readonly stdout: string };
  /** 覆盖 pipe/hook 的子进程面：传 `realSubprocess()` 就让真 `rtk` 去跑（真实 CLI 回路靠这一位）。 */
  readonly subprocess?: SubprocessFace;
  readonly forms?: () => readonly string[];
  readonly enabled?: () => boolean;
  readonly supported?: () => boolean | undefined;
  readonly throwInListener?: boolean;
  readonly filters?: readonly string[];
  readonly minBytes?: () => number;
  readonly minGainRatio?: () => number;
  readonly stdoutCapBytes?: () => number;
  /** pipe/hook 子进程的期限。缺省 300ms：假回执的测试用它保持秒级；真 rtk 回路必须放宽。 */
  readonly pipeTimeoutMs?: number;
  readonly windowHeadLines?: () => number;
  readonly windowTailLines?: () => number;
  readonly hook?: () => HookEnv | undefined;
  readonly hookReply?: string;
  readonly filtersOf?: () => readonly string[];
  readonly spillStore?: SpillStoreStub;
  /** 传这个目录就让官方 LocalSpillStore 真落盘（不传则 spill 面缺席）。 */
  readonly spillRoot?: string;
  readonly log?: (line: string) => void;
  readonly messages?: () => Messages;
  readonly insights?: PipeDeps["insights"];
}

/** 单次调用的形状开关：模拟「结果不是本插件产出的」那几种情况。 */
export interface PipeRunOverrides {
  readonly isError?: boolean;
  readonly name?: string;
  readonly args?: unknown;
  readonly callId?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly truncated?: boolean;
  readonly spillPath?: string;
  readonly agent?: unknown;
  readonly next?: () => unknown;
  readonly bareString?: boolean;
}

export interface PipeHost {
  run: (
    value: unknown,
    over?: PipeRunOverrides,
  ) => Promise<{
    readonly decision: unknown;
    readonly stdin: string;
    readonly piped: number;
    readonly cwd: string;
  }>;
  readonly rewrittenCalls: RewrittenCalls;
  readonly pipeRecords: readonly PipeRecord[];
  hookCalls: () => number;
  hookStdin: () => string;
  hookEnv: () => Record<string, string | undefined>;
  dispose: () => void;
}

/** B 形态的真装配：只挂流水线需要的三位，工具由夹具定义（它模拟的是「别的工具产出的结果」）。 */
interface PipeRig {
  readonly inner: CordisContext;
  execute: (input: unknown) => Promise<unknown>;
  dispose: () => Promise<void>;
}

async function mountPipeRig(
  subprocess: SubprocessFace,
  defineFixture: (name: string) => Record<string, unknown>,
): Promise<PipeRig> {
  const root = new CordisContext();
  await root.plugin(SystemPrompt);
  await root.plugin(ToolRuntime);
  await root.plugin({ inject: nativeExecutorInject, apply: applyNativeExecutor });
  root.provide("subprocess", subprocess);
  root.provide("workingDirectory", {
    ensure: async (): Promise<string> => process.cwd(),
    get: (): string => process.cwd(),
    change: async (): Promise<string> => process.cwd(),
  });
  const innerRef: { current?: CordisContext | undefined } = {};
  await root.plugin(
    Object.assign(
      (ctx: CordisContext, _config: unknown) => {
        innerRef.current = ctx;
      },
      { inject: ["tools", "subprocess", "workingDirectory"] },
    ) as never,
    {} as never,
  );
  const inner = innerRef.current;
  if (inner === undefined) {
    throw new Error("真装配没有造出带 inject 的子上下文");
  }
  for (const name of ["bash", "read"]) {
    inner.tools.register(defineFixture(name) as never);
  }
  const { tools } = inner;
  const execute = async (input: unknown): Promise<unknown> =>
    (tools.execute as unknown as (input: unknown) => Promise<unknown>)(input);
  return {
    inner,
    execute,
    dispose: async (): Promise<void> => {
      await root.fiber.dispose();
    },
  };
}

/** 真流水线下的 B 形态台架：工具走官方执行链，post-execute 由真 waterfall 派发。 */
export function startPipeHost(options: PipeHostOptions = {}): PipeHost {
  const pipe = options.pipe ?? { exitCode: 0, stdout: "" };
  let stdin = "";
  let piped = 0;
  let spawnCwd = "";
  let hookStdout = "";
  let hookCalls = 0;
  let hookEnv: Record<string, string | undefined> = {};
  /** 记账盒：包在任何子进程面外面，把「谁被调了几次、喂了什么」这两件事全记下来。 */
  const observed = (inner2: SubprocessFace): SubprocessFace => ({
    spawn(spec): never {
      const isHook = spec.argv[1] === "hook";
      if (isHook) {
        hookCalls += 1;
        hookEnv = spec.env ?? {};
      } else {
        piped += 1;
        spawnCwd = spec.cwd;
      }
      const stream = spec.stdio.stdin;
      const written = typeof stream === "object" && "data" in stream ? stream.data : "";
      if (isHook) {
        hookStdout = written;
      } else {
        stdin = written;
      }
      return inner2.spawn(spec) as never;
    },
  });
  /** 假 rtk：按 `pipe` / `hookReply` 回执，不真起进程。 */
  const scriptedSubprocess: SubprocessFace = {
    spawn(spec): never {
      const isHook = spec.argv[1] === "hook";
      const { promise, resolve } = Promise.withResolvers<{
        readonly exitCode: number | null;
        readonly signal: string | null;
      }>();
      resolve({ exitCode: isHook ? 0 : pipe.exitCode, signal: null });
      const text = isHook ? (options.hookReply ?? "") : pipe.stdout;
      return {
        done: promise,
        collected: { stdout: { readFrom: (): { text: string } => ({ text }) } },
        terminate: (): void => {
          // 假 pipe 不真的起进程。
        },
      } as never;
    },
  };
  const subprocess = observed(options.subprocess ?? scriptedSubprocess);
  const rewrittenCalls = createRewrittenCalls(16);
  const pipeRecords: PipeRecord[] = [];
  const pipeInsights: PipeDeps["insights"] = options.insights ?? {
    recordPipe: (input: PipeRecord) => {
      pipeRecords.push(input);
    },
  };
  const defaultMessages: Messages = {
    cargoTestWarnHint: "",
    spillSummary: "压缩前的完整输出已另存为文件",
    spillLocation: "压缩前的完整输出已存为 {path}。{hint}",
    spillRelaxed: "这一段删掉了 {omitted}；完整原文在 {path}。{hint}",
    spillCapped:
      "[rtk] 正文超过 {cap} 字节、已省掉 {omitted}（只留尾部）；完整原文在 {path}。{hint}",
    usageSummary: "",
    skillDescription: "",
    skillPointer: "",
    usageText: "",
  };
  const deps: PipeDeps = {
    messages: options.messages ?? ((): Messages => defaultMessages),
    rewrittenCalls,
    tokensOf: (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4),
    fs: { readFile: (target: string) => readFile(target, "utf8") },
    log: {
      info: (...line: unknown[]): void => {
        options.infos?.push(line.map(String).join(" "));
      },
      warn: (...line: unknown[]): void => {
        options.warns?.push(line.map(String).join(" "));
      },
    },
    insights: pipeInsights,
  };
  // 真工具脚本：每次调用按 run 刚设的那一格交回 value；失败支靠 throw 造出 isError 结果。
  const script: { value: unknown; fail: boolean } = { value: undefined, fail: false };
  const defineFixture = (name: string): Record<string, unknown> => ({
    name,
    description: `fixture ${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    output: {
      schema: {},
      render: (): { readonly type: "text"; readonly text: string }[] => [
        { type: "text", text: "fixture" },
      ],
    },
    execute: async (): Promise<unknown> => {
      if (script.fail) {
        throw new Error("fixture-result-error");
      }
      return script.value;
    },
  });
  let captured: unknown;
  let capturedCallId = "";
  let downstreamNext: (() => unknown) | undefined;
  let executeTool: ((input: unknown) => Promise<unknown>) | undefined;
  let disposeRig: (() => Promise<void>) | undefined;
  const ready = (async (): Promise<void> => {
    const rig = await mountPipeRig(subprocess, defineFixture);
    executeTool = (input: unknown): Promise<unknown> => rig.execute(input);
    disposeRig = (): Promise<void> => rig.dispose();
    // 观察者必须在插件之前注册：waterfall 先注册者在外层，才能看到插件最终交回的那一份。
    rig.inner.on("tools/post-execute", (async (
      exec: unknown,
      _result: unknown,
      next: () => Promise<unknown>,
    ): Promise<unknown> => {
      // oxlint-disable-next-line node/callback-return -- async 监听器必须把 next() 的决定原样交回
      const decision = await next();
      if (isRecord(exec) && exec["callId"] === capturedCallId) {
        captured = decision;
      }
      return decision;
    }) as never);
    const spillStore =
      options.spillStore ??
      (options.spillRoot === undefined
        ? undefined
        : new LocalSpillStore(rig.inner, { root: options.spillRoot }));
    installPostExecuteListener(
      {
        tools: { get: (): undefined => undefined },
        subprocess,
        workingDirectory: { ensure: (): Promise<string> => Promise.resolve(process.cwd()) },
        get: (name: string): unknown => (name === "spillStore" ? spillStore : undefined),
        on: (name: never, listener: never): void => {
          rig.inner.on(name, listener);
        },
      } as unknown as HostContext,
      {
        enabled: options.enabled ?? ((): boolean => true),
        forms: options.forms ?? (() => ["pipe"]),
        log: options.log,
        supported: options.supported ?? ((): boolean | undefined => true),
        enabledFilters: () => options.filtersOf?.() ?? options.filters ?? ["cargo-test", "pytest"],
        minBytes: () => options.minBytes?.() ?? 16,
        minGainRatio: () => options.minGainRatio?.() ?? 0.95,
        stdoutCapBytes: (): number => {
          if (options.throwInListener === true) {
            throw new Error("stub-listener-boom");
          }
          return options.stdoutCapBytes?.() ?? 64_000;
        },
        windowHeadLines: () => options.windowHeadLines?.() ?? 50,
        windowTailLines: () => options.windowTailLines?.() ?? 200,
        pipeTimeoutMs: options.pipeTimeoutMs ?? 300,
        hook: () => options.hook?.(),
      },
      deps,
    );
    rig.inner.on("tools/post-execute", (async (
      _exec: unknown,
      _result: unknown,
      next: () => Promise<unknown>,
    ): Promise<unknown> => {
      if (downstreamNext === undefined) {
        return next();
      }
      return downstreamNext();
    }) as never);
  })();
  const run = async (
    value: unknown,
    over: PipeRunOverrides = {},
  ): Promise<{
    readonly decision: unknown;
    readonly stdin: string;
    readonly piped: number;
    readonly cwd: string;
  }> => {
    await ready;
    if (executeTool === undefined) {
      throw new Error("真流水线未装配完成");
    }
    const bare = over.bareString === true && typeof value === "string";
    const base = bare ? {} : asReceipt(value);
    const original = isRecord(base["stdout"]) ? base["stdout"] : {};
    const stdout: Record<string, unknown> = { ...original };
    if (over.truncated !== undefined) {
      stdout["truncated"] = over.truncated;
    }
    if (over.spillPath !== undefined) {
      stdout["spillPath"] = over.spillPath;
    }
    script.value = bare ? value : { ...base, stdout };
    script.fail = over.isError === true;
    const agent: Record<string, unknown> | undefined =
      over.agent === null
        ? undefined
        : ((over.agent as Record<string, unknown> | undefined) ?? { id: "s1" });
    // `over.cwd` 造的是「会话头里有 cwd」这一态：没有 agent 身份时交出去的也只是一份
    // 带 `session.header.cwd` 的对象（不带 id），插件那两级兜底才会退到第二级——真宿主里
    // 也会有这种只有会话头的 exec（例如派发方自己没把 agent 挂上来）。
    const execAgent: Record<string, unknown> | undefined =
      over.cwd === undefined ? agent : { ...agent, session: { header: { cwd: over.cwd } } };
    captured = undefined;
    capturedCallId = over.callId ?? "call-x";
    downstreamNext = over.next;
    const args = over.args === null ? {} : (over.args ?? { command: over.command ?? "cargo test" });
    await executeTool({
      calls: [
        {
          type: "tool-call",
          id: capturedCallId,
          name: over.name ?? "bash",
          arguments: JSON.stringify(args),
        },
      ],
      signal: new AbortController().signal,
      ...(execAgent === undefined ? {} : { agent: execAgent }),
    });
    return { decision: captured, stdin, piped, cwd: spawnCwd };
  };
  return {
    run,
    rewrittenCalls,
    pipeRecords,
    hookCalls: (): number => hookCalls,
    hookStdin: (): string => hookStdout,
    hookEnv: (): Record<string, string | undefined> => hookEnv,
    dispose: (): void => {
      void (async (): Promise<void> => {
        await ready;
        await disposeRig?.();
      })();
    },
  };
}
