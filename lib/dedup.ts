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
 */

import { positiveInt } from "./positive-int.ts";

/** 「本次调用已被 C 形态改写过」的一次性账本。 */
export interface RewrittenCalls {
  /** 在 execute 决定改写**之后、转调 orig.execute 之前**记一笔。 */
  readonly mark: (callId: string) => void;
  /** 读后即删：一次调用的账只可能被消费一次，第二次读到 false。 */
  readonly consume: (callId: string) => boolean;
}

/**
 * 有界只为兜底：callId 键 + 读后即删已经把条目寿命钉死在「一次调用」内
 * （写于 execute 开头、读于同一次调用的 post-execute），正常情况下永远塞不满。
 * 上限拦的是异常路径（execute 抛错、post-execute 没跑到）残留的条目，不是正确性依赖。
 */
export function createRewrittenCalls(limit: number): RewrittenCalls {
  const capacity = positiveInt(limit);
  const marked = new Set<string>();
  const mark = (callId: string): void => {
    if (callId === "") {
      return;
    }
    // 重记同一条时挪到队尾，别占两格。
    marked.delete(callId);
    marked.add(callId);
    // 超出容量的部分按插入顺序丢掉。写成「算出要丢几个」而不是「取队首再判空」：
    // 后者带一个 size>capacity 时永远走不到的分支，覆盖率门禁会把它算成未覆盖代码。
    const overflow = marked.size - capacity;
    const doomed = [...marked].slice(0, Math.max(0, overflow));
    for (const each of doomed) {
      marked.delete(each);
    }
  };
  const consume = (callId: string): boolean => {
    if (callId === "") {
      return false;
    }
    return marked.delete(callId);
  };
  return { mark, consume };
}

/**
 * B 形态是否该放手（跳过压缩）。
 *
 * 必须先判「prefix 形态启用」：只开 pipe 时没有 C 在压，跳过就是白丢一档收益。
 * 判据只认 callId，不看命令串——见本文件头三条理由。
 */
export function shouldSkipPipe(
  exec: { readonly callId: string },
  enabledForms: readonly string[],
  rewrittenCalls: RewrittenCalls,
): boolean {
  if (!enabledForms.includes("prefix")) {
    return false;
  }
  return rewrittenCalls.consume(exec.callId);
}
