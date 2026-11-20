/**
 * 起 `rtk` 子进程的两个入口：`pipe`（把已有输出喂给过滤器）与 `rewrite`（求命令改写）。
 *
 * 这一层只做三件事：按形态拼 argv 与 env、把 stdout 读回来、把失败折成「不可用」。
 * 退出码的语义在 `lib/rewrite.ts` 解释，压缩结果的取舍在 `lib/guard.ts`，
 * 所以这里既不看退出码的业务含义，也不判断压缩率。
 *
 * 子进程面用宿主 `ctx.subprocess` 的结构投影，而不是把 `SubprocessService` 整个搬进来：
 * 单测用桩、生产用真服务，两边都只要求 `spawn` 一个方法。
 */
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { withoutRtkDbEnv } from "./rtk-paths.ts";

/** 一次 spawn 之后本层真正会用的三样东西。 */
export interface SubprocessFaceHandle {
  /** collect 模式的读面；没请求 collect 时缺席（此时本层一律判失败）。 */
  readonly collected: {
    readonly stdout?:
      | { readonly readFrom: (fromByte: number) => { readonly text: string } }
      | undefined;
  };
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
  /** 幂等；管理器已退出时是 no-op。 */
  readonly terminate: () => void;
}

/** 子进程面的最小投影（宿主 `ctx.subprocess` 满足它）。 */
export interface SubprocessFace {
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessFaceHandle;
}

/**
 * pipe 的四枚行为开关：不写 recall 库、不留 tee 副本、不额外读用户 TOML、不发遥测。
 *
 * `RTK_NO_TOML=1` 只属于这一层：`rtk pipe -f <filter>` 的过滤器是硬编码的 native 函数，
 * 与 TOML 注册表无关，所以关掉它既不影响压缩、又少读一份用户配置。
 */
export const RTK_PIPE_ENV = {
  RTK_RECALL: "0",
  RTK_TEE: "0",
  RTK_NO_TOML: "1",
  RTK_TELEMETRY_DISABLED: "1",
} as const;

/**
 * rewrite 的三枚。**刻意没有 `RTK_NO_TOML`**：那条开关会让「只有 TOML filter 覆盖」的
 * 一整类命令失去改写（实测 15/44 条从 rc=3 掉到 rc=1：jq / just / task / turbo / nx /
 * mise / ssh / stat / gcc / oxlint / ty / jj / skopeo / jira / xcodebuild）。它当初进 pipe 层
 * 的动机（少读配置、少副作用）在 rewrite 层不成立——rewrite 本身不写任何库。
 */
export const RTK_REWRITE_ENV = {
  RTK_RECALL: "0",
  RTK_TEE: "0",
  RTK_TELEMETRY_DISABLED: "1",
} as const;

/** 读回来的上限：pipe 的输入本来就受 10MiB 门禁管着，压完不会更大。 */
/** pipe/rewrite 的 stdout 上限。spec §4.5 写的是 65536：装配期探测（`rtk --version`）与
 *  pipe 的输出都不该比这更大——超了就是「这句命令回了一堆不该模型读的东西」，宁可截断。 */
const MAX_STDOUT_BYTES = 65_536;
/** stderr 只在排障时看，给 64KiB 足够。 */
const MAX_STDERR_BYTES = 65_536;
/** rewrite 的宽限期不再写死：调用方把自己的预算一起交进来（见 `RtkRewriteExec.timeoutMs`）。
 * 早先这里是常量 1000，而期限（`AbortSignal.timeout(rewriteTimeoutMs)`，默认 2000）在
 * `host.ts` 一边 —— 两个数字各说一套，调大 `rewriteTimeoutMs` 只延长了「放弃等待」的
 * 时刻，进程管理器还按 1 秒的余量收尾。 */

/** 一次 pipe 的调用参数。 */
export interface RtkPipeOptions {
  readonly subprocess: SubprocessFace;
  readonly filter: string;
  readonly stdin: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** pipe 的结论：`ok` 为假时调用方必须原样使用未压缩的输出。 */
export interface RtkPipeResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/** 一次 rewrite 的调用参数。`env` 由装配层造（含可选的 `RTK_REWRITE_HOST`）。 */
export interface RtkRewriteExec {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** 调用方的预算（`rewriteTimeoutMs`）：既决定放弃等待，也作为进程管理器的宽限期。 */
  readonly timeoutMs: number;
  /**
   * 装配层造的 env。**值是 `string | undefined`**：`undefined` 在这里是 tombstone，
   * 用来抹掉父进程里已有的同名变量（见 `withoutRtkDbEnv`）。
   */
  readonly env: Record<string, string | undefined>;
  readonly subprocess?: SubprocessFace;
}

/** rewrite 的回执；`undefined` = 连进程都没跑起来。 */
export interface RtkRewriteResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

/** 读 collect 面的 stdout；缺席时给空串（调用方按失败处理）。 */
function readStdout(handle: SubprocessFaceHandle): string {
  const reader = handle.collected.stdout;
  return reader === undefined ? "" : reader.readFrom(0).text;
}

/**
 * 把已有输出喂给 `rtk pipe -f <filter>`。
 *
 * 超时不抛：abort 之后 `done` 照常 resolve，只是 signal 非空、exitCode 为 null。
 * 三种失败（信号/非零退出/spawn 抛错）都折成 `{ok:false}`——压缩是纯优化，失败必须 fail-open。
 */
export async function runRtkPipe(options: RtkPipeOptions): Promise<RtkPipeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  let result: RtkPipeResult = { ok: false, stdout: "" };
  let handle: SubprocessFaceHandle | undefined;
  try {
    handle = options.subprocess.spawn({
      argv: ["rtk", "pipe", "-f", options.filter],
      cwd: options.cwd,
      stdio: {
        stdin: { data: options.stdin },
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: MAX_STDERR_BYTES },
      },
      graceMs: options.timeoutMs,
      // 与 rewrite 那一路同一条口径（见 `withoutRtkDbEnv`）：`rtk pipe` 本身不记账，但父进程里
      // 若有人手动导出过 `RTK_DB_PATH`，那它就该像 rewrite 一样被抹掉——压缩行为不该取决于
      // 一个本插件解释不了的环境变量。
      env: withoutRtkDbEnv({ ...RTK_PIPE_ENV }),
      signal: controller.signal,
    });
    const outcome = await handle.done;
    if (outcome.signal === null && outcome.exitCode === 0) {
      result = { ok: true, stdout: readStdout(handle) };
    }
  } catch {
    // ENOENT / provider 失败：保持 ok=false，调用方原样使用未压缩输出。
  } finally {
    clearTimeout(timer);
    // terminate 幂等，进程已经退出时是 no-op。
    handle?.terminate();
  }
  return result;
}

/** 一次 `rtk hook` 的调用参数。 */
export interface RtkHookOptions {
  readonly subprocess: SubprocessFace;
  /** `lib/rtk-hook.ts` 的 `buildHookPayload` 产物（PostToolUse JSON）。 */
  readonly stdin: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** 三处隔离位置；`configDir` 由 `prepareHookConfig` 建好并写过配置。 */
  readonly env: Record<string, string | undefined>;
}

/**
 * 跑一次 `rtk hook claude`，把输出卫生交给 rtk 的 pipeline 引擎。
 *
 * 三种失败都折成 `{ok:false}`：`never_worse` 判无收益（stdout 零字节）、非零退出、
 * spawn 抛错。**空 stdout 也判失败**——那是 rtk 的正常答复（没东西可改），不是「压成了空」，
 * 调用方必须原样使用未压缩输出；把空串当成功会把整段输出从模型眼前抹掉。
 *
 * env 由调用方造（`hookEnvOf`）：这条路径要 `RTK_CONFIG_DIR`、单独的 `RTK_DB_PATH`，
 * 以及一个**单独的家目录**（见 `lib/rtk-paths.ts` 的 `HookPaths.home`）。
 */
export async function runRtkHook(options: RtkHookOptions): Promise<RtkPipeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  let result: RtkPipeResult = { ok: false, stdout: "" };
  let handle: SubprocessFaceHandle | undefined;
  try {
    handle = options.subprocess.spawn({
      argv: ["rtk", "hook", "claude"],
      cwd: options.cwd,
      stdio: {
        stdin: { data: options.stdin },
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: MAX_STDERR_BYTES },
      },
      graceMs: options.timeoutMs,
      env: options.env,
      signal: controller.signal,
    });
    const outcome = await handle.done;
    if (outcome.signal === null && outcome.exitCode === 0) {
      const stdout = readStdout(handle);
      // 空串是「没东西可改」，不是「压成了空」——见函数头注释。
      if (stdout.trim() !== "") {
        result = { ok: true, stdout };
      }
    }
  } catch {
    // ENOENT / provider 失败：保持 ok=false，调用方回落到本地窗口。
  } finally {
    clearTimeout(timer);
    handle?.terminate();
  }
  return result;
}

/** 一次 `rtk pipeline validate` 的调用参数。 */
export interface RtkValidateOptions {
  readonly subprocess: SubprocessFace;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** `hookEnvOf` 造的那份环境：校验必须读同一份 `pipeline.toml`。 */
  readonly env: Record<string, string | undefined>;
}

/** 校验结论：`diagnostics` 只在失败时非空（rtk 把 E000/W025 之类的行写在 stdout）。 */
export interface RtkValidateResult {
  readonly ok: boolean;
  readonly diagnostics: string;
}

/**
 * 跑一次 `rtk pipeline validate`，确认刚写出的 `pipeline.toml` 能被 rtk 装载。
 *
 * 为什么需要这一步：rtk 的 pipeline 装载是**静默降级**的——文件有解析错误时它只记进
 * `pipeline-status.json` 并回落到 `rtk:default`，`rtk hook` 的退出码仍是 0。插件若只看 hook
 * 的输出，看到的只是「没收益」，与「清理链根本没生效」同形。这里把装载结论在装配期就问一次，
 * 失败时由调用方留一行 warn。
 *
 * 判据只看退出码：rtk 的诊断（`E000 not valid TOML` / `W025 … has errors and is not loaded`）
 * 写在 stdout 而不是 stderr（实测），所以退出码非零时把 stdout 原样带回去。spawn 抛错与超时
 * 都折成失败，但诊断串为空——那种情况下连「文件有没有被读」都无从判断，不该伪造成 TOML 错误。
 */
export async function runRtkPipelineValidate(
  options: RtkValidateOptions,
): Promise<RtkValidateResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  let result: RtkValidateResult = { ok: false, diagnostics: "" };
  let handle: SubprocessFaceHandle | undefined;
  try {
    handle = options.subprocess.spawn({
      argv: ["rtk", "pipeline", "validate"],
      cwd: options.cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: MAX_STDERR_BYTES },
      },
      graceMs: options.timeoutMs,
      env: options.env,
      signal: controller.signal,
    });
    const outcome = await handle.done;
    const stdout = readStdout(handle).trim();
    result =
      outcome.signal === null && outcome.exitCode === 0
        ? { ok: true, diagnostics: "" }
        : { ok: false, diagnostics: stdout };
  } catch {
    // ENOENT / provider 失败：保持失败但无诊断；调用方只报「问不到」，不编造 TOML 错误。
  } finally {
    clearTimeout(timer);
    handle?.terminate();
  }
  return result;
}

/**
 * `rtk rewrite <command>`：求一条命令的等价改写。
 * 这一层不判退出码含义，只做两件归一：被信号杀掉时 exitCode 归 null；stdout 一律 trimEnd
 * （实测 rc=3 的改写无尾换行、rc=0 分支曾带换行，统一之后空串才可靠地等于「没有改写」）。
 * 期限归调用方：装配层用 `AbortSignal.any([exec.signal, AbortSignal.timeout(ms)])`。
 */
export async function runRtkRewrite(exec: RtkRewriteExec): Promise<RtkRewriteResult | undefined> {
  const { subprocess } = exec;
  let result: RtkRewriteResult | undefined;
  if (subprocess !== undefined && !exec.signal.aborted) {
    let handle: SubprocessFaceHandle | undefined;
    try {
      handle = subprocess.spawn({
        argv: ["rtk", "rewrite", exec.command],
        cwd: exec.cwd,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: MAX_STDOUT_BYTES },
          stderr: { maxBytes: MAX_STDERR_BYTES },
        },
        graceMs: exec.timeoutMs,
        env: withoutRtkDbEnv(exec.env),
        signal: exec.signal,
      });
      const outcome = await handle.done;
      const stdout = readStdout(handle).trimEnd();
      result =
        outcome.signal === null && outcome.exitCode !== null
          ? { exitCode: outcome.exitCode, stdout }
          : { exitCode: null, stdout: "" };
    } catch {
      // spawn 失败（ENOENT 等）：上层按原样执行，所以这里什么都不给。
    } finally {
      handle?.terminate();
    }
  }
  return result;
}
