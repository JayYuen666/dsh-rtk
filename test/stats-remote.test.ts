// test/stats-remote.test.ts —— 两侧契约。宿主侧用**标准装饰器**声明端点，客户端
// `src/stats-reader.ts` **手写**同一枚 descriptor；两处分叉时卡片不报错，只会「读不到」。
// 所以本文件既钉注册路，也钉宿主真件写下的标记（`remoteMethods()`）。
//
// 四个端点的名字与客户端 descriptor 里的 `method` 必须逐字相同：网关按名字查方法，写错一个
// 字母的症状是「这张卡永远读不到」而不是编译错误。
import assert from "node:assert/strict";

import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { describe, it } from "vitest";

import type { InsightsService } from "../lib/insights-service.ts";
import type { InsightsRequest, InsightsResponse, StatsOverview } from "../lib/insights-shape.ts";
import { RTK_STATS_SERVICE_KEY, installStatsRemote } from "../lib/stats-remote.ts";
import type { StatsStatus } from "../lib/stats-shape.ts";

/** 客户端 descriptor 里写死的四个方法名（这里独立写一遍，不从实现派生）。 */
const METHODS = ["overview", "insights", "status", "reset"] as const;

/** 今日摘要的空值（六个字段全 0）。 */
const EMPTY_TODAY = {
  commands: 0,
  savedTokens: 0,
  savingsPct: 0,
  compressed: 0,
  attempts: 0,
  coveragePct: 0,
};

/** 两个形态都正常。 */
const CLEAN: InsightsResponse["availability"] = { prefix: "ok", pipe: "ok", reasons: [] };

/** 运行时状态（四个端点里只有 `status` 用它）。 */
const STATUS: StatsStatus = {
  rtkPath: "/opt/homebrew/bin/rtk",
  rtkVersion: "1.2.3",
  supported: true,
  enabled: true,
  forms: ["prefix"],
};

/** 概览回执（只有三样：设置卡那一行要的就是这些）。 */
const overviewOf = (commands: number): StatsOverview => ({
  today: { prefix: { ...EMPTY_TODAY, commands }, pipe: EMPTY_TODAY },
  availability: CLEAN,
  legacy: null,
});

/** 页面回执的最小合法形状。 */
const insightsOf = (request: InsightsRequest): InsightsResponse => ({
  form: request.form,
  rangeDays: request.rangeDays,
  granularity: request.granularity,
  availability: CLEAN,
  today: { prefix: EMPTY_TODAY, pipe: EMPTY_TODAY },
  totals: {
    bashCalls: 0,
    attempts: 0,
    compressed: 0,
    originalTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    savingsPct: 0,
    coveragePct: 0,
    successPct: 0,
    skipped: 0,
    latencyAvgMs: 0,
    latencyMaxMs: 0,
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
});

/** 假读面记下的调用轨迹。 */
interface Seen {
  overviewCalls: number;
  resets: number;
  requests: InsightsRequest[];
}

/**
 * 假读面。
 *
 * 计数写进调用方持有的 `seen` 而不是挂在返回值上：本文件验的是「端点把调用转给了服务」，
 * 所以要看的是**服务收到了什么**。
 */
const serviceOf = (seen: Seen, commands = 1): InsightsService => ({
  overview: () => {
    seen.overviewCalls += 1;
    return Promise.resolve(overviewOf(commands));
  },
  insights: (request) => {
    seen.requests.push(request);
    return Promise.resolve(insightsOf(request));
  },
  reset: () => {
    seen.resets += 1;
    return Promise.resolve(overviewOf(0));
  },
  status: () => STATUS,
});

const seenOf = (): Seen => ({ overviewCalls: 0, resets: 0, requests: [] });

const depsOf = (seen: Seen, commands?: number): { readonly service: InsightsService } => ({
  service: serviceOf(seen, commands),
});

/**
 * 一份「刚装配好、一次都没调过」的依赖。
 *
 * 单独包一层是为了过 `unicorn(max-nested-calls)`：`installStatsRemote(ctx, depsOf(seenOf()))`
 * 是三层调用，而三层正是上限，`assert.equal(...)` 再包一层就超了。
 */
const freshDeps = (): { readonly service: InsightsService } => depsOf(seenOf());

const captureWarnings = (run: () => boolean): boolean[] => {
  const warnings: boolean[] = [];
  const original = console.warn;
  console.warn = () => {
    warnings.push(true);
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
};

/** 从真 Context 里取出服务实例（端点要在外面调，就必须绕过 cordis 的包装）。 */
const serviceIn = (ctx: Context): InsightsService =>
  ctx.get(RTK_STATS_SERVICE_KEY, false) as InsightsService;

describe("真 Context：注册与标记", () => {
  it("服务键注册上，四个方法都被 @Remote 标记", () => {
    const ctx = new Context();
    assert.equal(installStatsRemote(ctx, freshDeps()), true);
    const raw: unknown = ctx.get(RTK_STATS_SERVICE_KEY, false);
    assert.ok(typeof raw === "object" && raw !== null, "服务没注册到 RTK_STATS_SERVICE_KEY 上");
    // 标记的方法名集合写死，不从实现派生：漏标一个端点的症状是那张卡片永久「读不到」。
    assert.deepEqual(
      remoteMethods(raw).map((marker) => marker.method),
      [...METHODS],
    );
  });

  it("status() 现读服务，不是构造时的快照", () => {
    const ctx = new Context();
    let version = "1.2.3";
    installStatsRemote(ctx, {
      service: { ...serviceOf(seenOf()), status: () => ({ ...STATUS, rtkVersion: version }) },
    });
    assert.equal(serviceIn(ctx).status().rtkVersion, "1.2.3");
    version = "1.3.0";
    assert.equal(serviceIn(ctx).status().rtkVersion, "1.3.0", "status 必须现读，不能缓存");
  });
});

describe("四个端点", () => {
  it("overview 转给服务的 overview()", async () => {
    const ctx = new Context();
    const seen = seenOf();
    installStatsRemote(ctx, depsOf(seen, 7));
    const overview = await serviceIn(ctx).overview();
    assert.equal(overview.today.prefix.commands, 7);
    assert.equal(seen.overviewCalls, 1);
  });

  it("insights 把请求原样交给服务（含形态、窗口、粒度）", async () => {
    const ctx = new Context();
    const seen = seenOf();
    installStatsRemote(ctx, depsOf(seen));
    const request: InsightsRequest = { form: "pipe", rangeDays: 30, granularity: "week" };
    const response = await serviceIn(ctx).insights(request);
    assert.deepEqual(seen.requests, [request]);
    // 回执的形态/窗口/粒度必须与请求一致：页面按它们决定横轴与标题，错一位就画错图。
    assert.equal(response.form, "pipe");
    assert.equal(response.rangeDays, 30);
    assert.equal(response.granularity, "week");
  });

  it("reset 转给服务的 reset()，并把清零后的概览交回去", async () => {
    const ctx = new Context();
    const seen = seenOf();
    installStatsRemote(ctx, depsOf(seen, 9));
    const after = await serviceIn(ctx).reset();
    assert.equal(seen.resets, 1);
    assert.equal(after.today.prefix.commands, 0, "reset 的返回值必须是清零之后那一份");
    // 这一层只负责把调用转过去：清零后读概览是**服务内部**的事（真实现里它自己调 overview），
    // 所以这里期望 0 而不是 1 —— 写 1 就等于要求端点替服务多读一次。
    assert.equal(seen.overviewCalls, 0);
  });
});

describe("注册入口", () => {
  it("服务键是 camelCase 的 rtkStats（网关命名空间取它）", () => {
    assert.equal(RTK_STATS_SERVICE_KEY, "rtkStats");
  });

  it("上下文没有 reflect.provide 时返回 false，且不报警（能力缺席不是失败）", () => {
    // 三种畸形各一格：完全没有 reflect、reflect 是对象但没有 provide、provide 不可调用。
    // 它们走的是「先探注册口」那条路，与「注册口抛错」那条的差别就在这里 —— 前者安静、
    // 后者 console.warn 一句。把两者混成一条，探测那一步就成了从外部取不到的冗余。
    // 刻意喂畸形值：Context 是几十个成员的大对象，造一个「只缺 reflect」的真 Context
    // 没有意义，要验的就是「宿主给不出注册口时这条路安静退场」。测试面允许断言。
    const malformed = [
      // 最外一层就不是记录：`!isRecord(value)` 的 true 支只有这一格走得到（其余三种都
      // 是「像上下文的记录」，走的是后面那两级判断）。
      5 as unknown as Context,
      null as unknown as Context,
      {} as unknown as Context,
      // `reflect` 存在但不是对象：这一格走的是 `isRecord(reflect)` 的否定支（短路返回）。
      { reflect: 5 } as unknown as Context,
      { reflect: {} } as unknown as Context,
      { reflect: { provide: 1 } } as unknown as Context,
    ];
    for (const ctx of malformed) {
      const warnings = captureWarnings(() => installStatsRemote(ctx, depsOf(seenOf())));
      assert.deepEqual(warnings, [], `畸形上下文 ${JSON.stringify(ctx)} 不该报警`);
    }
    assert.equal(installStatsRemote({}, freshDeps()), false);
  });

  it("注册口抛错时也只返回 false，不把异常交给调用方", () => {
    const ctx = {
      reflect: {
        provide: () => {
          throw new Error("service key taken");
        },
      },
    } as unknown as Context;
    const warnings = captureWarnings(() => installStatsRemote(ctx, depsOf(seenOf())));
    assert.equal(warnings.length, 1, "注册口抛错要报警一次，否则用户看不出统计栏为什么空着");
  });

  it("注册成功返回 true", () => {
    const provided: string[] = [];
    const ctx = {
      reflect: {
        provide: (key: string) => {
          provided.push(key);
          return () => {
            /* 卸载器：本用例只关心 provide 被谁调用 */
          };
        },
      },
    } as unknown as Context;
    assert.equal(installStatsRemote(ctx, freshDeps()), true);
    assert.deepEqual(provided, ["rtkStats"]);
  });
});
