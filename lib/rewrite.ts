/**
 * `rtk rewrite` 的结论、退出码协议与编排。
 *
 * 退出码是这一层唯一的真相（`src/hooks/rewrite_cmd.rs`）：
 *   0 / 3 → 有等价改写，stdout 就是改写后的命令
 *   1     → 没有等价改写（或用户配置里禁用了该规则）
 *   2     → 被 `~/.claude` / 项目 `.claude` 的 permission deny 规则拒绝
 * 其余（含没有退出码的超时）一律原样执行——改写是纯优化，任何异常都不该改变命令的行为。
 *
 * 本模块不 spawn、不读盘：`runRewrite` 由装配层注入（Task 12 的 cli.ts 用 `ctx.subprocess` 起
 * 真正的 `rtk rewrite`）。这样协议与缓存可以在单测里全量走遍，不必依赖本机装没装 rtk。
 */
import type { RewriteCache } from "./rewrite-cache.ts";

/** 一次改写的结论。`rewritten` 才允许换命令；`original` 一律原样执行，`reason` 只进日志/统计。 */
export type RewriteAttempt =
  | { readonly kind: "rewritten"; readonly command: string }
  | { readonly kind: "original"; readonly reason: string };

/** `rtk rewrite` 进程回执里本层要的两样东西。 */
export interface RewriteRunResult {
  /** 进程退出码；`null` = 超时/被信号杀掉（宿主 subprocess 的约定）。 */
  readonly exitCode: number | null;
  readonly stdout: string;
}

/** 编排所需的三件外部能力。 */
export interface RewriterDeps {
  /** 当前工作目录——它必须进缓存 key，理由见 `cacheKey`。 */
  readonly cwd: string;
  /** 真起一次 `rtk rewrite`；spawn 失败返回 undefined 或直接抛，两种都当作瞬时失败。 */
  readonly runRewrite: (
    command: string,
    signal: AbortSignal,
  ) => Promise<RewriteRunResult | undefined>;
  readonly cache: Pick<RewriteCache, "get" | "set">;
}

/** 有改写/无改写的退出码。只有这两个码的 stdout 才可能承载改写后的命令。 */
const REWRITE_EXIT_CODES: ReadonlySet<number> = new Set([0, 3]);

/**
 * 瞬时失败：环境抖动，不该把结论钉死在缓存里。
 *
 * 一次超时或 spawn 失败之后该命令在整个会话里都拿不到改写，是比「多 spawn 一次」更坏的取舍，
 * 所以这两条结论不写缓存，下次重试。`denied` / `no-rewrite` / `exit-N` 都是**确定性**结论
 * （同一目录、同一命令会得到同一答案），照常缓存。
 */
const SPAWN_FAILED = "spawn-failed";

const TRANSIENT_REASONS: ReadonlySet<string> = new Set(["timeout", SPAWN_FAILED]);

/**
 * 缓存 key = cwd + 命令。
 *
 * cwd 不可省：`rtk rewrite` 先过 `permissions::check_command`，它会从 cwd 向上找 `.claude` 目录、
 * 读其中的 `settings.json`。实测同一条 `cargo test`：被 deny 的仓里 rc=2，另一个仓里 rc=3。
 * 退出码是 cwd 的函数，只用命令做 key 会让两个仓互相污染。
 * 用 NUL 分隔：路径里可以有冒号（Windows 盘符、POSIX 文件名），NUL 不可能出现在两者中。
 */
function cacheKey(cwd: string, command: string): string {
  return `${cwd}\u0000${command}`;
}

/** 只由退出码决定的结论；`undefined` 表示「要看 stdout 才知道」。 */
function reasonFor(exitCode: number | null): string | undefined {
  let reason: string | undefined;
  if (exitCode === null) {
    reason = "timeout";
  } else if (exitCode === 1) {
    reason = "no-rewrite";
  } else if (exitCode === 2) {
    reason = "denied";
  } else if (!REWRITE_EXIT_CODES.has(exitCode)) {
    reason = `exit-${String(exitCode)}`;
  }
  return reason;
}

/** 把一次进程回执翻成结论。单出口：每个分支只赋值，末尾统一返回。 */
function interpret(result: RewriteRunResult | undefined): RewriteAttempt {
  let attempt: RewriteAttempt = { kind: "original", reason: SPAWN_FAILED };
  if (result !== undefined) {
    const command = result.stdout.trimEnd();
    const fixed = reasonFor(result.exitCode);
    if (fixed !== undefined) {
      attempt = { kind: "original", reason: fixed };
    } else if (command === "") {
      // rc=0/3 但 stdout 是空的：协议被违反。空串绝不是改写结果——拿它去执行等于什么都不跑。
      attempt = { kind: "original", reason: "empty-stdout" };
    } else {
      attempt = { kind: "rewritten", command };
    }
  }
  return attempt;
}

/**
 * 造一个带缓存的改写器。返回的函数对同一条命令只 spawn 一次（除非上次是瞬时失败）。
 *
 * 缓存命中不消耗 signal：命中即返回，不等任何 I/O。
 */
export function createRewriter(
  deps: RewriterDeps,
): (command: string, signal: AbortSignal) => Promise<RewriteAttempt> {
  return async (command, signal) => {
    const key = cacheKey(deps.cwd, command);
    const cached = deps.cache.get(key);
    let attempt: RewriteAttempt;
    if (cached === undefined) {
      let fresh: RewriteAttempt;
      try {
        fresh = interpret(await deps.runRewrite(command, signal));
      } catch {
        fresh = { kind: "original", reason: SPAWN_FAILED };
      }
      const transient = fresh.kind === "original" && TRANSIENT_REASONS.has(fresh.reason);
      if (!transient) {
        deps.cache.set(key, fresh);
      }
      attempt = fresh;
    } else {
      attempt = cached;
    }
    return attempt;
  };
}
