// test/insights-service.test.ts —— 聚合层。这一层是「原始行 → 页面回执」的唯一翻译处，
// 所以本文件按**回执字段**验，而不是按内部 helper 验：换一种聚合写法不该让测试红，
// 但漏一个字段、算错一个分母必须红。
//
// 两个贯穿的口径在每条用例里都显式断言：
// 1. 两种形态不合并（prefix 与 pipe 的 totals 各自算各自的）。
// 2. 缺失不冒充 0（availability 标 unavailable/readonly，而不是给一份全是 0 的回执当结论）。
import assert from "node:assert/strict";

import { describe, it } from "vitest";

import type { InsightsServiceDeps, InsightsService } from "../lib/insights-service.ts";
import { createInsightsService } from "../lib/insights-service.ts";
import type {
  InsightsRequest,
  InsightsResponse,
  LegacySnapshot,
  StatsOverview,
} from "../lib/insights-shape.ts";
import type {
  InsightsStore,
  LastEventRow,
  PipeDayRow,
  PipeEventRow,
  PotentialRow,
  PrefixDayRow,
  ReasonRow,
} from "../lib/insights-store.ts";
import type {
  LedgerCommandRow,
  LedgerDayRow,
  LedgerWorkdirRow,
  PrefixLedgerResult,
  RtkLedger,
} from "../lib/rtk-ledger.ts";
import type { StatsStatus } from "../lib/stats-shape.ts";

/** 固定的「现在」：2026-11-15 是周日，周桶落在 11-09，跨周场景靠它才可复现。 */
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime();
const TODAY = "2026-11-15";
const YESTERDAY = "2026-11-14";
const LAST_WEEK = "2026-11-05";
const OLD = "2026-06-01";

/** 反复出现的字面量：写死成常量，改一处就够。 */
const FILTER_CARGO = "cargo-test";
const FILTER_PYTEST = "pytest";
const FILTER_VERBOSE = "verbose";
const FAMILY_CARGO = "cargo test";
const FAMILY_GIT = "git status";
const WORKDIR_APP = "/repo/app";
const WORKDIR_LIB = "/repo/lib";
const REASON_SUCCESS = "success";
const REASON_TOO_SMALL = "too-small";
const REASON_GUARD_LOW_GAIN = "guard:low-gain";
const STATUS_COMPRESSED = "compressed";
const UNKNOWN = "unknown";

const STATUS: StatsStatus = {
  rtkPath: "/opt/homebrew/bin/rtk",
  rtkVersion: "1.2.3",
  supported: true,
  enabled: true,
  forms: ["prefix", "pipe"],
};

const LEGACY: LegacySnapshot = {
  commands: 9,
  savedTokens: 900,
  byForm: { prefix: 3, pipe: 6 },
  byFilter: { [FILTER_CARGO]: { commands: 5, savedBytes: 500, savedTokens: 500 } },
};

/** 造一行 pipe 天表。 */
const pipeDay = (day: string, overrides: Partial<PipeDayRow> = {}): PipeDayRow => ({
  day,
  bash_calls: 10,
  compressed: 4,
  original_tokens: 1000,
  compressed_tokens: 200,
  saved_tokens: 800,
  latency_ms_sum: 120,
  latency_count: 4,
  ...overrides,
});

/** 造一行 pipe 事件。 */
const pipeEvent = (overrides: Partial<PipeEventRow> = {}): PipeEventRow => ({
  id: 1,
  ts: NOW - 1000,
  day: TODAY,
  filter: FILTER_CARGO,
  command_family: FAMILY_CARGO,
  workdir: WORKDIR_APP,
  status: STATUS_COMPRESSED,
  reason: REASON_SUCCESS,
  original_tokens: 1000,
  compressed_tokens: 200,
  saved_tokens: 800,
  original_bytes: 4000,
  compressed_bytes: 800,
  latency_ms: 30,
  ...overrides,
});

/** 造一行 prefix 天表。 */
const prefixDay = (day: string, overrides: Partial<PrefixDayRow> = {}): PrefixDayRow => ({
  day,
  bash_calls: 8,
  gate_skips: 2,
  attempts: 6,
  rewritten: 5,
  no_rewrite: 1,
  verify_rejected: 0,
  rewrite_error: 0,
  timeout: 0,
  latency_ms_sum: 100,
  latency_count: 5,
  ...overrides,
});

/** 造一行原因计数。 */
const reasonRow = (day: string, reason: string, count: number): ReasonRow => ({
  day,
  reason,
  count,
});

/** 造一行 last_events。 */
const lastEventRow = (overrides: Partial<LastEventRow> = {}): LastEventRow => ({
  id: 7,
  ts: NOW - 500,
  form: "pipe",
  status: STATUS_COMPRESSED,
  reason: REASON_SUCCESS,
  command_family: FAMILY_CARGO,
  workdir: WORKDIR_APP,
  filter: FILTER_CARGO,
  size_bucket: "small",
  ...overrides,
});

/** 一行账本的天表。 */
const ledgerDay = (day: string, overrides: Partial<LedgerDayRow> = {}): LedgerDayRow => ({
  day,
  commands: 5,
  input: 2000,
  output: 500,
  saved: 1500,
  ...overrides,
});

/** 一行账本的命令行。 */
const ledgerCommand = (overrides: Partial<LedgerCommandRow> = {}): LedgerCommandRow => ({
  original_cmd: FAMILY_CARGO,
  rtk_cmd: `rtk ${FAMILY_CARGO}`,
  commands: 5,
  input: 2000,
  output: 500,
  saved: 1500,
  ...overrides,
});

/** 一行账本的工作目录行。 */
const ledgerWorkdir = (overrides: Partial<LedgerWorkdirRow> = {}): LedgerWorkdirRow => ({
  project_path: WORKDIR_APP,
  commands: 5,
  input: 2000,
  saved: 1500,
  ...overrides,
});

/** 假库：每个读面都从数组里筛，写面只记账。 */
interface FakeStore extends InsightsStore {
  readonly resetCalls: () => number;
}

/** 假库的初始数据。 */
interface Seed {
  readonly pipeDays?: PipeDayRow[];
  readonly pipeEvents?: PipeEventRow[];
  readonly prefixDays?: PrefixDayRow[];
  readonly pipeReasons?: ReasonRow[];
  readonly prefixReasons?: ReasonRow[];
  readonly potential?: PotentialRow[];
  readonly lastEvents?: LastEventRow[];
  readonly legacy?: LegacySnapshot | null;
}

/** 造一个假库；`reset` 会真的清空各表，好让「清零后概览」量到清零。 */
const storeOf = (seed: Seed = {}): FakeStore => {
  let resets = 0;
  const pipeDays = seed.pipeDays ?? [];
  const pipeEvents = seed.pipeEvents ?? [];
  const prefixDays = seed.prefixDays ?? [];
  const pipeReasons = seed.pipeReasons ?? [];
  const prefixReasons = seed.prefixReasons ?? [];
  const potential = seed.potential ?? [];
  const lastEvents = seed.lastEvents ?? [];
  const clearAll = (): void => {
    for (const table of [
      pipeDays,
      pipeEvents,
      prefixDays,
      pipeReasons,
      prefixReasons,
      potential,
      lastEvents,
    ]) {
      table.length = 0;
    }
  };
  return {
    recordPipe: () => {
      /* 假库不记账：本文件只验读面 */
    },
    recordPrefix: () => {
      /* 同上 */
    },
    recordPotential: () => {
      /* 同上 */
    },
    readPipeDays: (startDay) => pipeDays.filter((row) => row.day >= startDay),
    readPipeEvents: (startDay) => pipeEvents.filter((row) => row.day >= startDay),
    readPipeSkipReasons: (startDay) => pipeReasons.filter((row) => row.day >= startDay),
    readPrefixDays: (startDay) => prefixDays.filter((row) => row.day >= startDay),
    readPrefixGateReasons: (startDay) => prefixReasons.filter((row) => row.day >= startDay),
    readPotential: (startDay) => potential.filter((row) => row.day >= startDay),
    readLastEvents: (limit) => lastEvents.slice(0, limit),
    readLastEventOf: (form) => lastEvents.find((row) => row.form === form),
    readPipeFirstDay: () => pipeDays[0]?.day ?? null,
    readLegacy: () => seed.legacy ?? null,
    reset: () => {
      resets += 1;
      clearAll();
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    resetCalls: () => resets,
  };
};

/** 一份 pipe 库：两天、四条事件（两条压缩成功 + 两条跳过）。 */
const pipeStore = (): FakeStore =>
  storeOf({
    // 天表的 compressed 必须等于当天「status=compressed」的事件数：它本来就是这么累加出来的。
    pipeDays: [
      pipeDay(YESTERDAY, { bash_calls: 10, compressed: 1 }),
      pipeDay(TODAY, { bash_calls: 10, compressed: 1 }),
    ],
    pipeEvents: [
      pipeEvent({ id: 1 }),
      pipeEvent({
        id: 2,
        ts: NOW - 2000,
        filter: FILTER_PYTEST,
        command_family: FILTER_PYTEST,
        workdir: WORKDIR_LIB,
        saved_tokens: 100,
        compressed_tokens: 900,
        latency_ms: 90,
      }),
      pipeEvent({
        id: 3,
        ts: NOW - 3000,
        status: "skipped",
        reason: REASON_GUARD_LOW_GAIN,
        filter: "",
        command_family: "",
        workdir: "",
        saved_tokens: 0,
        latency_ms: 0,
      }),
      // 第四条只补齐「昨天也有一条 skipped」的形状，不带任何计量：带了的话它会混进
      // cargo-test 那一组的节省量里，把「按节省量排序」这条判据变成看假数据。
      pipeEvent({
        id: 4,
        day: YESTERDAY,
        status: "skipped",
        reason: REASON_TOO_SMALL,
        filter: "",
        command_family: "",
        workdir: "",
        original_tokens: 0,
        compressed_tokens: 0,
        saved_tokens: 0,
        original_bytes: 0,
        compressed_bytes: 0,
        latency_ms: 0,
      }),
    ],
    pipeReasons: [
      reasonRow(TODAY, REASON_TOO_SMALL, 4),
      reasonRow(YESTERDAY, REASON_TOO_SMALL, 1),
      reasonRow(TODAY, REASON_GUARD_LOW_GAIN, 1),
    ],
    potential: [{ day: TODAY, filter: "ctest", matches: 5 }],
    lastEvents: [lastEventRow({ form: "pipe" }), lastEventRow({ id: 9, form: "prefix" })],
    legacy: LEGACY,
  });

/** 账本读面记下的轨迹。 */
interface LedgerSeen {
  reads: number;
  clears: number;
}

/** 假账本：默认「读得到、没内容」。 */
const ledgerOf = (result: Partial<PrefixLedgerResult> = {}, seen?: LedgerSeen): RtkLedger => ({
  read: () => {
    if (seen !== undefined) {
      seen.reads += 1;
    }
    return Promise.resolve({
      availability: "ok",
      days: [],
      commands: [],
      workdirs: [],
      dataStart: null,
      failures: { total: 0, recovered: 0 },
      oversized: 0,
      recall: { entries: 0, bytes: 0 },
      ...result,
    });
  },
  clear: () => {
    if (seen !== undefined) {
      seen.clears += 1;
    }
    return Promise.resolve();
  },
});

/**
 * 「库打不开」那一位。
 *
 * 写成带注释的空体而不是 `() => undefined`：后者会被 `unicorn(no-useless-undefined)` 判成
 * 无意义表达式，而这里想要的恰好就是「什么都不给」。
 */
const NO_STORE = (): undefined => {
  /* 库打不开：装配期没拿到 store */
};

/** 读的时候抛（库被别的连接锁住、文件损坏）：`prepare` 失败就发生在读方法的第一行。 */
const throwingRead = (): never => {
  throw new Error("database is locked");
};

/** 只含一天的账本：库里读不到时，prefix 侧仍该照常交出账本那部分。 */
const prefixLedger = (): RtkLedger => ledgerOf({ days: [ledgerDay(TODAY)], dataStart: OLD });

/** 造一份 service 依赖。 */
const depsOf = (overrides: Partial<InsightsServiceDeps> = {}): InsightsServiceDeps => ({
  store: () => storeOf(),
  ledger: ledgerOf(),
  status: () => STATUS,
  sandboxMode: () => "workspace-write",
  enabledFilters: () => [FILTER_CARGO],
  now: () => NOW,
  ...overrides,
});

/** 用一份现成的库造 service（两层调用分开写，免得嵌太深）。 */
const serviceWithStore = (
  store: FakeStore,
  extra: Partial<InsightsServiceDeps> = {},
): InsightsService => createInsightsService(depsOf({ store: () => store, ...extra }));

/** 某一种账本不可用态下，overview 报出来的 prefix 可用性与原因码。 */
const probeLedger = async (
  availability: "missing" | "unreadable" | "schema",
): Promise<{ readonly seen: string; readonly reason: string }> => {
  const service = createInsightsService(depsOf({ ledger: ledgerOf({ availability }) }));
  const overview = await service.overview();
  return {
    seen: overview.availability.prefix,
    reason: overview.availability.reasons[0] ?? "",
  };
};

const PIPE_REQUEST: InsightsRequest = { form: "pipe", rangeDays: 7, granularity: "day" };
const PREFIX_REQUEST: InsightsRequest = { form: "prefix", rangeDays: 7, granularity: "day" };

describe("overview：今日两形态分开算", () => {
  it("prefix 的计数取插件库、节省量取账本，pipe 各取各的", async () => {
    const store = storeOf({
      prefixDays: [prefixDay(TODAY, { bash_calls: 8, attempts: 6, rewritten: 5 })],
      pipeDays: [pipeDay(TODAY, { bash_calls: 10, compressed: 4 })],
      // 四条事件、四条都是 compressed：与天表的 compressed=4 对齐。两者不一致的形状在真实
      // 数据里不会出现（天表就是事件行累加出来的），写成不一致只会把覆盖率算到 133%。
      pipeEvents: [
        pipeEvent({ id: 1 }),
        pipeEvent({ id: 2 }),
        pipeEvent({ id: 3 }),
        pipeEvent({ id: 4 }),
      ],
      legacy: LEGACY,
    });
    const service = serviceWithStore(store, {
      ledger: ledgerOf({ days: [ledgerDay(TODAY, { input: 2000, saved: 1500 })] }),
    });
    const overview: StatsOverview = await service.overview();
    // prefix：改写 5 次 / bash 8 次 → 覆盖率 62.5%；节省率按账本的 input 2000 算 75%。
    assert.equal(overview.today.prefix.commands, 5);
    assert.equal(overview.today.prefix.savedTokens, 1500);
    assert.equal(overview.today.prefix.savingsPct, 75);
    assert.equal(overview.today.prefix.coveragePct, 62.5);
    // pipe：4/10 = 40%；节省率按插件库 original_tokens 1000 算 80%；attempts 数事件行 4。
    assert.equal(overview.today.pipe.commands, 4);
    assert.equal(overview.today.pipe.savingsPct, 80);
    assert.equal(overview.today.pipe.coveragePct, 100, "4 条候选全部压成");
    assert.equal(overview.today.pipe.attempts, 4);
    assert.deepEqual(overview.availability, { prefix: "ok", pipe: "ok", reasons: [] });
    assert.deepEqual(overview.legacy, LEGACY);
  });

  it("库打不开时 pipe 判 unavailable 并给出可照做的说明，不冒充 0", async () => {
    const service = createInsightsService(depsOf({ store: NO_STORE }));
    const overview = await service.overview();
    assert.equal(overview.availability.pipe, "unavailable");
    assert.equal(overview.today.pipe.commands, 0);
    assert.deepEqual(overview.availability.reasons, ["pipeUnavailable"]);
    // legacy 也跟着缺席（旧账本存在旧 storage domain 里，库打不开就读不到）。
    assert.equal(overview.legacy, null);
  });

  it("强制只读时不读账本，prefix 判 readonly 而不是 missing", async () => {
    const seen: LedgerSeen = { reads: 0, clears: 0 };
    const service = serviceWithStore(
      storeOf({ prefixDays: [prefixDay(TODAY, { rewritten: 3 })] }),
      {
        sandboxMode: () => "read-only",
        ledger: ledgerOf({ days: [ledgerDay(TODAY)] }, seen),
      },
    );
    const overview = await service.overview();
    assert.equal(seen.reads, 0, "只读时不该去打开 rtk 的库");
    assert.equal(overview.availability.prefix, "readonly");
    // 计数照常：改写成没成只有插件库知道，只读不影响它。
    assert.equal(overview.today.prefix.commands, 3);
    // 节省量读不到就给 0，但说明那句话让界面知道这是「不可用」不是「省了 0」。
    assert.equal(overview.today.prefix.savedTokens, 0);
    assert.deepEqual(overview.availability.reasons, ["prefixReadonly"]);
  });

  it("账本的三种非 ok 态各给各的原因码（不合并成一个）", async () => {
    const results = await Promise.all(
      (["missing", "unreadable", "schema"] as const).map((availability) =>
        probeLedger(availability),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.seen),
      ["missing", "unreadable", "schema"],
    );
    // 三种成因在界面上的处置相同（都不显示前置数据），但话不一样，所以码也不一样。
    assert.deepEqual(
      results.map((result) => result.reason),
      ["prefixMissing", "prefixUnreadable", "prefixSchema"],
    );
  });
});

describe("insights：pipe 回声", () => {
  it("totals 的分母各自成立，latency 只认 >0 的样本", async () => {
    const response = await serviceWithStore(pipeStore()).insights(PIPE_REQUEST);
    const { totals } = response;
    assert.equal(totals.bashCalls, 20);
    assert.equal(totals.compressed, 2);
    assert.equal(totals.attempts, 4, "attempts 数事件行，不是天表的 compressed 之和");
    assert.equal(totals.originalTokens, 2000);
    assert.equal(totals.savedTokens, 1600);
    assert.equal(totals.savingsPct, 80);
    assert.equal(totals.coveragePct, 10, "2/20：分母是全窗口 bash 调用数");
    assert.equal(totals.successPct, 50, "2/4：compressed 只数 status=compressed 的事件行");
    // 四条事件的 latency 依次 30 / 90 / 0 / 0：均值只取 >0 的两条 → 60，峰值 90。
    assert.equal(totals.latencyAvgMs, 60);
    assert.equal(totals.latencyMaxMs, 90);
  });

  it("filters / commands / workdirs 按事件分组，空键落 unknown", async () => {
    const response = await serviceWithStore(pipeStore()).insights(PIPE_REQUEST);
    assert.deepEqual(
      response.filters.map((row) => row.name),
      [FILTER_CARGO, FILTER_PYTEST, UNKNOWN],
      "按节省量降序；空 filter 落 unknown 而不是空行",
    );
    assert.deepEqual(
      response.commands.map((row) => row.family),
      [FAMILY_CARGO, FILTER_PYTEST, UNKNOWN],
    );
    assert.deepEqual(
      response.workdirs.map((row) => row.path),
      [WORKDIR_APP, WORKDIR_LIB, UNKNOWN],
    );
    const [top] = response.filters;
    assert.ok(top !== undefined);
    assert.equal(top.savedTokens, 800);
    assert.equal(top.compressed, 1);
    assert.equal(top.lastUsedAt, NOW - 1000);
    // coverage 的分母是全窗口 bash 调用数（20），不是这一组自己的 attempts。
    assert.equal(top.coveragePct, 5);
  });

  it("skipReasons 把同 reason 的多天求和（guard 前缀原样保留）", async () => {
    const response = await serviceWithStore(pipeStore()).insights(PIPE_REQUEST);
    assert.deepEqual(response.skipReasons, [
      { reason: REASON_TOO_SMALL, count: 5 },
      { reason: REASON_GUARD_LOW_GAIN, count: 1 },
    ]);
  });

  it("lastEvent 只取本形态那一条，dataStart 看保留期最早一天", async () => {
    const response = await serviceWithStore(pipeStore()).insights(PIPE_REQUEST);
    const { lastEvent } = response;
    assert.ok(lastEvent !== null);
    assert.equal(lastEvent.form, "pipe");
    assert.equal(lastEvent.commandFamily, FAMILY_CARGO);
    assert.equal(lastEvent.sizeBucket, "small");
    assert.equal(response.dataStart, YESTERDAY);
    assert.deepEqual(response.legacy, LEGACY);
  });

  it("series 按粒度落桶，日粒度按 key 升序（不受输入顺序影响）", async () => {
    const store = storeOf({
      pipeDays: [pipeDay(LAST_WEEK), pipeDay(TODAY)],
      pipeEvents: [pipeEvent({ id: 1, day: LAST_WEEK }), pipeEvent({ id: 2, day: TODAY })],
    });
    const service = serviceWithStore(store);
    const week = await service.insights({ form: "pipe", rangeDays: 90, granularity: "week" });
    assert.deepEqual(
      week.series.map((point) => point.key),
      ["2026-11-02", "2026-11-09"],
      "11-05 落在 11-02 那个周一，11-15 落在 11-09",
    );
    const month = await service.insights({ form: "pipe", rangeDays: 90, granularity: "month" });
    assert.deepEqual(
      month.series.map((point) => point.key),
      ["2026-11"],
    );
    const day = await service.insights({ form: "pipe", rangeDays: 90, granularity: "day" });
    assert.deepEqual(
      day.series.map((point) => point.key),
      [LAST_WEEK, TODAY],
    );
  });

  it("series 的排序自己负责：输入倒序也按 key 升序交出", async () => {
    // 假库按 seed 顺序交出（这里故意今天在前），服务必须自己排——否则横轴的点序会跟着
    // 数据库的返回顺序漂，而 SQL 的 ORDER BY 是另一份实现对同一件事的承诺。
    const store = storeOf({
      pipeDays: [pipeDay(TODAY), pipeDay(LAST_WEEK)],
      pipeEvents: [pipeEvent({ id: 1, day: TODAY }), pipeEvent({ id: 2, day: LAST_WEEK })],
    });
    const response = await serviceWithStore(store).insights({
      form: "pipe",
      rangeDays: 90,
      granularity: "day",
    });
    assert.deepEqual(
      response.series.map((point) => point.key),
      [LAST_WEEK, TODAY],
    );
  });

  it("建议：低收益 filter、启用未命中、未启用但可匹配", async () => {
    // 五条低收益事件（attempts 5、节省率 10%）+ 一个启用但没命中的 filter + 一个可匹配的。
    const lowYield = Array.from({ length: 5 }, (_unused, index) =>
      pipeEvent({
        id: index + 1,
        filter: FILTER_VERBOSE,
        command_family: "cargo build",
        compressed_tokens: 900,
        saved_tokens: 100,
      }),
    );
    const store = storeOf({
      pipeDays: [pipeDay(TODAY, { bash_calls: 5 })],
      pipeEvents: lowYield,
      potential: [{ day: TODAY, filter: "ctest", matches: 3 }],
    });
    const service = serviceWithStore(store, {
      enabledFilters: () => [FILTER_VERBOSE, FILTER_PYTEST],
    });
    const response = await service.insights(PIPE_REQUEST);
    assert.deepEqual(
      response.suggestions.map((item) => `${item.kind}:${item.key}`),
      [
        `low-yield-filter:${FILTER_VERBOSE}`,
        `unused-filter:${FILTER_PYTEST}`,
        "potential-filter:ctest",
      ],
    );
    for (const item of response.suggestions) {
      assert.equal(item.severity, "info");
      // 只给参数、不给句子：界面按 `kind` 查自己的语言包拼（「要改 enabledFilters 那个键」
      // 那句现在是客户端的事，service 里不该再出现一个中文字）。
      assert.ok(item.params.filter !== undefined || item.params.family !== undefined);
    }
  });

  it("样本不足与已启用的 potential 都不出建议（噪声优先于召回）", async () => {
    const store = storeOf({
      pipeDays: [pipeDay(TODAY)],
      // 只有 4 条 < MIN_SAMPLES=5：样本不足时不建议关掉 filter。
      pipeEvents: Array.from({ length: 4 }, (_unused, index) =>
        pipeEvent({ id: index + 1, filter: FILTER_VERBOSE, saved_tokens: 10 }),
      ),
      // 已启用的 filter 即使能匹配也不该再建议「启用它」。
      potential: [{ day: TODAY, filter: FILTER_VERBOSE, matches: 9 }],
    });
    const service = serviceWithStore(store, {
      // 只启用 `verbose`：样本不足所以不出低收益建议、命中过所以不出「未命中」建议、
      // 已在启用名单里所以不出「该启用它」建议——三条判据同时被否掉，剩下的才是空表。
      enabledFilters: () => [FILTER_VERBOSE],
    });
    const response = await service.insights(PIPE_REQUEST);
    assert.deepEqual(response.suggestions, []);
  });
});

/**
 * 一份带两天、三行命令、两个目录的账本。
 *
 * 放在模块级而不是 describe 里：它不捕获用例闭包里的任何变量，放在里面会被
 * `unicorn(consistent-function-scoping)` 判成该提未提。
 */
const prefixService = (): InsightsService => {
  const store = storeOf({
    prefixDays: [prefixDay(YESTERDAY), prefixDay(TODAY)],
    prefixReasons: [reasonRow(TODAY, "deny-table", 2), reasonRow(YESTERDAY, "vitest-version", 1)],
    lastEvents: [lastEventRow({ form: "prefix", status: "rewritten", reason: "rewritten" })],
  });
  return serviceWithStore(store, {
    ledger: ledgerOf({
      days: [ledgerDay(YESTERDAY), ledgerDay(TODAY, { input: 4000, saved: 3000 })],
      commands: [
        ledgerCommand({ original_cmd: "cargo test --all", commands: 3, saved: 900, input: 1000 }),
        ledgerCommand({ original_cmd: "cargo test -p a", commands: 2, saved: 600, input: 1000 }),
        ledgerCommand({ original_cmd: FAMILY_GIT, commands: 1, saved: 0, input: 500 }),
      ],
      workdirs: [ledgerWorkdir(), ledgerWorkdir({ project_path: WORKDIR_LIB, saved: 100 })],
      dataStart: OLD,
    }),
  });
};

describe("insights：prefix 回声", () => {
  it("计数来自插件库、token 来自账本，filters 恒空", async () => {
    const response = await prefixService().insights(PREFIX_REQUEST);
    assert.deepEqual(response.filters, [], "prefix 没有 filter 这一层");
    assert.equal(response.totals.bashCalls, 16);
    assert.equal(response.totals.attempts, 12);
    assert.equal(response.totals.compressed, 10);
    assert.equal(response.totals.originalTokens, 6000);
    assert.equal(response.totals.savedTokens, 4500);
    assert.equal(response.totals.savingsPct, 75);
    assert.equal(response.totals.coveragePct, 62.5);
    assert.equal(response.totals.successPct, 83.33);
    assert.equal(response.totals.latencyAvgMs, 20, "100ms / 5 次 + 100ms / 5 次 的平均");
    assert.equal(response.totals.latencyMaxMs, 0, "日表没留峰值，给 0 而不是拿均值冒充");
    // 两行 `cargo test …` 必须并成一个家族，且按节省量降序。
    assert.deepEqual(
      response.commands.map((row) => row.family),
      [FAMILY_CARGO, FAMILY_GIT],
    );
    const [cargo] = response.commands;
    assert.ok(cargo !== undefined);
    assert.equal(cargo.commands, 5);
    assert.equal(cargo.savedTokens, 1500);
    assert.equal(cargo.coveragePct, 0, "账本不知道 bash 调用数，给 0 不编一个");
    assert.deepEqual(
      response.workdirs.map((row) => row.path),
      [WORKDIR_APP, WORKDIR_LIB],
    );
    assert.deepEqual(response.skipReasons, [
      { reason: "deny-table", count: 2 },
      { reason: "vitest-version", count: 1 },
    ]);
    assert.equal(response.lastEvent?.status, "rewritten");
    assert.equal(response.dataStart, OLD, "dataStart 取账本的，不是窗口起点");
  });

  it("低收益命令家族的阈值：commands≥5 且加权节省率<30%", async () => {
    const service = serviceWithStore(storeOf({ prefixDays: [prefixDay(TODAY)] }), {
      ledger: ledgerOf({
        commands: [
          // 5 次、节省率 10% → 建议。
          ledgerCommand({ original_cmd: "cargo build", commands: 5, input: 1000, saved: 100 }),
          // 5 次、节省率 90% → 不建议。
          ledgerCommand({ original_cmd: FAMILY_GIT, commands: 5, input: 1000, saved: 900 }),
          // 4 次、节省率 0% → 样本不足，不建议。
          ledgerCommand({ original_cmd: "rg foo", commands: 4, input: 1000, saved: 0 }),
        ],
      }),
    });
    const response = await service.insights(PREFIX_REQUEST);
    assert.deepEqual(
      response.suggestions.map((item) => `${item.kind}:${item.key}`),
      ["low-yield-command:cargo build"],
    );
  });

  it("只读时账本为空，但计数仍在", async () => {
    const seen: LedgerSeen = { reads: 0, clears: 0 };
    const service = serviceWithStore(
      storeOf({ prefixDays: [prefixDay(TODAY, { rewritten: 5 })] }),
      {
        sandboxMode: () => "read-only",
        ledger: ledgerOf({ days: [ledgerDay(TODAY)], dataStart: OLD }, seen),
      },
    );
    const response = await service.insights(PREFIX_REQUEST);
    assert.equal(seen.reads, 0);
    assert.equal(response.availability.prefix, "readonly");
    assert.equal(response.totals.compressed, 5);
    assert.equal(response.totals.savedTokens, 0);
    assert.equal(response.dataStart, null);
  });
});

describe("库打不开时的读面（store === undefined）", () => {
  it("pipe 回执给空表，而不是抛异常", async () => {
    const service = createInsightsService(depsOf({ store: NO_STORE }));
    const response = await service.insights(PIPE_REQUEST);
    assert.equal(response.availability.pipe, "unavailable");
    assert.deepEqual(response.series, []);
    assert.deepEqual(response.filters, []);
    assert.deepEqual(response.commands, []);
    assert.deepEqual(response.workdirs, []);
    assert.deepEqual(response.skipReasons, []);
    assert.equal(response.lastEvent, null);
    assert.equal(response.dataStart, null);
    // 没有任何 filter 命中过，所以也不该凭空建议「启用某个 filter」——启用名单在库缺席时按空算。
    assert.deepEqual(response.suggestions, []);
  });

  it("prefix 回执同样给空表（账本照常读，它不依赖插件库）", async () => {
    const service = createInsightsService(depsOf({ store: NO_STORE, ledger: prefixLedger() }));
    const response = await service.insights(PREFIX_REQUEST);
    assert.equal(response.availability.pipe, "unavailable");
    assert.equal(response.dataStart, OLD, "dataStart 来自账本，不是插件库");
    assert.deepEqual(response.skipReasons, []);
    assert.equal(response.lastEvent, null);
    // 日表读不到，所以计数是 0——但 token 仍在：它们来自账本。
    assert.equal(response.totals.bashCalls, 0);
    assert.equal(response.totals.savedTokens, 1500);
  });
});

describe("库读得出来但读的时候抛", () => {
  it("读面把异常折成空窗口，并留一行说明为什么空", async () => {
    const warns: string[] = [];
    const store = storeOf({ pipeDays: [pipeDay(TODAY)], pipeEvents: [pipeEvent()] });
    // 库被别人锁住或文件坏了：`prepare` 这一步就会抛，而它发生在每个读方法的第一行。
    const broken: typeof store = {
      ...store,
      readPipeDays: throwingRead,
      readPipeEvents: throwingRead,
      readLastEventOf: throwingRead,
    };
    const service = serviceWithStore(broken, {
      warn: (line) => {
        warns.push(line);
      },
    });
    const response = await service.insights(PIPE_REQUEST);
    assert.deepEqual(response.series, [], "读不出来时给空窗口，不把异常抛给 Remote 调用方");
    assert.deepEqual(response.filters, []);
    assert.equal(response.lastEvent, null);
    // 同一次请求里同一张表会被读两遍（今日那格 + 整个窗口），所以按「说出了哪几种失败」判，
    // 不按行数判——行数取决于调用路径，钉住它等于把实现细节写进断言。
    const said = [
      ...new Set(
        warns.map((line) => /cannot read (?<what>.+?) \(/u.exec(line)?.groups?.["what"] ?? line),
      ),
    ];
    assert.deepEqual(said.toSorted(), ["pipe days", "pipe events", "the last event"]);
  });

  it("没给 warn 时安静地降级（部署侧可以只要空窗口）", async () => {
    const store = storeOf({ pipeDays: [pipeDay(TODAY)] });
    const broken: typeof store = {
      ...store,
      readPipeDays: () => {
        throw new Error("database is locked");
      },
    };
    const service = serviceWithStore(broken);
    const response = await service.insights(PIPE_REQUEST);
    assert.deepEqual(response.series, []);
    assert.equal(response.totals.bashCalls, 0);
  });
});

describe("边界取舍", () => {
  it("prefix 日表没有延迟样本时均值给 0（不是 NaN）", async () => {
    const service = serviceWithStore(
      // latency_count 全 0：网关没给计时，此时算平均会得到 NaN。
      storeOf({ prefixDays: [prefixDay(TODAY, { latency_ms_sum: 0, latency_count: 0 })] }),
    );
    const response = await service.insights(PREFIX_REQUEST);
    assert.equal(response.totals.latencyAvgMs, 0);
    assert.equal(response.totals.latencyMaxMs, 0);
  });
});

describe("reset 与 status", () => {
  it("reset 清两份账本，并把清零后的概览交回去", async () => {
    const seen: LedgerSeen = { reads: 0, clears: 0 };
    const store = storeOf({ pipeDays: [pipeDay(TODAY)] });
    const service = serviceWithStore(store, { ledger: ledgerOf({}, seen) });
    const after = await service.reset();
    assert.equal(store.resetCalls(), 1);
    assert.equal(seen.clears, 1);
    assert.equal(after.today.pipe.commands, 0);
  });

  it("任一步失败都只落在对应形态的可用性上，不抛给调用方", async () => {
    const service = serviceWithStore(storeOf(), {
      ledger: {
        read: () =>
          Promise.resolve({
            availability: "ok",
            days: [],
            commands: [],
            workdirs: [],
            dataStart: null,
            failures: { total: 0, recovered: 0 },
            oversized: 0,
            recall: { entries: 0, bytes: 0 },
          }),
        clear: () => Promise.reject(new Error("只读账本")),
      },
    });
    const after = await service.reset();
    // 两份账本各自 try：账本清不掉时 pipe 侧照常给出清零后的概览。
    assert.equal(after.today.pipe.commands, 0);
    assert.equal(after.availability.pipe, "ok");
  });

  it("status 原样透传（不缓存版本）", () => {
    let version = "1.2.3";
    const service = createInsightsService(
      depsOf({ status: () => ({ ...STATUS, rtkVersion: version }) }),
    );
    assert.equal(service.status().rtkVersion, "1.2.3");
    version = "1.3.0";
    assert.equal(service.status().rtkVersion, "1.3.0");
  });
});

describe("回执的请求位原样带回", () => {
  it("form / rangeDays / granularity 与请求一致（页面据此选横轴）", async () => {
    const service = createInsightsService(depsOf());
    const request: InsightsRequest = { form: "pipe", rangeDays: 30, granularity: "month" };
    const response: InsightsResponse = await service.insights(request);
    assert.equal(response.form, "pipe");
    assert.equal(response.rangeDays, 30);
    assert.equal(response.granularity, "month");
  });
});
