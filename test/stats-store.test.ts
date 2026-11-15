// test/stats-store.test.ts —— 自记账的累加与投影。
//
// 这一层只依赖「一张表的 get/put」，所以测试用同形替身而不是真起来 storage hub + json 后端：
// 断言的是公式、幂等、fail-open 三件事，与后端实现无关。真后端的 roundtrip 由 Task 24 的总装
// 与「已发布产物」回路覆盖。
import { describe, it, onTestFinished } from "vitest";
import assert from "node:assert/strict";

import { EMPTY_ACCUMULATOR, statsAccumulatorSchema, summarize } from "../lib/stats-shape.ts";
import {
  createDeferredStatsStore,
  createStatsStore,
  openStatsTable,
  rtkStatsDomain,
} from "../lib/stats-store.ts";
import type {
  AccumulateInput,
  DeferredStatsContext,
  StatsDomain,
  StatsTable,
} from "../lib/stats-store.ts";
import type { StatsAccumulator } from "../lib/stats-shape.ts";

/** filter 名在这份用例里反复出现，提成常量（`sonarjs(no-duplicate-string)` 数到三次就红）。 */
const CARGO_TEST = "cargo-test";

/** `apply` 挂统计域 disposer 用的标签（与 lib/stats-store.ts 逐字相同）。 */
const STATS_DOMAIN_LABEL = "rtk: stats domain";

/**
 * pipe 一笔的简写。
 *
 * 字节与 token 刻意取**不同的数**（token = 字节 / 2）：两套账各自累加，若实现把 token 抄成
 * 字节、或者干脆没加上，这里的断言立刻分得开——两列都填同一个数时，「加错了」与「加对了」
 * 长得一模一样。
 */
function pipeOf(filter: string, originalBytes: number, compressedBytes: number): AccumulateInput {
  return {
    form: "pipe",
    filter,
    originalBytes,
    compressedBytes,
    originalTokens: originalBytes / 2,
    compressedTokens: compressedBytes / 2,
  };
}

/** 存量账本字面量的简写：token 两列按 `pipeOf` 同口径给（字节的一半），要覆盖就显式写。 */
function accOf(overrides: Partial<StatsAccumulator> = {}): StatsAccumulator {
  const originalBytes = overrides.originalBytes ?? 0;
  const compressedBytes = overrides.compressedBytes ?? 0;
  return {
    commands: 0,
    originalBytes,
    compressedBytes,
    originalTokens: originalBytes / 2,
    compressedTokens: compressedBytes / 2,
    byFilter: {},
    byForm: { prefix: 0, pipe: 0 },
    ...overrides,
  };
}

/** 同形替身：真身是 `domain.table('summary')`（`KvTable<'summary', StatsAccumulator>`）。 */
function fakeTable(initial?: StatsAccumulator): StatsTable & {
  readonly writes: StatsAccumulator[];
  readonly failNext: (error: Error) => void;
} {
  let stored: StatsAccumulator | undefined = initial;
  const writes: StatsAccumulator[] = [];
  const failures: Error[] = [];
  return {
    writes,
    failNext: (error: Error): void => {
      failures.push(error);
    },
    get: (): StatsAccumulator | undefined => stored,
    put: async (_key, value): Promise<void> => {
      const boom = failures.shift();
      if (boom !== undefined) {
        throw boom;
      }
      stored = value;
      writes.push(value);
    },
  };
}

describe("summarize", () => {
  it("节省率保留两位小数", () => {
    const summary = summarize(accOf({ commands: 2, originalBytes: 1500, compressedBytes: 150 }));
    assert.equal(summary.savedBytes, 1350);
    assert.equal(summary.savedTokens, 675);
    assert.equal(summary.savingsPct, 90);
  });

  it("零命令时节省率是 0，不是 NaN", () => {
    assert.deepEqual(summarize(EMPTY_ACCUMULATOR), {
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
      topFilters: [],
    });
  });

  it("除不尽时四舍五入到两位", () => {
    // 999/3 = 333 整，用 999 → 666 得到 33.333…%：第三位非零，能区分「截断」与「四舍五入」。
    const summary = summarize(accOf({ commands: 1, originalBytes: 999, compressedBytes: 666 }));
    assert.equal(summary.savingsPct, 33.33);
  });

  it("节省率按 token 算，而不是字节", () => {
    // 字节省 90%、token 省 50%：两个口径给出不同答案，断言必须落在 token 上才分得开。
    const summary = summarize({
      ...accOf({ commands: 1, originalBytes: 1000, compressedBytes: 100 }),
      originalTokens: 200,
      compressedTokens: 100,
    });
    assert.equal(summary.savedTokens, 100);
    assert.equal(summary.savingsPct, 50);
  });

  it("存量账本没有 token 两列时退回字节口径，不是 NaN", () => {
    // 版本 1 的账本过 schema 时 `.default(0)` 把 token 补成 0；那一份的真实收益只在字节里。
    const summary = summarize({
      commands: 1,
      originalBytes: 1000,
      compressedBytes: 100,
      originalTokens: 0,
      compressedTokens: 0,
      byFilter: {},
      byForm: { prefix: 0, pipe: 1 },
    });
    assert.equal(summary.savedTokens, 0);
    assert.equal(summary.savingsPct, 90);
  });
});

describe("createStatsStore", () => {
  it("累加公式与 byFilter 分项", () => {
    const table = fakeTable();
    const store = createStatsStore(table);
    store.accumulate(pipeOf(CARGO_TEST, 1000, 100));
    store.accumulate(pipeOf(CARGO_TEST, 500, 50));
    store.accumulate(pipeOf("pytest", 200, 20));
    const summary = store.summary();
    assert.equal(summary.commands, 3);
    assert.equal(summary.originalBytes, 1700);
    assert.equal(summary.compressedBytes, 170);
    // token 那两列各自累加（同口径 = 字节的一半），不是抄字节。
    assert.equal(summary.originalTokens, 850);
    assert.equal(summary.compressedTokens, 85);
    // 逐项整体比对而不是逐字段取：zod 4 的 `z.record(z.string(), ...)` 在类型上把任意键
    // 都当成必定存在（索引签名不是可选的），所以 `?.` 会被判成多余的条件判断。
    assert.deepEqual(summary.byFilter[CARGO_TEST], {
      commands: 2,
      savedBytes: 1350,
      savedTokens: 675,
    });
    assert.deepEqual(summary.byFilter["pytest"], { commands: 1, savedBytes: 180, savedTokens: 90 });
  });

  it("prefix 只加命令数与 byForm.prefix，字节与 byFilter 一个都不动", () => {
    // spec §6：改写形态看不到原始输出，所以它省下的字节没有真值可记 —— 那一列在卡片上是 `—`。
    const store = createStatsStore(fakeTable());
    store.accumulate(pipeOf(CARGO_TEST, 1000, 100));
    store.accumulate({ form: "prefix" });
    const summary = store.summary();
    assert.equal(summary.commands, 2);
    assert.equal(summary.byForm.prefix, 1);
    assert.equal(summary.byForm.pipe, 1);
    // 字节只由 pipe 那一笔贡献：prefix 若无脑填 0 字节，这里的分子分母会同时错。
    assert.equal(summary.originalBytes, 1000);
    assert.equal(summary.compressedBytes, 100);
    assert.equal(summary.originalTokens, 500);
    assert.equal(summary.compressedTokens, 50);
    assert.deepEqual(summary.byFilter, {
      [CARGO_TEST]: { commands: 1, savedBytes: 900, savedTokens: 450 },
    });
  });

  it("load 从存量记录恢复；没存量时用空账本", async () => {
    const existing = accOf({ commands: 7, originalBytes: 700, compressedBytes: 70 });
    const restored = createStatsStore(fakeTable(existing));
    restored.load();
    assert.equal(restored.summary().commands, 7);
    assert.equal(restored.summary().originalTokens, 350);

    const fresh = createStatsStore(fakeTable());
    fresh.load();
    assert.equal(fresh.summary().commands, 0);
  });

  it("存量账本缺 token 两列时读得进来（域版本 2 的迁移通道）", async () => {
    // 版本 1 的账本里没有这两列。`statsAccumulatorSchema` 用 `.default(0)` 接住它，配合
    // `compatibleVersions: [1]` 让 `open()` 不把整份判成 invalid-record。
    const legacy = statsAccumulatorSchema.parse({
      commands: 2,
      originalBytes: 1000,
      compressedBytes: 100,
      byFilter: {},
      byForm: { prefix: 0, pipe: 2 },
    });
    assert.equal(legacy.originalTokens, 0);
    const store = createStatsStore(fakeTable(legacy));
    store.load();
    assert.equal(store.summary().commands, 2);
    // 没有 token 真值 → 省下的 token 是 0，节省率仍按字节给出（不是 NaN）。
    assert.equal(store.summary().savedTokens, 0);
    assert.equal(store.summary().savingsPct, 90);
  });

  it("accumulate 是同步的（热路径），持久化异步落地", async () => {
    const table = fakeTable();
    const store = createStatsStore(table);
    store.accumulate(pipeOf("ctest", 10, 1));
    // 还没 await flush：写入不在这条同步路径上，否则 post-execute 会被存储延迟拖住。
    assert.equal(table.writes.length, 0);
    await store.flush();
    assert.equal(table.writes.length, 1);
    assert.equal(table.writes[0]?.commands, 1);
  });

  it("写入失败只影响持久化，不影响内存读数（fail-open）", async () => {
    const table = fakeTable();
    const store = createStatsStore(table);
    table.failNext(new Error("backend down"));
    store.accumulate(pipeOf("ctest", 10, 1));
    await store.flush();
    // 内存账本照记：这一轮的节省该显示在卡片上，缺的只是重启后的历史。
    assert.equal(store.summary().commands, 1);
  });

  it("reset 清零并落盘", async () => {
    const table = fakeTable();
    const store = createStatsStore(table);
    store.accumulate(pipeOf("pytest", 100, 10));
    await store.flush();
    await store.reset();
    assert.equal(store.summary().commands, 0);
    assert.equal(table.writes.at(-1)?.commands, 0);
  });

  it("load 幂等（重复调用不再读库）", async () => {
    let reads = 0;
    const inner = fakeTable(accOf({ commands: 1, originalBytes: 1, compressedBytes: 0 }));
    const counting: StatsTable = {
      get: (key) => {
        reads += 1;
        return inner.get(key);
      },
      put: (key, value) => inner.put(key, value),
    };
    const store = createStatsStore(counting);
    store.load();
    store.load();
    assert.equal(reads, 1);
  });
});

describe("openStatsTable", () => {
  it("open 域 → 接上账本 → 已有存量时立刻可读；close 交回调用方", async () => {
    // 真身是 `ctx.storageDomain.open(spec)`（返回带 table()/close() 的句柄）。这里只造这两样，
    // 断言的是「打开后接的是那张表、close 传下去了」这两件契约，不是 storage 后端的行为。
    const stored = accOf({
      commands: 3,
      originalBytes: 300,
      compressedBytes: 30,
      byFilter: { [CARGO_TEST]: { commands: 3, savedBytes: 270, savedTokens: 0 } },
      byForm: { prefix: 0, pipe: 3 },
    });
    let closed = 0;
    let openedSpec: unknown;
    const table: StatsTable = {
      // 键只有 `SUMMARY_KEY` 一个取值（类型层面），所以这里不必再判一次等值——真表也只有一个键。
      get: () => stored,
      put: (): Promise<void> => Promise.resolve(),
    };
    const facility = {
      open: (spec: typeof rtkStatsDomain): Promise<StatsDomain> => {
        openedSpec = spec;
        return Promise.resolve({
          table: (): StatsTable => table,
          close: (): Promise<void> => {
            closed += 1;
            return Promise.resolve();
          },
        });
      },
    };
    const handle = await openStatsTable(facility);
    // 接的是本包的域声明（名字/表名都从那一处来，不是调用点临时拼的）。
    assert.equal(openedSpec, rtkStatsDomain);
    // open 里已经 load 过：拿到句柄就能读到存量。
    assert.equal(handle.store.summary().commands, 3);
    await handle.close();
    assert.equal(closed, 1);
  });
});

/** 打不开的域：走「永久留在内存」那一支。 */
const offlineDomain = {
  open: (): Promise<StatsDomain> => Promise.reject(new Error("backend offline")),
};

/** 打得开的域：接上给定那张表，`close` 计次（用来断言「谁 open 谁 close」）。 */
function onlineDomain(table: StatsTable): {
  readonly storageDomain: DeferredStatsContext["storageDomain"];
  readonly closes: () => number;
} {
  let closed = 0;
  return {
    storageDomain: {
      open: (): Promise<StatsDomain> =>
        Promise.resolve({
          table: () => table,
          close: (): Promise<void> => {
            closed += 1;
            return Promise.resolve();
          },
        }),
    },
    closes: () => closed,
  };
}

/** 只记标签的 effect 口（不真挂 fiber；同步工厂，返回清理函数）。 */
function effectRecorder(): {
  readonly effect: DeferredStatsContext["effect"];
  readonly labels: string[];
  readonly disposers: (() => void | Promise<void>)[];
} {
  const labels: string[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  // `Context["effect"]` 是 cordis 的双重载签名（同步 / 异步工厂各一支），替身只覆盖同步那一支。
  // 断言收在这一处：用例其余部分都走 `DeferredStatsContext["effect"]` 的类型面。
  //
  // 工厂返回的清理函数**必须允许返回 promise**：cordis 的 disposer 契约是「返回 thenable 就等它」，
  // 而统计域的 close 是异步的（`DomainImpl.runClose()` 要等写入链跑完才释放名字）。替身若收窄成
  // `() => void`，实现改成 `() => opened.close()` 就会在这里编译不过——那正是要保住的性质。
  const effect = ((execute: () => () => void | Promise<void>, label?: string): (() => void) => {
    labels.push(label ?? "");
    const disposer = execute();
    disposers.push(disposer);
    return () => {
      void disposer();
    };
  }) as unknown as DeferredStatsContext["effect"];
  return { effect, labels, disposers };
}

describe("createDeferredStatsStore", () => {
  it("存储打不开时留在内存账本上：累加、投影、清零、落盘四条转发全部照常可调", async () => {
    // 这一支**必然**打一条 warn（那是产品行为：打不开要让用户看得见）。测试里必须接管它：
    // 跑测输出的噪点表把 `stderr | ` 横幅算成噪点（`scripts/lib/noise-audit.mjs`），
    // 不接管就会让 `pnpm check` 的噪点表多一条，读的人得去分辨那是设计还是漏网。
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.join(" "));
    };
    onTestFinished(() => {
      console.warn = original;
    });
    const { effect, labels } = effectRecorder();
    const store = createDeferredStatsStore({ storageDomain: offlineDomain, effect });
    await store.load();
    // 打不开这件事必须说出来，而且要说清「只影响统计、不影响压缩」。
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /只留在内存/u);
    assert.match(warnings[0] ?? "", /backend offline/u);
    store.accumulate(pipeOf(CARGO_TEST, 1000, 100));
    assert.equal(store.summary().commands, 1);
    // 内存表的 put 拿到的就是累加后的账本——下一次 `get` 读到的必须是它。
    await store.flush();
    await store.reset();
    assert.equal(store.summary().commands, 0);
    // 打不开就没有域可关，也就没有 disposer 要挂。
    assert.deepEqual(labels, []);
  });

  it("存储打得开时切到持久化账本，并挂一个只关一次的 disposer", async () => {
    const table = fakeTable();
    const online = onlineDomain(table);
    const { effect, labels, disposers } = effectRecorder();
    const store = createDeferredStatsStore({ storageDomain: online.storageDomain, effect });
    await store.load();
    assert.deepEqual(labels, [STATS_DOMAIN_LABEL]);
    // **disposer 必须把 close 的 promise 交回来**（而不是 `void` 掉它）：cordis 只等 thenable，
    // 返回 undefined 就等于宣告「同步撤完了」，卸载会先于域真正释放名字返回，紧接着的重新装配
    // 就撞 `already open`。这一条把那个性质钉在实现里——删掉 `return` 这里就红。
    assert.equal(disposers.length, 1);
    const returned = disposers[0]?.();
    assert.ok(returned instanceof Promise, "disposer 要返回 close 的 promise，不能 void 掉");
    await returned;
    assert.equal(online.closes(), 1, "disposer 跑一次关一次");
    store.accumulate(pipeOf("pytest", 100, 10));
    await store.flush();
    // 落到了真表上：内存表那一支不会有写入记录。
    assert.equal(table.writes.length, 1);
    assert.equal(store.summary().commands, 1);
    await store.reset();
    assert.equal(table.writes.at(-1)?.commands, 0);
    // 去重：同一份两处读到的都是切换后的账本（`load` 只切一次）。
    await store.load();
    assert.equal(labels.length, 2);
    assert.equal(online.closes(), 1, "load 不自己关；第二枚 disposer 还没跑");
  });
});
