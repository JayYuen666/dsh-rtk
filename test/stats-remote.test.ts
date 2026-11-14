// test/stats-remote.test.ts —— 两侧契约。宿主侧用**标准装饰器**声明端点，客户端
// `src/stats-reader.ts` **手写**同一枚 descriptor；两处分叉时卡片不报错，只会「读不到」。
// 所以本文件既钉注册路，也钉宿主真件写下的标记（`remoteMethods()`）。
import assert from "node:assert/strict";

import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { describe, it } from "vitest";

import { RTK_STATS_SERVICE_KEY, installStatsRemote } from "../lib/stats-remote.ts";
import { createStatsStore } from "../lib/stats-store.ts";
import type { StatsAccumulator } from "../lib/stats-shape.ts";
import type { StatsStore, StatsTable } from "../lib/stats-store.ts";

const table = (): StatsTable => {
  let stored: StatsAccumulator | undefined;
  return {
    get: () => stored,
    put: async (_key, value) => {
      stored = value;
    },
  };
};

interface Deps {
  readonly store: StatsStore;
  readonly status: () => {
    rtkPath: string;
    rtkVersion: string;
    supported: boolean;
    enabled: boolean;
    forms: string[];
  };
}

const deps = (): Deps => {
  const store = createStatsStore(table());
  store.accumulate({
    form: "pipe",
    filter: "cargo-test",
    originalBytes: 1000,
    compressedBytes: 100,
    originalTokens: 500,
    compressedTokens: 50,
  });
  return {
    store,
    status: () => ({
      rtkPath: "/opt/homebrew/bin/rtk",
      rtkVersion: "1.2.3",
      supported: true,
      enabled: true,
      forms: ["prefix"],
    }),
  };
};

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

describe("真 Context：注册与标记", () => {
  it("服务键注册上，三个方法都被 @Remote 标记", () => {
    const ctx = new Context();
    assert.equal(installStatsRemote(ctx, deps()), true);
    const raw: unknown = ctx.get(RTK_STATS_SERVICE_KEY, false);
    assert.ok(typeof raw === "object" && raw !== null, "服务没注册到 RTK_STATS_SERVICE_KEY 上");
    // 标记的方法名集合写死，不从实现派生：漏标一个端点的症状是那张卡片永久「读不到」。
    assert.deepEqual(
      remoteMethods(raw).map((marker) => marker.method),
      ["summary", "status", "reset"],
    );
  });

  it("status() 与 summary() 读活值，不是构造时的快照", () => {
    const ctx = new Context();
    const subject = deps();
    installStatsRemote(ctx, subject);
    const service = ctx.get(RTK_STATS_SERVICE_KEY, false) as {
      summary: () => { commands: number };
      status: () => { rtkVersion: string | null };
    };
    assert.equal(service.summary().commands, 1);
    subject.store.accumulate({
      form: "pipe",
      filter: "pytest",
      originalBytes: 500,
      compressedBytes: 50,
      originalTokens: 250,
      compressedTokens: 25,
    });
    assert.equal(service.summary().commands, 2, "summary 必须现读 store，不能在构造时固定");
  });
});

describe("三个端点", () => {
  it("status 读的是 status() 回调的当下回执，不是构造时快照", () => {
    const ctx = new Context();
    let version = "1.2.3";
    const subject = deps();
    installStatsRemote(ctx, {
      store: subject.store,
      status: () => ({
        rtkPath: "/opt/homebrew/bin/rtk",
        rtkVersion: version,
        supported: true,
        enabled: true,
        forms: ["prefix"],
      }),
    });
    const service = ctx.get(RTK_STATS_SERVICE_KEY, false) as {
      status: () => { rtkVersion: string | null };
    };
    assert.equal(service.status().rtkVersion, "1.2.3");
    version = "1.3.0";
    assert.equal(service.status().rtkVersion, "1.3.0", "status 必须现读回调，不能缓存");
  });

  it("reset 清零并把清零后的快照交回去（省客户端一次往返）", async () => {
    const ctx = new Context();
    const subject = deps();
    installStatsRemote(ctx, subject);
    const service = ctx.get(RTK_STATS_SERVICE_KEY, false) as {
      reset: () => Promise<{ commands: number; savedBytes: number }>;
    };
    const after = await service.reset();
    assert.equal(after.commands, 0);
    assert.equal(after.savedBytes, 0);
    // 返回值不是「清零前的账」：它必须是 reset 之后现读的那一份。
    assert.equal(subject.store.summary().commands, 0);
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
      const warnings = captureWarnings(() => installStatsRemote(ctx, deps()));
      assert.deepEqual(warnings, [], `畸形上下文 ${JSON.stringify(ctx)} 不该报警`);
    }
    assert.equal(installStatsRemote({}, deps()), false);
  });

  it("注册口抛错时也只返回 false，不把异常交给调用方", () => {
    const ctx = {
      reflect: {
        provide: () => {
          throw new Error("service key taken");
        },
      },
    } as unknown as Context;
    const warnings = captureWarnings(() => installStatsRemote(ctx, deps()));
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
    assert.equal(installStatsRemote(ctx, deps()), true);
    assert.deepEqual(provided, ["rtkStats"]);
  });
});
