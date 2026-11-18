// lib/insights-shape.ts 单测：三份 schema 的接受/拒绝面。
//
// 关键事实：这些 schema 是宿主与客户端的**唯一契约**。宿主用它们 parse 自己的投影，
// 客户端用它们 parse 线上回执——两边任何一侧放宽，都会让另一端拿到它不认识的数据。
// 所以这里既验「好数据能过」，也逐条验「坏数据必须被拒」，拒绝面比接受面更重要。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { z } from "zod";
import {
  InsightsRequestSchema,
  InsightsResponseSchema,
  StatsOverviewSchema,
} from "../lib/insights-shape.ts";
import { EMPTY_LEGACY_ACCUMULATOR, LEGACY_ACCUMULATOR_SCHEMA } from "../lib/legacy-stats.ts";

type Response = z.infer<typeof InsightsResponseSchema>;
type Today = Response["today"]["prefix"];

const PIPE = "pipe";
const CARGO_TEST = "cargo test";
const CARGO_FILTER = "cargo-test";
const REPO = "/repo";
const DAY = "2026-11-15";

const TODAY: Today = {
  commands: 1,
  savedTokens: 2,
  savingsPct: 50,
  compressed: 1,
  attempts: 1,
  coveragePct: 100,
};

const ROW = {
  commands: 1,
  attempts: 1,
  compressed: 1,
  originalTokens: 4,
  compressedTokens: 2,
  savedTokens: 2,
  savingsPct: 50,
  coveragePct: 100,
  latencyAvgMs: 3,
  lastUsedAt: 1,
};

/** 一个能通过 parse 的完整回执；用例只在它上面改一位。 */
function response(): Response {
  return {
    form: PIPE,
    rangeDays: 30,
    granularity: "day",
    availability: { prefix: "ok", pipe: "ok", reasons: [] },
    today: { prefix: TODAY, pipe: TODAY },
    totals: {
      bashCalls: 1,
      attempts: 1,
      compressed: 1,
      originalTokens: 4,
      compressedTokens: 2,
      savedTokens: 2,
      savingsPct: 50,
      coveragePct: 100,
      successPct: 100,
      latencyAvgMs: 3,
      latencyMaxMs: 3,
    },
    series: [
      {
        key: DAY,
        commands: 1,
        bashCalls: 1,
        attempts: 1,
        compressed: 1,
        originalTokens: 4,
        compressedTokens: 2,
        savedTokens: 2,
        savingsPct: 50,
        coveragePct: 100,
      },
    ],
    filters: [{ name: CARGO_FILTER, ...ROW }],
    commands: [{ family: CARGO_TEST, ...ROW }],
    workdirs: [{ path: REPO, commands: 1, savedTokens: 2, savingsPct: 50 }],
    skipReasons: [{ reason: "too-small", count: 1 }],
    lastEvent: {
      ts: 1,
      form: PIPE,
      status: "skipped",
      reason: "too-small",
      commandFamily: CARGO_TEST,
      filter: CARGO_FILTER,
      workdir: REPO,
      sizeBucket: "small",
    },
    suggestions: [
      {
        kind: "low-yield-filter",
        key: CARGO_FILTER,
        severity: "info",
        params: { filter: CARGO_FILTER, days: 7, attempts: 6, compressed: 6, savingsPct: 12 },
      },
    ],
    legacy: null,
    dataStart: DAY,
  };
}

describe("insights request schema", () => {
  it("接受三档 rangeDays × 三种 granularity", () => {
    for (const rangeDays of [7, 30, 90]) {
      for (const granularity of ["day", "week", "month"]) {
        const ok = InsightsRequestSchema.safeParse({ form: PIPE, rangeDays, granularity });
        assert.equal(ok.success, true, `${String(rangeDays)}/${granularity} 应当被接受`);
      }
    }
  });

  it("拒绝未知 form / 越界 rangeDays / 未知 granularity / 缺字段", () => {
    const bad = [
      { form: "x", rangeDays: 7, granularity: "day" },
      { form: PIPE, rangeDays: 10, granularity: "day" },
      { form: PIPE, rangeDays: 7, granularity: "hour" },
      { form: PIPE, rangeDays: 7 },
      {},
    ];
    for (const each of bad) {
      assert.equal(InsightsRequestSchema.safeParse(each).success, false);
    }
  });
});

describe("insights response schema", () => {
  it("接受完整回执并保持字段", () => {
    const parsed = InsightsResponseSchema.parse(response());
    assert.equal(parsed.series[0]?.key, DAY);
    assert.equal(parsed.filters[0]?.name, CARGO_FILTER);
    assert.equal(parsed.commands[0]?.family, CARGO_TEST);
    assert.equal(parsed.lastEvent?.sizeBucket, "small");
    assert.equal(parsed.dataStart, DAY);
  });

  it("lastEvent 与 legacy 都可以是 null", () => {
    const clean = { ...response(), lastEvent: null, legacy: null };
    assert.equal(InsightsResponseSchema.parse(clean).lastEvent, null);
  });

  it("拒绝未知 availability 状态（布尔化会把「怎么修」丢掉）", () => {
    const raw = response();
    const broken = {
      ...raw,
      availability: { ...raw.availability, prefix: "broken" },
    };
    assert.equal(InsightsResponseSchema.safeParse(broken).success, false);
  });

  it("拒绝负数与小数计数", () => {
    const raw = response();
    const negative = { ...raw, totals: { ...raw.totals, attempts: -1 } };
    assert.equal(InsightsResponseSchema.safeParse(negative).success, false);
    const fraction = { ...raw, totals: { ...raw.totals, bashCalls: 1.5 } };
    assert.equal(InsightsResponseSchema.safeParse(fraction).success, false);
  });

  it("拒绝未知的 suggestion kind 与 severity", () => {
    const raw = response();
    const suggestion = { key: CARGO_FILTER, label: CARGO_FILTER, detail: "d" };
    const kind = {
      ...raw,
      suggestions: [{ ...suggestion, kind: "maybe", severity: "info" }],
    };
    assert.equal(InsightsResponseSchema.safeParse(kind).success, false);
    const severity = {
      ...raw,
      suggestions: [{ ...suggestion, kind: "low-yield-filter", severity: "fatal" }],
    };
    assert.equal(InsightsResponseSchema.safeParse(severity).success, false);
  });

  it("拒绝缺字段的 lastEvent", () => {
    const broken = { ...response(), lastEvent: { ts: 1, form: PIPE } };
    assert.equal(InsightsResponseSchema.safeParse(broken).success, false);
  });
});

describe("stats overview schema", () => {
  it("只含今日、可用性与旧账本", () => {
    const full = response();
    const overview = {
      today: full.today,
      availability: full.availability,
      legacy: full.legacy,
    };
    assert.equal(StatsOverviewSchema.parse(overview).today.prefix.commands, 1);
  });

  it("把完整回执当 overview 时多出的键被剥离（不是拒）", () => {
    const parsed = StatsOverviewSchema.parse(response());
    assert.equal(Object.hasOwn(parsed, "totals"), false);
  });
});

describe("legacy accumulator schema", () => {
  it("缺 token 两列按 0 补齐（域版本 1 的迁移通道）", () => {
    const old = {
      commands: 2,
      originalBytes: 100,
      compressedBytes: 40,
      byFilter: { [CARGO_FILTER]: { commands: 2, savedBytes: 60 } },
      byForm: { prefix: 1, pipe: 1 },
    };
    const parsed = LEGACY_ACCUMULATOR_SCHEMA.parse(old);
    assert.equal(parsed.originalTokens, 0);
    assert.equal(parsed.compressedTokens, 0);
    assert.equal(parsed.byFilter[CARGO_FILTER]?.savedTokens, 0);
  });

  it("空账本常量自身能通过 schema", () => {
    assert.equal(LEGACY_ACCUMULATOR_SCHEMA.parse(EMPTY_LEGACY_ACCUMULATOR).commands, 0);
  });

  it("拒绝缺 byForm 的记录", () => {
    const broken = {
      commands: 1,
      originalBytes: 1,
      compressedBytes: 1,
      byFilter: {},
    };
    assert.equal(LEGACY_ACCUMULATOR_SCHEMA.safeParse(broken).success, false);
  });
});
