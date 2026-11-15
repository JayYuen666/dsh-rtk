// 客户端读面的单测：remote 现读、挂载缓存、失败后重试、线上结果拆包。
//
// 替身只实现 `RemoteHost` 的 `get` 一位（官方 `Context["get"]` 的最小投影），
// 按名字查表——**不用 `??` 兜底**：`{ remote: null }` 要表达的是「remote 在场但形状不对」，
// 用 `??` 会把它悄悄换成可用替身，于是「坏形状」那一支再也测不到。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { PACKAGE_NAME, STATS_DESCRIPTORS, createStatsReader } from "../src/stats-reader.ts";
import type { RemoteHost } from "../src/stats-reader.ts";

/** 网关给命名空间注册的服务键（与 src/stats-reader.ts 的 `remote.<namespace>` 同源）。 */
const SERVICE_KEY = "remote.rtkStats";

/** 一份形状正确的线上结果。 */
function ok<Value>(value: Value): { ok: true; value: Value } {
  return { ok: true, value };
}

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
  setRemote: (next: unknown) => void;
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
    setRemote: (next) => {
      remote = next;
      services.set("remote", next);
    },
    setNamespace: (next) => {
      namespace = next;
      services.set(SERVICE_KEY, next);
    },
  };
}

/** 一份形状完整的投影（`statsSummarySchema` 十个字段）。**不能只写部分字段**：
 *  读取器对线上回执跑 schema，缺字段会被 `parseOrThrow` 当场点名为 `expected number, received undefined`
 *  ——那正是「读到坏形状就报错、不硬转」这条设计的可见面。 */
function summaryOf(
  commands: number,
  savedBytes: number,
): {
  commands: number;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  savingsPct: number;
  byFilter: Record<string, { commands: number; savedBytes: number; savedTokens: number }>;
  byForm: { prefix: number; pipe: number };
  topFilters: readonly {
    filter: string;
    commands: number;
    savedTokens: number;
    sharePct: number;
  }[];
} {
  return {
    commands,
    originalBytes: savedBytes + 10,
    compressedBytes: 10,
    savedBytes,
    // token 两列刻意与字节取不同的数：两套账填同一个数时，「按 token 算」与「按字节算」
    // 在断言里长得一模一样。
    originalTokens: savedBytes / 2 + 5,
    compressedTokens: 5,
    savedTokens: savedBytes / 2,
    savingsPct: 0,
    byFilter: {},
    byForm: { prefix: 0, pipe: 1 },
    topFilters: [],
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
    rtkVersion: "rtk 1.2.0",
    supported: true,
    enabled,
    forms: ["prefix"],
  };
}

/** 命名空间替身：三个方法各回一条线上结果。 */
function namespaceOf(values: {
  summary?: unknown;
  status?: unknown;
  reset?: unknown;
  summaryFails?: boolean;
}): Record<string, () => Promise<unknown>> {
  return {
    summary: () =>
      Promise.resolve(
        values.summaryFails === true
          ? { ok: false, error: { code: "boom", message: "网关拒绝" } }
          : ok(values.summary),
      ),
    status: () => Promise.resolve(ok(values.status)),
    reset: () => Promise.resolve(ok(values.reset)),
  };
}

describe("descriptor 与常量", () => {
  it("三条 descriptor 的 id / service / namespace / method 两两对应，全部无参一元", () => {
    assert.equal(STATS_DESCRIPTORS.length, 3);
    for (const descriptor of STATS_DESCRIPTORS) {
      assert.equal(descriptor.id, `${PACKAGE_NAME}#rtkStats/${descriptor.method}`);
      assert.equal(descriptor.service, "rtkStats");
      assert.equal(descriptor.namespace, "rtkStats");
      assert.equal(descriptor.parameters.length, 0);
      assert.deepEqual(descriptor.invocation, { kind: "direct" });
      assert.deepEqual(descriptor.result, { mode: "src-json" });
    }
    assert.deepEqual(
      STATS_DESCRIPTORS.map((entry) => entry.method),
      ["summary", "status", "reset"],
    );
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
  it("命名空间晚到时先报错、到场后同一个读取器就能用（读取不钉死在 apply 期）", async () => {
    // 显式给 `undefined` 而不是不给：不给会落进默认值 `{}`，那是个合法记录，
    // 报出来的就是 `namespace.summary is not a function`，"命名空间缺席"这一支反而不被测。
    const { host, setNamespace } = hostOf({ namespace: undefined });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.summary(), /remote namespace remote\.rtkStats is missing/u);
    setNamespace(namespaceOf({ summary: summaryOf(1, 2) }));
    const summary = await reader.summary();
    assert.deepEqual(summary, summaryOf(1, 2));
  });

  it("$mount 只跑一次（成功结论被缓存），三个方法复用同一份挂载", async () => {
    const { host, mountCalls } = hostOf({
      namespace: namespaceOf({
        summary: summaryOf(1, 0),
        status: statusOf(true),
        reset: summaryOf(0, 0),
      }),
    });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await reader.summary();
    await reader.status();
    await reader.reset();
    assert.equal(mountCalls(), 1);
  });

  it("并发调用只挂载一次（同一个 promise 被两处 await）", async () => {
    const { host, mountCalls } = hostOf({
      namespace: namespaceOf({ summary: summaryOf(1, 0) }),
    });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    const [first, second] = await Promise.all([reader.summary(), reader.summary()]);
    assert.deepEqual(first, summaryOf(1, 0));
    assert.deepEqual(second, summaryOf(1, 0));
    assert.equal(mountCalls(), 1);
  });

  it("挂载失败不缓存 rejected promise：第二次调用会重新挂载并成功", async () => {
    const failure = new Error("gateway restarted");
    const { host, mountCalls } = hostOf({
      mounts: [failure, { mounted: true }],
      namespace: namespaceOf({ summary: summaryOf(3, 0) }),
    });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.summary(), /gateway restarted/u);
    const summary = await reader.summary();
    assert.deepEqual(summary, summaryOf(3, 0));
    assert.equal(mountCalls(), 2);
  });

  it("$mount 在位但命名空间缺席时报错，点名服务键", async () => {
    const { host } = hostOf({ namespace: 42 });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.summary(), /remote namespace remote\.rtkStats is missing/u);
  });

  it("remote 在场但不是 mounter（缺 $mount）时报「通道不可用」，不炸在类型上", async () => {
    const { host } = hostOf({ remote: { $mount: 42 } });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.status(), /remote channel is not available/u);
  });
});

describe("读取器：线上结果拆包", () => {
  it("result.ok 为真时交回 value", async () => {
    const { host } = hostOf({ namespace: namespaceOf({ status: statusOf(false) }) });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    assert.deepEqual(await reader.status(), statusOf(false));
  });

  it("命名空间少了 descriptor 声明的方法时点名方法（版本错配不会变成 undefined is not a function）", async () => {
    const { host } = hostOf({ namespace: { status: () => Promise.resolve(ok({})) } });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.summary(), /has no method summary/u);
  });

  it("result.ok 为假时把 code 与 message 一起抛出来（不吞成因）", async () => {
    const { host } = hostOf({ namespace: namespaceOf({ summaryFails: true }) });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.summary(), /boom: 网关拒绝/u);
  });

  it("线上回执不是记录（标量 / 数组）时报 wire result 错误，不把 42 当回执拆", async () => {
    const { host } = hostOf({ namespace: { summary: () => Promise.resolve(42) } });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.summary(), /did not return a wire result/u);
  });

  it("线上回执是记录但不合 schema 时点名缺哪个字段（读到坏形状就报错，不硬转）", async () => {
    // 少了 savedBytes / savingsPct / byFilter 三个：跨版本时网关可能只回旧形状。
    const { host } = hostOf({
      namespace: {
        summary: () => Promise.resolve(ok({ commands: 1, originalBytes: 10, compressedBytes: 2 })),
      },
    });
    const reader = createStatsReader(host);
    assert.ok(reader !== undefined);
    await assert.rejects(() => reader.summary(), /savedBytes/u);
  });
});
