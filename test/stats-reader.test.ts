// 客户端读面的单测：remote 现读、挂载缓存、失败后重试、线上结果拆包、带参端点的 codec。
//
// 命名空间替身由官方 `@deepseek-ai/dsh-remote-mock` 承载（端点表 + 调用日志 + 漏配断言），
// 适配层把读取器的调用转发给 `mock.dispatch`；`RemoteHost` 的 `get` 与 `$mount` 两位仍是
// 手写替身——那两位测的是读取器自己的投影契约（按名查表、挂载缓存），不是远端协议，
// 官方 mock 也不实现 `$mount`。查表**不用 `??` 兜底**：`{ remote: null }` 要表达的是
// 「remote 在场但形状不对」，用 `??` 会把它悄悄换成可用替身，坏形状那一支就测不到了。
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { RemoteMock, ok } from "@deepseek-ai/dsh-remote-mock";
import { PACKAGE_NAME, STATS_DESCRIPTORS, createStatsReader } from "../src/stats-reader.ts";
import type { RemoteHost } from "../src/stats-reader.ts";
import type { InsightsRequest } from "../lib/insights-shape.ts";

/** 网关给命名空间注册的服务键（与 src/stats-reader.ts 的 `remote.<namespace>` 同源）。 */
const SERVICE_KEY = "remote.rtkStats";

/** 复用的字面量。 */
const NAMESPACE = "rtkStats";
const METHODS = ["overview", "insights", "status", "reset"] as const;
const CARGO_FILTER = "cargo-test";
const CARGO_FAMILY = "cargo test";
const MISSING_NAMESPACE = /remote namespace remote\.rtkStats is missing/u;
const REQUEST: InsightsRequest = { form: "pipe", rangeDays: 7, granularity: "day" };

/** 可编程替身：`remote` 与命名空间各自可换、`$mount` 结局可逐次给。 */
interface StubOptions {
  readonly withGet?: boolean;
  readonly remote?: unknown;
  readonly namespace?: unknown;
  readonly mounts?: readonly unknown[];
}

function hostOf(options: StubOptions = {}): {
  host: RemoteHost;
  mountCalls: () => number;
  setNamespace: (next: unknown) => void;
} {
  let remote: unknown = "remote" in options ? options.remote : {};
  let namespace: unknown = "namespace" in options ? options.namespace : {};
  const mounts = options.mounts ?? [{ mounted: true }];
  if (mounts.length === 0) {
    // 空数组不是「没配结局」的合法表达：`at(min(i, -1))` 会交回 undefined，
    // `$mount` 于是「成功」返回 undefined，用例越写越离谱反而越绿。
    throw new Error("mounts 不能是空数组：至少给一条结局（成功就写 { mounted: true }）");
  }
  const mountCalls: number[] = [];
  const mounter = {
    $mount: (): Promise<unknown> => {
      mountCalls.push(1);
      const outcome = mounts.at(Math.min(mountCalls.length - 1, mounts.length - 1));
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
  // 未显式给 remote 时用一个可用的 mounter（默认走成功路径）。
  if (!("remote" in options)) {
    remote = mounter;
  }
  const services = new Map<string, unknown>([
    ["remote", remote],
    [SERVICE_KEY, namespace],
  ]);
  const host: RemoteHost = options.withGet === false ? {} : { get: (name) => services.get(name) };
  return {
    host,
    mountCalls: () => mountCalls.length,
    setNamespace: (next) => {
      namespace = next;
      services.set(SERVICE_KEY, next);
    },
  };
}

/** 今日六个数（`FormTodaySchema`）。 */
interface Today {
  commands: number;
  savedTokens: number;
  savingsPct: number;
  compressed: number;
  attempts: number;
  coveragePct: number;
}

function todayOf(commands: number): Today {
  return {
    commands,
    savedTokens: commands * 10,
    savingsPct: 50,
    compressed: commands,
    attempts: commands,
    coveragePct: 100,
  };
}

/** 一份形状完整的概览（`StatsOverviewSchema` 三个字段）。**不能只写部分字段**：
 *  读取器对线上回执跑 schema，缺字段会被 `parseOrThrow` 当场点名为
 *  `expected number, received undefined` ——那正是「读到坏形状就报错、不硬转」的可见面。 */
interface Overview {
  today: { prefix: Today; pipe: Today };
  availability: { prefix: string; pipe: string; reasons: readonly never[] };
  legacy: null;
}

function overviewOf(commands: number): Overview {
  return {
    today: { prefix: todayOf(commands), pipe: todayOf(commands * 2) },
    availability: { prefix: "ok", pipe: "ok", reasons: [] },
    legacy: null,
  };
}

/** 一行 filter 明细（十一项 + name）。 */
function filterOf(name: string, savedTokens: number): Record<string, unknown> {
  return {
    name,
    commands: 3,
    attempts: 3,
    compressed: 3,
    originalTokens: 900,
    compressedTokens: 300,
    savedTokens,
    savingsPct: 66.67,
    coveragePct: 30,
    latencyAvgMs: 40,
    lastUsedAt: 1,
  };
}

/** 一份形状完整的 Insights 回执（十六个字段，含两个可空位与 `rtkSelf` 那三个数）。 */
function insightsOf(request: InsightsRequest): Record<string, unknown> {
  const today = todayOf(1);
  return {
    form: request.form,
    rangeDays: request.rangeDays,
    granularity: request.granularity,
    availability: { prefix: "ok", pipe: "ok", reasons: [] },
    today: { prefix: today, pipe: today },
    totals: {
      bashCalls: 10,
      attempts: 4,
      compressed: 2,
      originalTokens: 1000,
      compressedTokens: 200,
      savedTokens: 800,
      savingsPct: 80,
      coveragePct: 20,
      successPct: 50,
      latencyAvgMs: 30,
      latencyMaxMs: 90,
    },
    series: [],
    filters: [],
    commands: [],
    workdirs: [],
    skipReasons: [],
    lastEvent: null,
    suggestions: [],
    legacy: null,
    dataStart: null,
    rtkSelf: { parseFailures: 0, recovered: 0, oversized: 0, recallEntries: 0, recallBytes: 0 },
  };
}

/** 同样完整的运行时状态（`statsStatusSchema` 五个字段，`supported` 不许省）。 */
function statusOf(enabled: boolean): {
  rtkPath: string | null;
  rtkVersion: string | null;
  supported: boolean | null;
  enabled: boolean;
  forms: string[];
} {
  return {
    rtkPath: "/opt/homebrew/bin/rtk",
    rtkVersion: "rtk 1.2.1",
    supported: true,
    enabled,
    forms: ["prefix"],
  };
}

/** RemoteMock 承载的命名空间替身：只把给出的方法挂成端点规则，四个方法位照常全部在表
 * （适配层无条件转发）——读取器调到没给值的那一位时 `dispatch` 找不到规则会抛「no rule」
 * 并把这次调用记成 unmatched，`afterEach` 的 `assertNoUnmatched` 当场点名，不会静默落成
 * `ok(undefined)`。失败回执没有官方构造器（导出面只有 `ok`），保持字面量。 */
interface NamespaceValues {
  readonly overview?: unknown;
  readonly insights?: unknown;
  readonly status?: unknown;
  readonly reset?: unknown;
  readonly overviewFails?: boolean;
}

/** 本文件造出的全部 mock：用 mock 的每组用例在 afterEach 里逐个跑漏配断言
 * （lint 的 `require-top-level-describe` / `require-hook` 不收顶层钩子与包装函数）。 */
const remoteMocks: RemoteMock[] = [];

/** 该组用例造出的 mock 逐个跑漏配断言；有漏配即整组红。 */
function assertNoMissedRules(): void {
  for (const mock of remoteMocks.splice(0)) {
    mock.assertNoUnmatched();
  }
}

function namespaceOf(values: NamespaceValues): {
  namespace: Record<string, (...args: readonly unknown[]) => Promise<unknown>>;
  mock: RemoteMock;
} {
  const mock = RemoteMock.create();
  remoteMocks.push(mock);
  const answers: Record<string, unknown> = {
    overview:
      values.overviewFails === true
        ? { ok: false, error: { code: "boom", message: "网关拒绝" } }
        : ok(values.overview),
    insights: ok(values.insights),
    status: ok(values.status),
    reset: ok(values.reset),
  };
  const namespace: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = {};
  // 转发 `dispatch` 而不是直调 `mock.remote.*`：只有 dispatch 走的调用进 MockLog，
  // `log.calls` 断言与 `assertNoUnmatched` 才覆盖得到读取器的真实调用。
  for (const method of METHODS) {
    namespace[method] = (...args: readonly unknown[]) =>
      mock.dispatch(`${NAMESPACE}/${method}`, args);
  }
  for (const method of METHODS) {
    // `overviewFails` 是 overview 的失败回执旗标：它给值时 overview 也算「给过」。
    const isProvided = method in values || (method === "overview" && values.overviewFails === true);
    if (isProvided) {
      mock.unary(`${NAMESPACE}/${method}`, answers[method]);
    }
  }
  return { namespace, mock };
}

describe("descriptor 与常量", () => {
  it("四条 descriptor 的 id / service / namespace / method 两两对应", () => {
    assert.equal(STATS_DESCRIPTORS.length, 4);
    for (const descriptor of STATS_DESCRIPTORS) {
      assert.equal(descriptor.id, `${PACKAGE_NAME}#${NAMESPACE}/${descriptor.method}`);
      assert.equal(descriptor.service, NAMESPACE);
      assert.equal(descriptor.namespace, NAMESPACE);
      assert.deepEqual(descriptor.invocation, { kind: "direct" });
      assert.deepEqual(descriptor.result, { mode: "src-json" });
    }
    assert.deepEqual(
      STATS_DESCRIPTORS.map((entry) => entry.method),
      [...METHODS],
    );
  });

  it("只有 insights 带参，且那一枚是 strict codec（网关的硬要求）", () => {
    const withParams = STATS_DESCRIPTORS.filter((entry) => entry.parameters.length > 0);
    assert.deepEqual(
      withParams.map((entry) => entry.method),
      ["insights"],
    );
    const [parameter] = withParams[0]?.parameters ?? [];
    assert.ok(parameter !== undefined);
    assert.equal(parameter.name, "request");
    assert.equal(parameter.wire, "request");
    assert.equal(parameter.source, "json");
    assert.equal(parameter.codec.mode, "strict");
  });

  it("codec 的身份串按 `<包名>#<语义名>` 命名，且 parse 拒绝坏请求", () => {
    const [parameter] = STATS_DESCRIPTORS[1]?.parameters ?? [];
    assert.ok(parameter !== undefined);
    const { codec } = parameter;
    // 收窄成 strict 那一支才能读 `create`：联合里的 `src-json` 支没有它。
    if (codec.mode !== "strict") {
      assert.fail("insights 的入参 codec 必须是 strict");
    }
    assert.equal(codec.typeSymbol, `${PACKAGE_NAME}#insights-request`);
    const parser = codec.create();
    assert.deepEqual(parser.parse(REQUEST), REQUEST);
    // 三个字段各错一个：form / rangeDays / granularity，再加一个空对象。
    assert.throws(() => parser.parse({ ...REQUEST, form: "both" }), /form/u);
    assert.throws(() => parser.parse({ ...REQUEST, rangeDays: 10 }), /rangeDays/u);
    assert.throws(() => parser.parse({ ...REQUEST, granularity: "hour" }), /granularity/u);
    assert.throws(() => parser.parse({}), /form/u);
  });
});

describe("createStatsReader", () => {
  it("ctx 连 get 面都没有时返回 undefined（卡片照常渲染，统计区显示未连接）", () => {
    assert.equal(createStatsReader({}), undefined);
  });

  it("有 get 面就给读取器——remote 是否在场不在 apply 期判", () => {
    const { host } = hostOf();
    assert.notEqual(createStatsReader(host), undefined);
  });
});

describe("读取器：remote 现读与挂载缓存", () => {
  afterEach(assertNoMissedRules);

  it("命名空间晚到时先报错、到场后同一个读取器就能用（读取不钉死在 apply 期）", async () => {
    // 显式给 `undefined` 而不是不给：不给会落进默认值 `{}`，那是个合法记录，
    // 报出来的就是 `namespace.overview is not a function`，"命名空间缺席"这一支反而不被测。
    const { host, setNamespace } = hostOf({ namespace: undefined });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.overview(), MISSING_NAMESPACE);
    const late = namespaceOf({ overview: overviewOf(1) });
    setNamespace(late.namespace);
    const overview = await reader.overview();
    assert.deepEqual(overview, overviewOf(1));
  });

  it("$mount 只跑一次（成功结论被缓存），四个方法复用同一份挂载", async () => {
    const { namespace } = namespaceOf({
      overview: overviewOf(1),
      insights: insightsOf(REQUEST),
      status: statusOf(true),
      reset: overviewOf(0),
    });
    const { host, mountCalls } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await reader.overview();
    await reader.insights(REQUEST);
    await reader.status();
    await reader.reset();
    assert.equal(mountCalls(), 1);
  });

  it("并发调用只挂载一次（同一个 promise 被两处 await）", async () => {
    const { namespace } = namespaceOf({ overview: overviewOf(1) });
    const { host, mountCalls } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    const [first, second] = await Promise.all([reader.overview(), reader.overview()]);
    assert.deepEqual(first, overviewOf(1));
    assert.deepEqual(second, overviewOf(1));
    assert.equal(mountCalls(), 1);
  });

  it("挂载失败不缓存 rejected promise：第二次调用会重新挂载并成功", async () => {
    const failure = new Error("gateway restarted");
    const { namespace } = namespaceOf({ overview: overviewOf(3) });
    const { host, mountCalls } = hostOf({
      mounts: [failure, { mounted: true }],
      namespace,
    });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.overview(), /gateway restarted/u);
    const overview = await reader.overview();
    assert.deepEqual(overview, overviewOf(3));
    assert.equal(mountCalls(), 2);
  });

  it("$mount 在位但命名空间缺席时报错，点名服务键", async () => {
    const { host } = hostOf({ namespace: 42 });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.overview(), MISSING_NAMESPACE);
  });

  it("remote 在场但不是 mounter（缺 $mount）时报「通道不可用」，不炸在类型上", async () => {
    const { host } = hostOf({ remote: { $mount: 42 } });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.status(), /remote channel is not available/u);
  });
});

describe("读取器：带参端点", () => {
  afterEach(assertNoMissedRules);

  it("insights 把请求原样发给命名空间，解包后过 schema 交回", async () => {
    const { namespace, mock } = namespaceOf({ insights: insightsOf(REQUEST) });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    const response = await reader.insights(REQUEST);
    assert.deepEqual(
      mock.log.calls(`${NAMESPACE}/insights`).map((call) => call.args),
      [[REQUEST]],
      "实参就是调用方给的那个对象，读取器不替它补字段",
    );
    assert.equal(response.form, REQUEST.form);
    assert.equal(response.rangeDays, REQUEST.rangeDays);
    assert.equal(response.granularity, REQUEST.granularity);
    assert.equal(response.totals.savedTokens, 800);
  });

  it("无参方法一个实参都不传（空数组也不传）", async () => {
    const { namespace, mock } = namespaceOf({ overview: overviewOf(1) });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await reader.overview();
    assert.deepEqual(
      mock.log.calls(`${NAMESPACE}/overview`).map((call) => call.args),
      [[]],
    );
  });

  it("线上回执坏形状时点名缺哪个字段（读到坏形状就报错，不硬转）", async () => {
    // 只给请求位、没有 availability/totals：跨版本时网关可能只回旧形状。
    const { namespace } = namespaceOf({ insights: { ...REQUEST } });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.insights(REQUEST), /availability|totals/u);
  });
});

describe("读取器：线上结果拆包", () => {
  afterEach(assertNoMissedRules);

  it("result.ok 为真时交回 value", async () => {
    const { namespace } = namespaceOf({ status: statusOf(false) });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    assert.deepEqual(await reader.status(), statusOf(false));
  });

  it("命名空间少了 descriptor 声明的方法时点名方法（版本错配不会变成 undefined is not a function）", async () => {
    const { host } = hostOf({ namespace: { status: () => Promise.resolve(ok({})) } });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.overview(), /has no method overview/u);
  });

  it("result.ok 为假时把 code 与 message 一起抛出来（不吞成因）", async () => {
    const { namespace } = namespaceOf({ overviewFails: true });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.overview(), /boom: 网关拒绝/u);
  });

  it("线上回执不是记录（标量 / 数组）时报 wire result 错误，不把 42 当回执拆", async () => {
    const { host } = hostOf({ namespace: { overview: () => Promise.resolve(42) } });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.overview(), /did not return a wire result/u);
  });

  it("概览回执合 schema 但字段类型不对时点名字段", async () => {
    const broken = { ...overviewOf(1), today: { prefix: 1, pipe: 2 } };
    const { namespace } = namespaceOf({ overview: broken });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.overview(), /today/u);
  });

  it("reset 交回的是概览形状（不是旧的 summary）", async () => {
    const { namespace } = namespaceOf({ reset: overviewOf(0) });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    const after = await reader.reset();
    assert.equal(after.today.pipe.commands, 0);
    assert.deepEqual(after.availability, { prefix: "ok", pipe: "ok", reasons: [] });
  });
});

describe("读取器：明细行两套键", () => {
  afterEach(assertNoMissedRules);

  it("filters 行按 name 归组，值原样过 schema", async () => {
    const filters = [filterOf(CARGO_FILTER, 600)];
    const { namespace } = namespaceOf({ insights: { ...insightsOf(REQUEST), filters } });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    const response = await reader.insights(REQUEST);
    assert.equal(response.filters.length, 1);
    const [row] = response.filters;
    assert.ok(row !== undefined);
    assert.equal(row.name, CARGO_FILTER);
    assert.equal(row.savedTokens, 600);
  });

  it("commands 行按 family 归组（表头不能沿用 name）", async () => {
    const commands = [{ ...filterOf(CARGO_FAMILY, 600), family: CARGO_FAMILY }];
    const { namespace } = namespaceOf({ insights: { ...insightsOf(REQUEST), commands } });
    const { host } = hostOf({ namespace });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    const response = await reader.insights(REQUEST);
    const [row] = response.commands;
    assert.ok(row !== undefined);
    assert.equal(row.family, CARGO_FAMILY);
    assert.equal(Object.hasOwn(row, "name"), false, "commands 行不该留 name 这一位");
  });
});
