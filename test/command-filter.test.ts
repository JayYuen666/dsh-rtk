// lib/command-filter.ts 单测：命令形态 → rtk pipe filter 的对照表。
//
// 这张表只服务 B 形态（`rtk pipe -f <filter>`），与 C 形态的命令范围无关——C 的范围由
// `rtk rewrite` 的输出定义。B 形态默认关闭，但表与测试全部保留，等官方补齐 vitest 5
// 之类的缺口后可以直接打开。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  ALL_FILTERS,
  DEFAULT_ENABLED_FILTERS,
  PIPE_TABLE,
  filterOf,
} from "../lib/command-filter.ts";

// 启用集合装的是 **rtk filter 名**（`enabledFilters` 在 Config 里的就是这些），不是行 id：
// 生产路径把它原样传进来，所以判据必须是「这行的 filter 在不在集合里」。
// 四行共用 `vitest` 是有意的——它们是四个入口，同一个过滤器。
const CARGO_FILTER = "cargo-test";
const KNOWN = new Set([
  CARGO_FILTER,
  "pytest",
  "go-test",
  "go-build",
  "ctest",
  "tsc",
  "vitest",
  "grep",
  "find",
  "git-log",
  "git-diff",
  "git-status",
  "mypy",
  "ruff-check",
  "ruff-format",
]);

const ALL = new Set(PIPE_TABLE.map((entry) => entry.filter));
const CARGO_TEST = "cargo test";
const TEST_SCRIPT = "test";

describe("all filters", () => {
  it("是 PIPE_TABLE 的去重排序名单，供卡片提示展示完整可用名", () => {
    assert.deepEqual(ALL_FILTERS, [...new Set(PIPE_TABLE.map((entry) => entry.filter))].toSorted());
    assert.deepEqual(new Set(ALL_FILTERS), ALL);
    // 名单必须比默认启用集合宽：只列默认三项就是原提示的问题。
    assert.ok(ALL_FILTERS.length > DEFAULT_ENABLED_FILTERS.length);
  });
});

describe("filterOf", () => {
  it("cargo test → cargo-test", () => {
    assert.equal(filterOf(CARGO_TEST, ALL), CARGO_FILTER);
  });

  it("pnpm test → vitest", () => {
    assert.equal(filterOf("pnpm test", ALL), "vitest");
  });

  it("npm test → vitest", () => {
    assert.equal(filterOf(`npm ${TEST_SCRIPT}`, ALL), "vitest");
  });

  it("yarn test → vitest", () => {
    assert.equal(filterOf("yarn test", ALL), "vitest");
  });

  it("python -m pytest → pytest", () => {
    assert.equal(filterOf("python -m pytest", ALL), "pytest");
  });

  it("npx tsc → tsc", () => {
    assert.equal(filterOf("npx tsc --noEmit", ALL), "tsc");
  });

  it("git diff → git-diff", () => {
    assert.equal(filterOf("git diff HEAD~1", ALL), "git-diff");
  });

  it("未命中表返回 undefined", () => {
    assert.equal(filterOf("python gen.py", ALL), undefined);
    assert.equal(filterOf("cat x.py", ALL), undefined);
  });

  it("prettier 永久不入表（rtk 对它伪造成功）", () => {
    assert.equal(filterOf("prettier --check .", ALL), undefined);
  });

  it("filter 未启用则 undefined", () => {
    assert.equal(filterOf(CARGO_TEST, new Set()), undefined);
    assert.equal(filterOf(CARGO_TEST, new Set(["pytest"])), undefined);
  });

  it("启用的是 filter 名而不是行 id（Config 传进来的就是 filter 名）", () => {
    assert.equal(filterOf(CARGO_TEST, new Set([CARGO_FILTER])), CARGO_FILTER);
    // 行 id 是 `cargo test`，把它当 key 传进来必须不生效——否则 Config 与表会各说一套。
    assert.equal(filterOf(CARGO_TEST, new Set([CARGO_TEST])), undefined);
  });

  it("首词边界：cargo testing 不命中", () => {
    assert.equal(filterOf("cargo testing", ALL), undefined);
  });

  it("前导空白不影响匹配", () => {
    assert.equal(filterOf(`   ${CARGO_TEST}`, ALL), CARGO_FILTER);
  });
});

/** 每行至少一条能命中它的命令：期望值**独立写死**，不从表里的 `id` / `pattern` 推。 */
const SAMPLES: readonly (readonly [string, string])[] = [
  ["cargo test", CARGO_FILTER],
  ["cargo test -- --nocapture", CARGO_FILTER],
  ["pytest -q", "pytest"],
  ["python -m pytest", "pytest"],
  ["python3 -m pytest tests/", "pytest"],
  ["ctest --output-on-failure", "ctest"],
  ["vitest run", "vitest"],
  ["npx vitest run", "vitest"],
  ["pnpm exec vitest run", "vitest"],
  ["pnpm test", "vitest"],
  ["npm test", "vitest"],
  ["yarn test", "vitest"],
  ["go test ./...", "go-test"],
  ["go build ./...", "go-build"],
  ["tsc --noEmit", "tsc"],
  ["npx tsc", "tsc"],
  ["mypy src", "mypy"],
  ["ruff check .", "ruff-check"],
  ["ruff format .", "ruff-format"],
  ["git log --oneline", "git-log"],
  ["git diff HEAD~1", "git-diff"],
  ["git status", "git-status"],
  ["grep -rn foo .", "grep"],
  ["rg -n foo", "grep"],
  ["find . -name '*.ts'", "find"],
  ["fd -e ts", "find"],
];

describe("表的每一行都真的能命中（期望值独立写死，不从 pattern 推）", () => {
  it.each(SAMPLES)("%s → %s", (command, filter) => {
    // 早先这条判据缺席：`ALL` 是从表自己派生的集合，于是把任意几行的 pattern 改成
    // `/^NEVERMATCH/u` 之后 `filterOf` 全回 undefined、测试仍旧全绿——用表验表。
    // 现在每个 filter 名至少有一条**手写**命令样本，改坏任何一行的正则都会有一条红。
    assert.equal(filterOf(command, new Set([filter])), filter);
  });

  it("每个 filter 名都至少有一条样本（新增行必须同时补样本）", () => {
    const covered = new Set(SAMPLES.map(([, filter]) => filter));
    for (const filter of KNOWN) {
      assert.ok(covered.has(filter), `${filter} 没有任何手写样本`);
    }
  });
});

describe("表结构与默认值", () => {
  it("表内每个 filter 都在已知名单里", () => {
    for (const entry of PIPE_TABLE) {
      assert.ok(KNOWN.has(entry.filter), entry.filter);
    }
  });

  it("默认启用集合恰三个 filter（v3.5 起 vitest 不在其中）", () => {
    // 期望值是**独立写死**的一份，不从表里筛：早先这条用 `PIPE_TABLE.filter(defaultEnabled)`
    // 自比，改一行表它就跟着改，用户看到的默认集合却由 schema 另写一份字面量决定。
    assert.deepEqual([...DEFAULT_ENABLED_FILTERS].toSorted(), [CARGO_FILTER, "ctest", "pytest"]);
    // 默认集合里的每个 filter 都必须在表里有一行，否则「默认开」的开关永远命中不到任何命令。
    for (const filter of DEFAULT_ENABLED_FILTERS) {
      assert.ok(
        PIPE_TABLE.some((entry) => entry.filter === filter),
        `${filter} 在默认集合里但表里没有对应行`,
      );
    }
  });

  it("表共 18 条", () => {
    assert.equal(PIPE_TABLE.length, 18);
  });

  it("id 唯一", () => {
    assert.equal(new Set(PIPE_TABLE.map((entry) => entry.id)).size, PIPE_TABLE.length);
  });

  it("vitest 行保留但不在默认集合里", () => {
    const row = PIPE_TABLE.find((entry) => entry.filter === "vitest");

    assert.ok(row !== undefined);
    assert.equal(DEFAULT_ENABLED_FILTERS.includes("vitest"), false);
  });

  it("duplicate filter 允许（三行 npm/pnpm/yarn test 共用 vitest）", () => {
    const vitestRows = PIPE_TABLE.filter((entry) => entry.filter === "vitest");

    assert.equal(vitestRows.length, 4);
  });
});
