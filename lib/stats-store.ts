// 自记账的存储面：一份全局账本落在宿主的 storageDomain 上。
//
// 内存是权威、写入是异步的：`accumulate` 在 `tools/post-execute` 的热路径上，它同步返回，
// 落盘按序串成一条链。后端失败只丢持久化，不动内存——统计栏少一条历史，绝不该让工具调用抛错。
import type { Context } from "@deepseek-ai/cordis";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

import { EMPTY_ACCUMULATOR, statsAccumulatorSchema, summarize } from "./stats-shape.ts";
import type { StatsAccumulator, StatsSummary } from "./stats-shape.ts";

/** 表的键：本域只存一份全局账本，键是常量（`'summary'` 满足宿主的 `^[a-z][a-z0-9_]*$`）。 */
export const SUMMARY_KEY = "summary";

/**
 * 本插件的存储域声明。
 *
 * `invalidRecords: 'backup-and-skip'` 是刻意的：账本是**派生数据**（从压缩行为累加出来的），
 * 一条坏记录不该让整次 `open()` 拒绝——那会把设置卡整块打掉，而代价只是少一份历史计数。
 * 容忍路径需要后端支持 `backupRecord`；只支持单文档布局的后端拿不到这条宽限，仍按宿主的
 * 响亮失败走（这条边界不隐藏，写在这里）。
 */
export const rtkStatsDomain = defineDomain({
  // 域名的真源是 spec §6：`rtk_stats`。写成 `rtk` 会让落盘文件名 `storages/rtk.json` 与文档不符，
  // 而这一位是持久面的一部分（换名字等于换文件），所以它与测试里的期望值必须同源。
  name: "rtk_stats",
  // 2 起账本多了 token 两列（第 2 项 rc.2 能力：记账走宿主 `ctx.tokenMeter`）。
  version: 2,
  /**
   * 存量记录（版本 1）照常读，靠的是 `statsAccumulatorSchema` 把 token 两列声明成
   * `.default(0)`——**这两处必须一起改**：只升版本不给 `compatibleVersions` 会让旧账本
   * 在 `open()` 时被当成版本不符而整份丢弃；只给 `compatibleVersions` 而不给默认值，
   * 旧记录缺键会过不了 zod，`invalidRecords: 'backup-and-skip'` 会把它挪走，用户看到的是
   * 「统计归零」而不是报错。
   */
  compatibleVersions: [1],
  invalidRecords: "backup-and-skip",
  tables: { summary: domainTable<"summary", StatsAccumulator>(statsAccumulatorSchema) },
});

/**
 * 这份账本需要的**最小**存储面：一张表的 get/put。真身是 `domain.table('summary')`
 * （`KvTable<'summary', StatsAccumulator>` 结构上满足它），测试用同形替身，
 * 不必为了断言一行数字去起 storage hub + json 后端。
 */
export interface StatsTable {
  readonly get: (key: typeof SUMMARY_KEY) => StatsAccumulator | undefined;
  readonly put: (key: typeof SUMMARY_KEY, value: StatsAccumulator) => Promise<void>;
}

/**
 * 一次记账的输入，按形态分开：
 *
 * · `pipe` 知道前后字节与命中的 filter；
 * · `prefix` **只知道发生过一次改写**——命令在进 shell 之前就变成 `rtk <cmd>`，原始输出从未流经
 *   本插件，所以它记不到字节（spec §6：字节列只能是 `—`，省下的量看 `rtk gain`）。
 *
 * 做成 union 而不是「给 prefix 填 0 字节」：填 0 会让合计字节的分母不动而分子少一次，读数对不上；
 * 而 union 让「prefix 那支拿不到字节」在类型层就成立，调用点想错都错不了。
 */
export type AccumulateInput =
  | {
      readonly form: "pipe";
      readonly filter: string;
      readonly originalBytes: number;
      readonly compressedBytes: number;
      /**
       * 两侧的 token 估计。**必填而不是可选**：`pipe` 支的两个数由同一个定价函数一次算出，
       * 留成可选就等于允许「记了字节忘了 token」——那种账本照样能存，只有卡片上的百分比会
       * 悄悄退回字节口径，而没有任何东西会红。
       */
      readonly originalTokens: number;
      readonly compressedTokens: number;
    }
  | { readonly form: "prefix" };

/** 账本句柄。读数同步、写盘异步、失败只影响持久化。 */
export interface StatsStore {
  /**
   * 从存量记录恢复。**同步**：`table.get` 读的是宿主内存里的快照，这一层没有可等的东西。
   * 签名不带 Promise 是刻意的——`async` + 无 await 会被 lint 判成空 async 函数；
   * 调用点写 `await store.load()` 依然合法（await 非 thenable 直接透传）。
   */
  readonly load: () => void;
  /** 记一次压缩。**同步**：调用点在 `tools/post-execute` 热路径上。 */
  readonly accumulate: (input: AccumulateInput) => void;
  readonly summary: () => StatsSummary;
  readonly reset: () => Promise<void>;
  /** 等挂起的持久化落地（测试与关闭路径用；热路径不调它）。 */
  readonly flush: () => Promise<void>;
}

/**
 * 造一个账本句柄。
 *
 * 写入串成一条链而不是每条独立发射：链保证「后写的一定覆盖先写的」，否则同一轮里两次
 * `accumulate` 的两次 `put` 可能乱序落地，重启后读到的是旧的。`catch` 挂在链上而不挂在
 * 调用点——它既吞掉这次失败，也让链继续可写（链一旦 rejected，后续 `.then` 全部跳过）。
 */
export function createStatsStore(table: StatsTable): StatsStore {
  let acc: StatsAccumulator = EMPTY_ACCUMULATOR;
  let loaded = false;
  let chain: Promise<void> = Promise.resolve();

  // 串行写链：先等上一笔落地，再写这一笔。用 async 闭包而不是 `.then/.catch`——
  // 工作区的 `promise(prefer-await-to-then)` 把链式写法也算违规，而这里的意图（等、写、吞错）
  // 用 await 写出来正好一一对应。
  const persist = (value: StatsAccumulator): void => {
    chain = (async (): Promise<void> => {
      await chain;
      try {
        await table.put(SUMMARY_KEY, value);
      } catch {
        // 静默：这条路径在工具调用的热路径上，日志噪音会盖住真正的问题。
      }
    })();
  };

  return {
    load(): void {
      if (loaded) {
        return;
      }
      const stored = table.get(SUMMARY_KEY);
      acc = stored ?? EMPTY_ACCUMULATOR;
      loaded = true;
    },
    accumulate(input: AccumulateInput): void {
      // 两条形态路径都必须走 `persist`：prefix 只记命令数，但那一笔也要落盘，否则重启后
      // 用户开了默认形态（prefix）看到的仍是 0。
      if (input.form === "prefix") {
        acc = {
          ...acc,
          commands: acc.commands + 1,
          byForm: { ...acc.byForm, prefix: acc.byForm.prefix + 1 },
        };
      } else {
        const entry = acc.byFilter[input.filter] ?? { commands: 0, savedBytes: 0, savedTokens: 0 };
        acc = {
          commands: acc.commands + 1,
          originalBytes: acc.originalBytes + input.originalBytes,
          compressedBytes: acc.compressedBytes + input.compressedBytes,
          originalTokens: acc.originalTokens + input.originalTokens,
          compressedTokens: acc.compressedTokens + input.compressedTokens,
          byForm: { ...acc.byForm, pipe: acc.byForm.pipe + 1 },
          byFilter: {
            ...acc.byFilter,
            [input.filter]: {
              commands: entry.commands + 1,
              savedBytes: entry.savedBytes + (input.originalBytes - input.compressedBytes),
              savedTokens: entry.savedTokens + (input.originalTokens - input.compressedTokens),
            },
          },
        };
      }
      persist(acc);
    },
    summary(): StatsSummary {
      return summarize(acc);
    },
    async reset(): Promise<void> {
      acc = EMPTY_ACCUMULATOR;
      persist(acc);
      await chain;
    },
    async flush(): Promise<void> {
      await chain;
    },
  };
}

/**
 * 本层用到的**域句柄**的最小面：`table()` 与 `close()`。
 *
 * 不直接写 `Domain<typeof rtkStatsDomain>` 是刻意的：那是宿主的完整句柄（还带 `name` 与
 * `global`），而这一层只用两样东西。收窄之后，测试能拿一个两成员的替身来钉「接的是哪张表、
 * close 有没有传下去」，不必为了构造 `Domain` 去起 storage hub 与 json 后端；
 * 真句柄在结构上满足它，装配处照原样传进来即可。
 */
export interface StatsDomain {
  readonly table: (name: typeof SUMMARY_KEY) => StatsTable;
  readonly close: () => Promise<void>;
}

/** 本层用到的**存储设施**的最小面：拿一份域声明换一个域句柄。 */
export interface StatsDomainFacility {
  readonly open: (spec: typeof rtkStatsDomain) => Promise<StatsDomain>;
}

/**
 * 打开本插件的存储域、接上账本。
 *
 * 参数是**设施本身**（`ctx.storageDomain`），不是整个 Context：这一层只需要「拿声明换句柄」这一件事，
 * 收窄之后它连 `Context` 都不必认识。
 *
 * `close()` 交回调用方挂 disposer：facility 不替调用方管句柄生命周期（同名域重复 open 会抛
 * `already-open`，所以「谁 open 谁 close」是硬要求，不是风格）。
 */
export async function openStatsTable(
  ctx: StatsDomainFacility,
): Promise<{ readonly store: StatsStore; readonly close: () => Promise<void> }> {
  const domain = await ctx.open(rtkStatsDomain);
  const store = createStatsStore(domain.table(SUMMARY_KEY));
  store.load();
  return { store, close: () => domain.close() };
}

/** 内存替身表：storageDomain 打不开时用它——压缩照常，统计只管本次进程。 */
function memoryTable(): StatsTable {
  let stored: StatsAccumulator | undefined;
  return {
    get: () => stored,
    // 签名是 `Promise<void>`（真表要落盘），内存表没有异步动作，直接给已完成的 promise。
    put: (_key, value) => {
      stored = value;
      return Promise.resolve();
    },
  };
}

/** 延迟账本用到的那两样宿主面（`ctx.storageDomain` 与 `ctx.effect` 的结构子集）。 */
export interface DeferredStatsContext {
  readonly storageDomain: StatsDomainFacility;
  /** 挂 disposer 的口；同步 effect，交回的清理函数在插件卸载时按注册逆序跑。 */
  readonly effect: Context["effect"];
}

/**
 * 延迟打开的账本句柄。`load` 与 `StatsStore` 那份不同：这里它是异步的一次性动作
 * （打开存储域），而不是「从存量恢复」那一步。
 */
export interface DeferredStatsStore extends Omit<StatsStore, "load"> {
  readonly load: () => Promise<void>;
}

/**
 * 造一份「先内存、后持久化」的账本。
 *
 * **为什么要延迟**：`open()` 是 async 而 `apply` 是同步的；开局就 await 会把整条装配拖成
 * async（九仓里只有 dsh-scrapling 一处 async apply，代价是宿主侧装配语义变化）。所以先落
 * 内存账本，`load()` 在后台跑一次：打开成功就切到持久化账本，失败就**永久**留内存并 warn
 * 一句——统计是派生数据，打不开不该打掉压缩主功能。
 */
export function createDeferredStatsStore(ctx: DeferredStatsContext): DeferredStatsStore {
  // 内存账本也走一遍 `load()`：`createStatsStore` 的 `loaded` 标记只有 load 过后才置位，
  // 而「先内存后持久化」这条路径上没有人会再去读它。多这一句不是为了读一张空表，
  // 是让两份账本在同一套初始化语义下开工——切过去之后不会再有人对内存那份调 load。
  const fallback = createStatsStore(memoryTable());
  fallback.load();
  let active: StatsStore = fallback;
  return {
    async load(): Promise<void> {
      try {
        const opened = await openStatsTable(ctx.storageDomain);
        // 域的 close 由调用方负责（facility 不把 domain 绑到任何 consumer fiber），
        // 所以「谁 open 谁 close」：挂本插件 fiber 的 disposer（卸载时按注册逆序跑）。
        //
        // **disposer 要把 close 的 promise 交回去**，不能 `() => { void opened.close(); }`。
        // `ctx.effect` 的契约是「返回 thenable 就等它」，返回 undefined 等于宣告「同步就撤完了」：
        // 卸载随即返回，而域还要等自己的写入链跑完才释放名字（`DomainImpl.runClose()` 的
        // `await this.chain` 之后才 `onClosed()` 把名字从 reserved 里删掉）。这中间重新装配，
        // 就会撞 `domain 'rtk_stats' is already open`——真机现场那条「统计存储打不开」。
        ctx.effect(() => () => opened.close(), "rtk: stats domain");
        active = opened.store;
        // `openStatsTable` 内部已经 load 过一次；切换后不必再调（`StatsStore.load()` 同步）。
      } catch (error) {
        console.warn(
          `[rtk] 统计存储打不开（${errorText(error)}）：本次会话的统计只留在内存。压缩不受影响。`,
        );
      }
    },
    accumulate(input) {
      active.accumulate(input);
    },
    summary() {
      return active.summary();
    },
    async reset() {
      await active.reset();
    },
    async flush() {
      await active.flush();
    },
  };
}
