// lib/filter-class.ts 单测：filter 名 → 护栏类别。
//
// 类别决定护栏走哪几条分支（vcs 查 hash 守恒、listing 查折叠、summary 折叠相邻重复行）。
// 表里没登记的 filter 一律 undefined，`guardCompressed` 会对它返回 `unclassified` 拒绝——
// 分类不确定就不压，这是这一层的默认方向。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { classOf } from "../lib/filter-class.ts";
import { PIPE_TABLE } from "../lib/command-filter.ts";

const SUMMARY_FILTERS = ["cargo-test", "pytest", "vitest", "ctest", "go-test", "phpunit", "pest"];
const COMPILE_FILTERS = ["tsc", "mypy", "go-build"];
const LINT_FILTERS = ["ruff-check", "ruff-format"];
const VCS_FILTERS = ["git-log", "git-diff"];
// 只列**真的会被 `filterOf` 产出的** filter 名：`rg` 归 `grep`、`fd` 归 `find`（rtk pipe 只认
// 这两个名字），表里若留着 `rg`/`fd` 两条映射就是死条目——它们永远不会被查。
//
// `window` 与 `hook` 也不是 rtk 的 filter 名，但它们**会**被查到（`host.ts` 的 `modeOf` 用它
// 分流到本包的两条本地路径），所以登记在这里的是「过滤名 → 护栏类别」这张映射的全部键，
// 不是「rtk pipe 的档位表」。两者归 `listing` 的理由见 `lib/filter-class.ts` 的注释。
const LISTING_FILTERS = ["grep", "find", "git-status", "window", "hook"];

describe("classOf 的边界", () => {
  it("`rg` / `fd` 不是 filter 名（rtk 用 grep / find），因此未登记", () => {
    assert.equal(classOf("rg"), undefined);
    assert.equal(classOf("fd"), undefined);
  });
});

describe("classOf", () => {
  it("summary 类", () => {
    for (const filter of SUMMARY_FILTERS) {
      assert.equal(classOf(filter), "summary", filter);
    }
  });

  it("compile 类", () => {
    for (const filter of COMPILE_FILTERS) {
      assert.equal(classOf(filter), "compile", filter);
    }
  });

  it("lint 类", () => {
    for (const filter of LINT_FILTERS) {
      assert.equal(classOf(filter), "lint", filter);
    }
  });

  it("vcs 类", () => {
    for (const filter of VCS_FILTERS) {
      assert.equal(classOf(filter), "vcs", filter);
    }
  });

  it("listing 类", () => {
    for (const filter of LISTING_FILTERS) {
      assert.equal(classOf(filter), "listing", filter);
    }
  });

  it("未登记的 filter 返回 undefined", () => {
    assert.equal(classOf("nope"), undefined);
    assert.equal(classOf(""), undefined);
    // 原型上的键也必须返回 undefined：用对象字面量存放时 `CLASSES["constructor"]` 会
    // 返回 Object 的成员，让「未登记」变成「登记成了一个不是类别的值」。
    assert.equal(classOf("constructor"), undefined);
    assert.equal(classOf("toString"), undefined);
    assert.equal(classOf("__proto__"), undefined);
  });
});

describe("表内 filter 都有类别", () => {
  it("没有登记的 filter 是死代码", () => {
    for (const entry of PIPE_TABLE) {
      assert.notEqual(classOf(entry.filter), undefined, entry.filter);
    }
  });

  it("每个类别至少被两个 filter 用到（单条类别没有交叉验证价值）", () => {
    const counts = new Map<string, number>();
    for (const entry of PIPE_TABLE) {
      const filterClass = classOf(entry.filter);
      if (filterClass !== undefined) {
        counts.set(filterClass, (counts.get(filterClass) ?? 0) + 1);
      }
    }

    for (const [filterClass, count] of counts) {
      assert.ok(count >= 2, `${filterClass} 只有 ${String(count)} 条`);
    }
  });
});
