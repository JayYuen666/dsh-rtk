// lib/command-filter.ts 单测：命令形态 → rtk pipe filter 的对照表。
//
// 这张表只服务 B 形态（`rtk pipe -f <filter>`）的查表这一步，与 C 形态的命令范围无关——
// C 的范围由 `rtk rewrite` 的输出定义。查到 filter 之后由谁压是另一件事：`vitest` 那一路
// 不 spawn rtk，改由 `lib/vitest-strip.ts` 本地删通过行（见 `host.ts` 的 `modeOf`）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  ALL_FILTERS,
  DEFAULT_ENABLED_FILTERS,
  HOOK_FILTER,
  PIPE_TABLE,
  WINDOW_FILTER,
  filterOf,
} from "../lib/command-filter.ts";

// 启用集合装的是 **rtk filter 名**（`enabledFilters` 在 Config 里的就是这些），不是行 id：
// 生产路径把它原样传进来，所以判据必须是「这行的 filter 在不在集合里」。
// 四行共用 `vitest` 是有意的——它们是四个入口，同一个过滤器。
const CARGO_FILTER = "cargo-test";
// 新默认集里出现三次的那个字面量：单独成常量，测试读起来也更清楚。
const GIT_LOG = "git-log";
const GIT_DIFF = "git-diff";
const GIT_STATUS = "git-status";
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
  GIT_LOG,
  GIT_DIFF,
  GIT_STATUS,
  "mypy",
  "ruff-check",
  "ruff-format",
  "phpunit",
  "pest",
  WINDOW_FILTER,
]);

const ALL = new Set(PIPE_TABLE.map((entry) => entry.filter));
const CARGO_TEST = "cargo test";
const TEST_SCRIPT = "test";

describe("all filters", () => {
  it("是表里的名字加本包自带的两档，供卡片提示展示完整可用名", () => {
    // 期望值独立写出（不从 PIPE_TABLE 派生）：派生写法会让「表少一行」与「名单少一项」
    // 一起绿，而这两件事的后果不同——前者是查表失效，后者是卡片上勾不回来。
    assert.deepEqual(ALL_FILTERS, [...new Set([...ALL, WINDOW_FILTER, HOOK_FILTER])].toSorted());
    // 表里出现的每个名字都在名单里：这张名单是「能写进 enabledFilters 的全部取值」。
    for (const filter of ALL) {
      assert.ok(ALL_FILTERS.includes(filter), `${filter} 必须在可选名单里`);
    }
    // 两个不在表里的那一档也必须在：用户取消勾选之后要能勾回来。
    assert.ok(ALL_FILTERS.includes(WINDOW_FILTER), "window 必须在可选名单里");
    assert.ok(ALL_FILTERS.includes(HOOK_FILTER), "hook 必须在可选名单里");
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
    assert.equal(filterOf("git diff HEAD~1", ALL), GIT_DIFF);
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
  ["git log --oneline", GIT_LOG],
  ["git diff HEAD~1", GIT_DIFF],
  ["git status", "git-status"],
  ["grep -rn foo .", "grep"],
  ["rg -n foo", "grep"],
  ["find . -name '*.ts'", "find"],
  ["fd -e ts", "find"],
  ["phpunit", "phpunit"],
  ["vendor/bin/phpunit --testsuite Unit", "phpunit"],
  ["pest", "pest"],
  ["vendor/bin/paratest --parallel", "pest"],
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
      // `window` 不在表里，因此也没有命令样本——它由 `isLogTarget` 判，不由 pattern 判。
      // 样本那一列证明的是「pattern 写对了」，而 window 没有 pattern 可证。
      if (filter === WINDOW_FILTER) {
        assert.ok(!covered.has(filter), "window 不该有样本：它没有 pattern");
      } else {
        assert.ok(covered.has(filter), `${filter} 没有任何手写样本`);
      }
    }
  });
});

describe("表结构与默认值", () => {
  it("表内每个 filter 都在已知名单里", () => {
    for (const entry of PIPE_TABLE) {
      assert.ok(KNOWN.has(entry.filter), entry.filter);
    }
  });

  it("默认启用集合是交不出压缩的那五项 + vitest + window + hook（后三者由本包自己做）", () => {
    // 期望值是**独立写死**的一份，不从表里筛：早先这条用 `PIPE_TABLE.filter(defaultEnabled)`
    // 自比，改一行表它就跟着改，用户看到的默认集合却由 schema 另写一份字面量决定。
    //
    // 为什么多了一个 `vitest`：`pnpm test` / `npm test` / `yarn test` 是**前缀层改不动**的
    // 三种形态（rtk 的规则要求显式 `run`，实测 `pnpm test` rc=1），而它那一路的压缩现在
    // 由本包在内存里删 `✓` 通过行完成（`host.ts` 的 `modeOf`），不再依赖 rtk 的解析器。
    assert.deepEqual([...DEFAULT_ENABLED_FILTERS].toSorted(), [
      "find",
      GIT_DIFF,
      GIT_LOG,
      GIT_STATUS,
      "grep",
      HOOK_FILTER,
      "vitest",
      WINDOW_FILTER,
    ]);
    // 默认集合里的每个 filter 都必须在表里有一行，否则「默认开」的开关永远命中不到任何命令。
    // `window` 与 `hook` 是例外：它们不是 rtk filter，分别由 `host.ts` 的 `isLogTarget` 与
    // `options.hook()` 判定，没有（也不该有）表行——这条例外写在这里，免得有人把它们当漏登记补进去。
    for (const filter of DEFAULT_ENABLED_FILTERS) {
      if (filter === WINDOW_FILTER || filter === HOOK_FILTER) {
        assert.equal(
          PIPE_TABLE.some((entry) => entry.filter === filter),
          false,
          `${filter} 不该有表行：它没有命令形态前缀，靠另两条判据路由`,
        );
      } else {
        assert.ok(
          PIPE_TABLE.some((entry) => entry.filter === filter),
          `${filter} 在默认集合里但表里没有对应行`,
        );
      }
    }
  });

  it("表共 20 条", () => {
    assert.equal(PIPE_TABLE.length, 20);
  });

  it("id 唯一", () => {
    assert.equal(new Set(PIPE_TABLE.map((entry) => entry.id)).size, PIPE_TABLE.length);
  });

  it("vitest 的四行共用同一个 filter 名，且都在默认集合里", () => {
    // 四个入口（直接跑、三种包管理器的裸 test）落同一个 filter：启用集合里只有一个字符串，
    // 用户勾一次就覆盖四种形态。行 id 与 filter 名不是一一对应，这里把两边都钉住。
    const ids = PIPE_TABLE.filter((entry) => entry.filter === "vitest").map((entry) => entry.id);

    assert.deepEqual(ids.toSorted(), ["npm test", "pnpm test", "vitest", "yarn test"]);
    assert.equal(DEFAULT_ENABLED_FILTERS.includes("vitest"), true);
  });

  it("duplicate filter 允许（三行 npm/pnpm/yarn test 共用 vitest）", () => {
    const vitestRows = PIPE_TABLE.filter((entry) => entry.filter === "vitest");

    assert.equal(vitestRows.length, 4);
  });
});
