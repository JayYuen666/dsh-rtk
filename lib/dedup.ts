/**
 * 两形态去重：「本次调用已被 C 形态改写过」的一次性账本。
 *
 * 为什么必须去重：`tools/post-execute` 里 `exec.arguments.command` 是**模型原始参数**，
 * 不受遮蔽影响。C 形态把 `cargo test` 改写成 `rtk cargo test` 之后，B 监听器看到的命令
 * 仍然是 `cargo test`——两形态同开时同一条命令会被压两次。
 *
 * 为什么键是 `callId` 而不是命令串（三条理由）：
 *
 * 1. **相关性是确定的**：`tools/post-execute` 拿到的是同一个 `exec`（含 `callId`），
 *    「C 到底改没改这一条」在同一个 callId 上是一对一的事实，不是靠字符串比对猜的。
 *    命令串做键会在「同一条命令并发两条」时互相污染——大概率无害，但那是靠巧合正确。
 * 2. **淘汰与命中的竞态**：有界账本按插入顺序淘汰，若按命令串做键、容量 256，理论上可能
 *    出现「写进去 → 被淘汰 → post-execute 读不到 → 二次压缩」。callId 键 + 读后即删把
 *    条目寿命钉死在「一次调用」内：写于 execute 开头、读于同一次调用的 post-execute，
 *    中间不可能塞进 256 条别的调用。上限于是只是兜底，不是正确性依赖。
 * 3. **语义更清楚**：账本记的不是「哪些命令被改写过」（那是无界的知识），
 *    而是「本次调用是否已改写」（一次调用的事实）。
 *
 * 第四件事：账本记的是**改写后的命令**而不只是一个「已改写」的布尔量。因为有一种改写
 * 什么都不压——`rtk read`（`--level` 默认 `none`，逐字节透传）。那时让路等于把收益白丢，
 * 判据在 `isVerbatimRewrite`，量级见那里的注释。
 */

import { positiveInt } from "./positive-int.ts";

/** 「本次调用已被 C 形态改写过」的一次性账本，值 = 改写之后那条命令。 */
export interface RewrittenCalls {
  /**
   * 在 execute 决定改写**之后、转调 orig.execute 之前**记一笔。
   *
   * 第二参是**改写后的命令**而不是布尔量：结果侧要问的不是「改写过没有」，而是
   * 「改写出来的那条命令自己压不压」（见 `isVerbatimRewrite`）。
   */
  readonly mark: (callId: string, rewritten: string) => void;
  /** 读后即删：一次调用的账只可能被消费一次，第二次读到 undefined。 */
  readonly consume: (callId: string) => string | undefined;
}

/**
 * 有界只为兜底：callId 键 + 读后即删已经把条目寿命钉死在「一次调用」内
 * （写于 execute 开头、读于同一次调用的 post-execute），正常情况下永远塞不满。
 * 上限拦的是异常路径（execute 抛错、post-execute 没跑到）残留的条目，不是正确性依赖。
 */
export function createRewrittenCalls(limit: number): RewrittenCalls {
  const capacity = positiveInt(limit);
  const marked = new Map<string, string>();
  const mark = (callId: string, rewritten: string): void => {
    if (callId === "") {
      return;
    }
    // 重记同一条时挪到队尾，别占两格。
    marked.delete(callId);
    marked.set(callId, rewritten);
    // 超出容量的部分按插入顺序丢掉。写成「算出要丢几个」而不是「取队首再判空」：
    // 后者带一个 size>capacity 时永远走不到的分支，覆盖率门禁会把它算成未覆盖代码。
    const overflow = marked.size - capacity;
    const doomed = [...marked.keys()].slice(0, Math.max(0, overflow));
    for (const each of doomed) {
      marked.delete(each);
    }
  };
  const consume = (callId: string): string | undefined => {
    // 空 callId 从来没被记过，查表必然 undefined——不必单独早退，那样会让这个箭头函数
    // 同时有「早退不带值」与「末行带值」两条出口，撞 `typescript(consistent-return)`。
    const rewritten = marked.get(callId);
    marked.delete(callId);
    return rewritten;
  };
  return { mark, consume };
}

/** `rtk read` 是唯一「什么都不改」的改写目标：它默认逐字节透传。 */
const RTK_READ = /^rtk\s+read(?:\s|$)/u;
/**
 * 让 `rtk read` 真的动手的开关。任一出现就不再是透传，`rtk read` 会切窗或改档。
 *
 * 同义的短旗标一并算进来：判据是「有没有让 rtk 动手」，不是拼写。`-n` 不在其中
 * ——它只加行号，内容仍然是原文。
 */
const READ_SHAPING_FLAGS =
  /(?:^|\s)(?:-l|--level|-m|--max-lines|--head-lines|--tail-lines)(?:\s|=|$)/u;

/**
 * 这条改写结果是否**逐字节透传**（压不动）。
 *
 * 为什么需要它：`rtk rewrite` 把 `cat build.log` 改写成 `rtk read build.log`，而 `rtk read`
 * 的 `--level` 默认是 `none`——实测 22,390 B 的日志进去、22,390 B 出来（`--level minimal`
 * 同样 22,389 B），只有 `--head-lines 50` 才真的切到 1,190 B。所以「本次调用被改写过」在
 * `rtk read` 这一支上**不代表输出已经被压过**，恰恰相反：它一个字节都没动，而本包的窗口
 * 本来能把它砍掉。
 *
 * 反过来，别的改写目标都是真的在压（`rtk cargo test`、`rtk git status`、`rtk ls` …），
 * 那时让结果侧再压一遍才是重复劳动。
 *
 * 真实账本里的量级：`rtk_cmd = 'rtk read'` 全期 710 行 / 7,353,339 input token，其中
 * 日志扩展名命中的 431 行 / 6,672,440 token；1.2.0 之后（`timestamp >= '2026-11-08'`）
 * 仍有 73 行 / 1,855,886 token——这些正是被早退白白放掉的那批。
 */
export function isVerbatimRewrite(rewritten: string): boolean {
  const trimmed = rewritten.trim();
  return RTK_READ.test(trimmed) && !READ_SHAPING_FLAGS.test(trimmed);
}

/**
 * B 形态是否该放手（跳过压缩）。
 *
 * 必须先判「prefix 形态启用」：只开 pipe 时没有 C 在压，跳过就是白丢一档收益。
 * 判据是 callId + **改写后的命令**，不看模型原始命令串——见本文件头三条理由。
 *
 * 唯一不放手的一支是逐字节透传的改写（`isVerbatimRewrite`）：那里 rtk 一个字节都没压，
 * 放手等于白丢一次机会。注意账本**照样被消费**（读后即删），否则同一条调用会被反复问。
 */
export function shouldSkipPipe(
  exec: { readonly callId: string },
  enabledForms: readonly string[],
  rewrittenCalls: RewrittenCalls,
): boolean {
  if (!enabledForms.includes("prefix")) {
    return false;
  }
  const rewritten = rewrittenCalls.consume(exec.callId);
  if (rewritten === undefined) {
    return false;
  }
  return !isVerbatimRewrite(rewritten);
}
