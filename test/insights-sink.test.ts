// test/insights-sink.test.ts —— 延迟打开的统计 sink。
//
// 这一层的存在理由只有三条（见 `lib/insights-sink.ts` 的文件头）：库可能打不开、打开是异步的、
// record 不能拖慢工具调用。三条都是**失败形态**，正常路径反而没什么可断言的——所以这里全部
// 用注入的假 `open`，逐条把失败分支走出来。
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import type { InsightsStore, OpenInsightsStoreOptions } from "../lib/insights-store.ts";
import { createDeferredInsights } from "../lib/insights-sink.ts";
import type { DeferredInsightsOptions, DeferredInsights } from "../lib/insights-sink.ts";
import type { LegacyAccumulator } from "../lib/legacy-stats.ts";
import type { PipeRecord, PrefixRecord } from "../lib/insights-shape.ts";
import { unbuildableDir } from "./unbuildable.ts";

const DB_PATH = "/sandbox/rtk/stats.db";
const DAY = "2026-11-15";
const FILTER = "cargo-test";
const FAMILY = "cargo test";
const STORE_LABEL = "rtk: insights store";
const BROKEN = "缓冲坏了";

/** 一条 prefix 记录（形状合法即可，这一层不关心它怎么落库）。 */
const PREFIX_CALL: PrefixRecord = {
  kind: "prefix-bash-call",
  ts: 1,
  commandFamily: FAMILY,
  workdir: "",
};

/** 一条 pipe 记录。 */
const PIPE_CALL: PipeRecord = {
  kind: "pipe-bash-call",
  ts: 1,
  commandFamily: FAMILY,
  workdir: "",
};

/** 一条旧账本（迁移那一侧的入参）。 */
const LEGACY: LegacyAccumulator = {
  commands: 3,
  originalBytes: 300,
  compressedBytes: 100,
  originalTokens: 30,
  compressedTokens: 10,
  byFilter: {},
  byForm: { prefix: 1, pipe: 2 },
};

/** 计数器：闭包里改的是它的字段，`Snapshot` 本身可以保持只读。 */
interface Closes {
  count: number;
}

/** 收件箱：这一层能观察到的全部副作用。 */
interface Snapshot {
  readonly prefix: PrefixRecord[];
  readonly pipe: PipeRecord[];
  readonly potential: (readonly [string, string])[];
  readonly closes: Closes;
  readonly effects: string[];
  readonly disposers: (() => unknown)[];
  readonly warns: string[];
  readonly opens: OpenInsightsStoreOptions[];
}

function emptySnapshot(): Snapshot {
  return {
    prefix: [],
    pipe: [],
    potential: [],
    closes: { count: 0 },
    effects: [],
    disposers: [],
    warns: [],
    opens: [],
  };
}

/**
 * 会记账的假 store。
 *
 * 只实现这一层用得上的那几位：`InsightsStore` 另外十几个读面在这条路径上是死代码，
 * 造全了反而要把二十多个方法一字排开——用 `Pick` 收窄，让类型检查盯住的就是这个最小面。
 */
function recorderOf(seen: Snapshot): InsightsStore {
  const recorder: Pick<InsightsStore, "recordPrefix" | "recordPipe" | "recordPotential" | "close"> =
    {
      recordPrefix: (input) => {
        seen.prefix.push(input);
      },
      recordPipe: (input) => {
        seen.pipe.push(input);
      },
      recordPotential: (day, filter) => {
        seen.potential.push([day, filter]);
      },
      close: () => {
        seen.closes.count += 1;
        return Promise.resolve();
      },
    };
  return recorder as InsightsStore;
}

/** `open` 的替身：给收件箱，回一个真正的 open 实现。 */
type FakeOpen = (
  seen: Snapshot,
) => (input: OpenInsightsStoreOptions) => Promise<InsightsStore | undefined>;

/**
 * 造一套 harness。
 *
 * `effect` 立刻跑工厂并**留下 disposer**（不自动跑）：`close` 的调用时机也是这一层的契约，
 * 让用例自己决定什么时候卸载。
 */
function makeHarness(
  fake: FakeOpen,
  extra: { readonly legacy?: (() => Promise<LegacyAccumulator | null>) | undefined } = {},
): { readonly options: DeferredInsightsOptions; readonly seen: Snapshot } {
  const seen = emptySnapshot();
  const open = fake(seen);
  const options: DeferredInsightsOptions = {
    dbPath: DB_PATH,
    ...(extra.legacy === undefined ? {} : { legacy: extra.legacy }),
    effect: (run, label) => {
      seen.effects.push(label);
      seen.disposers.push(run());
    },
    warn: (line) => {
      seen.warns.push(line);
    },
    open: (input) => {
      seen.opens.push(input);
      return open(input);
    },
  };
  return { options, seen };
}

/** 恒开不出来的那一份（走「库不可用」那一路）。 */
const neverOpens: FakeOpen = () => () => Promise.resolve(undefined);

/** 三条 record 各调一次（共用，避免同一个序列写三遍）。 */
function recordAll(insights: DeferredInsights): void {
  insights.sink.recordPrefix(PREFIX_CALL);
  insights.sink.recordPipe(PIPE_CALL);
  insights.sink.recordPotential(DAY, FILTER);
}

describe("createDeferredInsights", () => {
  it("开库之前来的 record 一律丢（半份数据比空窗口更难解释）", () => {
    const { options, seen } = makeHarness(neverOpens);
    const insights = createDeferredInsights(options);
    // 还没 load：三条 record 都不该到任何地方，也不该抛。
    recordAll(insights);
    assert.equal(insights.store(), undefined);
    assert.deepEqual(seen.prefix, []);
    assert.deepEqual(seen.pipe, []);
    assert.deepEqual(seen.potential, []);
    assert.deepEqual(seen.opens, [], "连库都没开，就不该有 open 调用");
    assert.equal(seen.warns.length, 0, "丢记录不是故障，不该打日志");
  });

  it("开库成功后 record 直通 store，并把 close 挂成 fiber 效应", async () => {
    const { options, seen } = makeHarness((box) => (input): Promise<InsightsStore> => {
      assert.equal(input.dbPath, DB_PATH);
      assert.equal(input.legacy, null, "没给 legacy 读取器时是 null，不是 undefined");
      return Promise.resolve(recorderOf(box));
    });
    const insights = createDeferredInsights(options);
    await insights.load();
    recordAll(insights);
    assert.deepEqual(seen.prefix, [PREFIX_CALL]);
    assert.deepEqual(seen.pipe, [PIPE_CALL]);
    assert.deepEqual(seen.potential, [[DAY, FILTER]]);
    assert.deepEqual(seen.effects, [STORE_LABEL]);
    assert.deepEqual(seen.warns, []);
    assert.notEqual(insights.store(), undefined);
    // 卸载时按注册逆序跑：disposer 交的是 `store.close()` 那个 promise。
    const [dispose] = seen.disposers;
    assert.ok(dispose !== undefined, "开成功就必须交出 disposer");
    await dispose();
    assert.equal(seen.closes.count, 1);
  });

  it("load 幂等：开成功之后连调两次只开一次库", async () => {
    const { options, seen } = makeHarness((box) => () => Promise.resolve(recorderOf(box)));
    const insights = createDeferredInsights(options);
    await insights.load();
    await insights.load();
    assert.equal(seen.opens.length, 1, "第二个连接会让 statsEpoch 的代际比较失去意义");
  });

  it("开不出来时不缓存那趟失败：下一次 load 重新试", async () => {
    let attempts = 0;
    const { options, seen } = makeHarness((box) => () => {
      attempts += 1;
      // 头两次拖不动（宿主刚起、文件被占），第三次才成功。
      return Promise.resolve(attempts < 3 ? undefined : recorderOf(box));
    });
    const insights = createDeferredInsights(options);
    await insights.load();
    assert.equal(seen.opens.length, 1);
    await insights.load();
    await insights.load();
    assert.equal(seen.opens.length, 3, "失败要能重试，否则一次打不开就整个会话没有统计");
    assert.ok(insights.store() !== undefined);
  });

  it("开不出来时 warn 一句点名后果，且后续 record 静默丢弃", async () => {
    const { options, seen } = makeHarness(neverOpens);
    const insights = createDeferredInsights(options);
    await insights.load();
    assert.equal(seen.warns.length, 1);
    assert.match(seen.warns[0] ?? "", /cannot open the stats tables/u);
    assert.match(seen.warns[0] ?? "", /report it as unavailable/u);
    insights.sink.recordPrefix(PREFIX_CALL);
    assert.equal(insights.store(), undefined);
    assert.equal(seen.warns.length, 1, "丢弃不该再打一条日志");
    assert.deepEqual(seen.effects, [], "开不出来就不该挂 disposer");
  });

  it("旧账本读失败只 warn，新库照常打开", async () => {
    const { options, seen } = makeHarness(neverOpens, {
      legacy: () => Promise.reject(new Error(BROKEN)),
    });
    const insights = createDeferredInsights(options);
    await insights.load();
    assert.equal(seen.warns.length, 2, "一条 legacy 读失败、一条开库失败");
    assert.match(seen.warns[0] ?? "", /cannot read the legacy accumulator/u);
    assert.match(seen.warns[0] ?? "", new RegExp(BROKEN, "u"));
  });

  it("旧账本读得出来时交给 open（迁移要的就是这一份）", async () => {
    const { options, seen } = makeHarness(neverOpens, {
      legacy: () => Promise.resolve(LEGACY),
    });
    const insights = createDeferredInsights(options);
    await insights.load();
    assert.deepEqual(seen.opens[0]?.legacy, LEGACY);
  });

  it("store 自己抛错时只留一行 warn，不冒到调用方", async () => {
    const { options, seen } = makeHarness(
      () => () =>
        Promise.resolve({
          recordPrefix: () => {
            throw new Error(BROKEN);
          },
          recordPipe: () => {
            throw new Error(BROKEN);
          },
          recordPotential: () => {
            throw new Error(BROKEN);
          },
          close: () => Promise.resolve(),
        } as unknown as InsightsStore),
    );
    const insights = createDeferredInsights(options);
    await insights.load();
    assert.doesNotThrow(() => {
      recordAll(insights);
    });
    assert.equal(seen.warns.length, 3, "三条都抛就三条都记");
    assert.match(seen.warns[0] ?? "", /insights: record failed/u);
    assert.match(seen.warns[1] ?? "", new RegExp(BROKEN, "u"));
  });

  it("不注入 open 时走真 openInsightsStore（默认参数接得上）", async () => {
    // 承重件是**类型**：默认值若与 `typeof openInsightsStore` 不兼容，tsc 先红；
    // 运行时只要求「给了不存在的路径也不抛」——那是 fail-open 的判据。
    //
    // 路径的父级是一个普通文件（`unbuildableDir()`），不是 `/dev/null`：后者在 Windows 上
    // 只是一个普通路径段，`mkdir -p` 会把它建出来，于是这条用例在 windows CI 上走的是
    // **成功**路径（`effects` 拿到 `rtk: insights store` 而不是空）。
    const effects: string[] = [];
    const warns: string[] = [];
    const insights = createDeferredInsights({
      dbPath: path.join(unbuildableDir(), "stats.db"),
      effect: (run, label) => {
        effects.push(label);
        void run();
      },
      warn: (line) => {
        warns.push(line);
      },
    });
    await insights.load();
    assert.deepEqual(effects, []);
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /cannot open the stats tables/u);
  });
});
