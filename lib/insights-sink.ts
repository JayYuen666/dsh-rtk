/**
 * 统计埋点的闸门：把「热路径上的 record」与「可能还不知道能不能用的 SQLite」隔开。
 *
 * 三件事必须同时成立，而它们各自都会失败：
 *
 * 1. **库可能打不开**：`node:sqlite` 在旧 Node 上不存在（装配期 `import()` 才炸），路径可能只读，
 *    文件可能已损坏。打不开时统计不可用，而**压缩本身不能跟着失效**——所以这里不抛、只记一行
 *    warn，后续所有 record 静默丢弃（Insights 页会按 availability 如实说「不可用」）。
 * 2. **打开是异步的**：`open()` 要真的 `import("node:sqlite")` 并跑建表 SQL，而第一次 bash 调用
 *    可能已经发生。`load()` 完成之前的 record 一律丢——它们记的是「打开之前的窗口」，
 *    半份数据比空窗口更难解释（今日合计会偏小，而面板上说这是完整的）。
 * 3. **record 不能拖慢工具调用**：`record*` 只推内存缓冲（flush 由 store 自己按条数/定时触发），
 *    这里是同步直通、不做 I/O；再包一层 try/catch，让「统计写坏了」绝不冒到工具执行路径上。
 */
import type { InsightsStore } from "./insights-store.ts";
import { openInsightsStore } from "./insights-store.ts";
import type { LegacyAccumulator } from "./legacy-stats.ts";
import type { PipeRecord, PrefixRecord } from "./insights-shape.ts";

/** 两个 installer 共享的记账号。方法名与 `InsightsStore` 对齐，装配处直接转手，不用再包一层。 */
export interface InsightsSink {
  readonly recordPrefix: (input: PrefixRecord) => void;
  readonly recordPipe: (input: PipeRecord) => void;
  readonly recordPotential: (day: string, filter: string) => void;
}

/** 打开统计库的入参。 */
export interface DeferredInsightsOptions {
  readonly dbPath: string;
  /**
   * 旧累计账本。**惰性求值**：读它要走一次宿主的 storage domain，而那份服务在别处可能已经
   * 不在了；「读不到」与「没有旧账本」在这里归成同一个 `null`，迁移随之为空。
   */
  readonly legacy?: (() => Promise<LegacyAccumulator | null>) | undefined;
  /**
   * 挂 disposer 的入口（插件 fiber 的 `ctx.effect`）。
   *
   * 返回类型写成 `unknown` 而不是 `void`：宿主的契约是「返回 thenable 就等它」，
   * 而 `() => void` 会让 `() => store.close()` 撞 `typescript(strict-void-return)`
   * （把一个 `Promise<void>` 交进 void 位置），与实际契约正好相反。
   */
  readonly effect: (run: () => () => unknown, label: string) => void;
  /** 诊断日志口：打不开时留一行，别让「统计一直是空的」变成零线索。 */
  readonly warn: (line: string) => void;
  /** 测试注入口：默认真 `openInsightsStore`。 */
  readonly open?: typeof openInsightsStore | undefined;
}

/** 交给装配层的那一份：`sink` 给两个 installer，`store()` 给 service 的读面。 */
export interface DeferredInsights {
  readonly sink: InsightsSink;
  readonly load: () => Promise<void>;
  readonly store: () => InsightsStore | undefined;
}

/** 造一份「先是空转、`load()` 之后才真记账」的 sink。 */
export function createDeferredInsights(options: DeferredInsightsOptions): DeferredInsights {
  const open = options.open ?? openInsightsStore;
  let active: InsightsStore | undefined;
  let loading: Promise<boolean> | undefined;

  /** 一条 record 的落地：没有库就直接丢，有库就交出去，出什么事都只记日志。 */
  const send = (each: (store: InsightsStore) => void): void => {
    const store = active;
    if (store === undefined) {
      return;
    }
    try {
      each(store);
    } catch (error) {
      // 走到这里说明缓冲层自己抛了（正常路径不会：store 内部只做数组 push 与定时器）。
      // 不吞成静默：这种异常意味着统计面坏了，但工具调用不该受影响。
      options.warn(`[rtk] insights: record failed (${String(error)})`);
    }
  };

  const sink: InsightsSink = {
    recordPrefix: (input) => {
      send((store) => {
        store.recordPrefix(input);
      });
    },
    recordPipe: (input) => {
      send((store) => {
        store.recordPipe(input);
      });
    },
    recordPotential: (day, filter) => {
      send((store) => {
        store.recordPotential(day, filter);
      });
    },
  };

  const openOnce = async (): Promise<boolean> => {
    let legacy: LegacyAccumulator | null = null;
    if (options.legacy !== undefined) {
      try {
        legacy = await options.legacy();
      } catch (error) {
        // 旧账本读不出来不该拖垮新库：没有 legacy 段就没有 legacy 段，其余照常。
        options.warn(`[rtk] insights: cannot read the legacy accumulator (${String(error)})`);
      }
    }
    const store = await open({ dbPath: options.dbPath, legacy });
    if (store === undefined) {
      options.warn(
        "[rtk] insights: cannot open the stats tables in rtk's history.db (node:sqlite missing, path not writable, or file corrupt); the Insights page will report it as unavailable",
      );
      return false;
    }
    // 谁 open 谁 close：挂插件 fiber，卸载时按注册逆序跑。disposer 必须交回 promise——
    // 契约是「返回 thenable 就等它」，返回 undefined 等于宣告同步撤完了，而下一次装配会撞上
    // 上一个连接还没释放（`lib/stats-store.ts` 的同款注释记着那次真机现场）。
    options.effect(
      () => () => {
        // 撤的时候先把 `active` 清掉：否则撤完之后 `store()` 仍然给出一个正在关闭（或已关闭）
        // 的句柄，读面会在卸载之后继续拿到它，然后撞上 `database is not open`。
        active = undefined;
        return store.close();
      },
      "rtk: insights store",
    );
    active = store;
    return true;
  };

  /**
   * 开库。幂等：重复调用返回同一个 promise，不会开第二个连接。
   *
   * 第二个连接本身 SQLite 允许，但两个缓冲各自的 flush 会让「代际比较」变得难以解释
   * （哪一份先看到 `statsEpoch` 变了？），而这条语义是本仓重置逻辑的全部依据。
   */
  const load = async (): Promise<void> => {
    // **失败不留缓存**：一次打不开（宿主刚起、文件被占、node:sqlite 还没就绪）不该让整个
    // 会话都没有统计。清掉那趟 promise，下一次 load 重新试。
    loading ??= openOnce();
    const opened = await loading;
    if (!opened) {
      loading = undefined;
    }
  };

  return { sink, load, store: () => active };
}
