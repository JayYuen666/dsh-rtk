import { positiveInt } from "./positive-int.ts";
import type { RewriteAttempt } from "./rewrite.ts";

/**
 * 命令 → 改写结论的内存 LRU。
 *
 * `size` 报的是**容量**（配置项 `rewriteCacheSize`），不是当前条数：设置卡要显示的是
 * 「这台机器最多记多少条」，把当前条数当容量显示会在冷启动时一律显示 0。条数要另开一个
 * 口径就有第二个真相，故不给。
 */
export interface RewriteCache {
  get: (key: string) => RewriteAttempt | undefined;
  set: (key: string, value: RewriteAttempt) => void;
  readonly size: number;
}

/** 建一个容量为 `size` 条的内存 LRU。 */
export function createRewriteCache(size: number): RewriteCache {
  const capacity = positiveInt(size);
  const entries = new Map<string, RewriteAttempt>();
  return {
    get size(): number {
      return capacity;
    },

    get(key: string): RewriteAttempt | undefined {
      const hit = entries.get(key);
      // Map 的迭代序就是插入序：删了再插即「移到队尾」，队首永远是最久未用。
      // 命中要刷新新鲜度，否则一条反复使用的命令会被新来的条目挤掉。
      if (hit !== undefined) {
        entries.delete(key);
        entries.set(key, hit);
      }
      return hit;
    },

    set(key: string, value: RewriteAttempt): void {
      // 先删再插：覆盖同一个 key 时既刷新新鲜度、又不涨条数。
      entries.delete(key);
      entries.set(key, value);
      if (entries.size <= capacity) {
        return;
      }
      // set 之后 size 恰为 capacity+1，所以溢出量恒为 1；写成「收集 overflow 条再删」是为了
      // 不碰 `entries.keys().next()` 的 IteratorResult 形状——那条 `.value` 带着一个永远走不到的
      // undefined 分支，会让覆盖率留下假洞。两条件（`>=` 的两侧）在这里都必然走到。
      const overflow = entries.size - capacity;
      const doomed: string[] = [];
      for (const candidate of entries.keys()) {
        if (doomed.length >= overflow) {
          break;
        }
        doomed.push(candidate);
      }
      for (const oldest of doomed) {
        entries.delete(oldest);
      }
    },
  };
}
