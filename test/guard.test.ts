// lib/guard.ts 单测：压完之后再过一道护栏，防止「压是压了、信息没了」。
//
// 判据全部按 **UTF-8 字节**算收益：模型可见面里混着中文测试名与 emoji，用 `String.length`
// 会把 300 个汉字当成 300 字节，让明显没压下来的结果通过 minGainRatio，护栏整体偏松。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { guardCompressed } from "../lib/guard.ts";

const CARGO_FILTER = "cargo-test";
const MIN_GAIN = 0.95;
const CARGO_OK = "running 1 test\ntest a ... ok\ntest result: ok. 1 passed; 0 failed\n";
const CARGO_SUMMARY = "cargo test: 3 passed";
const TEST_RESULT = "test result: ok. 1 passed";
const GREP_HITS = "f:1:a\nf:2:b\nf:3:c\n";
const FOLDED = "folded-entries";

/** 默认参数：多数用例只关心其中一两项。 */
function opts(
  input: string,
  output: string,
  filter = CARGO_FILTER,
): Parameters<typeof guardCompressed>[0] {
  return { filter, input, output, minGainRatio: MIN_GAIN };
}

describe("通用护栏", () => {
  it("输出为空判拒", () => {
    const result = guardCompressed(opts("test result: ok. 1 passed", ""));

    assert.equal(result.ok, false);
    assert.deepEqual(result, { ok: false, reason: "empty-output" });
  });

  it("收益不足判拒", () => {
    assert.deepEqual(guardCompressed(opts(TEST_RESULT, TEST_RESULT)), {
      ok: false,
      reason: "low-gain",
    });
  });

  it("收益按字节算：中文内容不算压缩", () => {
    // 60 行「测试失败」= 240 字符 / 720 字节；字符数算会以为压掉了，字节算才知道没压。
    const cjk = "测试失败\n".repeat(60);

    assert.deepEqual(guardCompressed(opts(cjk, cjk)), { ok: false, reason: "low-gain" });
  });

  it("收益按字节算：多字节字符达到阈值才算通过", () => {
    const cjk = "测试失败\n".repeat(60);
    // 只留三行、且三行互不相同：相同行会被 summary 折叠掉，那样测的就不是收益判据了。
    const trimmed = "测试失败甲\n测试失败乙\n测试失败丙\n";

    assert.deepEqual(guardCompressed(opts(cjk, trimmed)), { ok: true, output: trimmed });
  });

  it("字符数相同但字节数变大时判拒（判据必须按字节）", () => {
    // 300 个 ASCII 字符 = 300 字节；100 个汉字 = 300 字节。字符数 100 < 300 看着像压了 67%，
    // 字节数却一模一样——这一格是「按字符算」与「按字节算」唯一分叉的地方。
    const ascii = "x".repeat(300);
    const cjk = "测".repeat(100);

    assert.deepEqual(guardCompressed(opts(ascii, cjk)), { ok: false, reason: "low-gain" });
  });

  it("伪造成功判拒（输入有失败标记、输出宣称成功）", () => {
    // 输入得先满足收益判据，否则先报 low-gain、测不到「伪造成功」这条。
    const failed = "error: boom\nFAIL\n".repeat(20);

    assert.deepEqual(guardCompressed(opts(failed, "mypy: No issues found", "mypy")), {
      ok: false,
      reason: "fabricated-success",
    });
  });

  it("输入没有失败标记时，成功宣告不算伪造", () => {
    // 干净输入 + 成功摘要 = 正常压缩结果，不能一律拦。
    const clean = "running 1 test\ntest a ... ok\ntest result: ok. 1 passed; 0 failed\n".repeat(3);

    assert.deepEqual(guardCompressed(opts(clean, CARGO_SUMMARY)), {
      ok: true,
      output: CARGO_SUMMARY,
    });
  });

  it("正常压缩通过并原样交回输出", () => {
    const input = CARGO_OK.repeat(3);
    const result = guardCompressed(opts(input, CARGO_SUMMARY));

    assert.deepEqual(result, { ok: true, output: CARGO_SUMMARY });
  });

  it("输入为空时优先报空输出（不判 low-gain）", () => {
    assert.deepEqual(guardCompressed(opts("", "")), { ok: false, reason: "empty-output" });
  });
});

describe("summary 相邻重复行折叠", () => {
  it("连续相同行折叠成一行", () => {
    const input = `${TEST_RESULT}\n`.repeat(5);
    const output = `${TEST_RESULT}\n${TEST_RESULT}\ncargo test: 1 passed`;

    // 折完之后只剩一行 TEST_RESULT——判据是整段结果，而不是「出现了几次」。
    assert.deepEqual(guardCompressed(opts(input, output)), {
      ok: true,
      output: `${TEST_RESULT}\ncargo test: 1 passed`,
    });
  });

  it("非相邻重复不折叠（顺序本身是信息）", () => {
    const input = "a\nb\na\n".repeat(40);

    assert.deepEqual(guardCompressed(opts(input, "a\nb\na\ncargo test: 1 passed")), {
      ok: true,
      output: "a\nb\na\ncargo test: 1 passed",
    });
  });

  it("非 summary 类不折叠", () => {
    const input = "error: x\n".repeat(10);

    assert.deepEqual(guardCompressed(opts(input, "error: x\nerror: x\nwarn: y", "tsc")), {
      ok: true,
      output: "error: x\nerror: x\nwarn: y",
    });
  });
});

describe("vcs 类查 hash 守恒", () => {
  it("git-log 丢了短 hash 判拒", () => {
    assert.deepEqual(guardCompressed(opts("abc1234 x\ndef5678 y\n", "abc1234 x", "git-log")), {
      ok: false,
      reason: "lost-hash",
    });
  });

  it("hash 个数相同但内容不同时判拒（逐条比对，不是比个数）", () => {
    // 输出里出现 input 没有的 hash、同时丢了 input 里的一枚——个数相同，只有逐条比对抓得到。
    const input = "abc1234 x\ndef5678 y\n".repeat(20);
    const output = "abc1234 x\nfedcba9 z";

    assert.deepEqual(guardCompressed(opts(input, output, "git-log")), {
      ok: false,
      reason: "lost-hash",
    });
  });

  it("git-diff hash 守恒则通过", () => {
    const input = "abc1234 x\ndef5678 y\n".repeat(3);

    assert.equal(guardCompressed(opts(input, "abc1234 def5678", "git-diff")).ok, true);
  });

  it("vcs 输出里压根没有 hash 时通过", () => {
    // 没有 hash 可守恒：`hashSet` 的「无命中」分支，判据必须放行而不是当成全丢。
    const input = "rename: a -> b\n".repeat(40);

    assert.deepEqual(guardCompressed(opts(input, "rename: a -> b", "git-diff")), {
      ok: true,
      output: "rename: a -> b",
    });
  });

  it("非 vcs 类不查 hash（列表类里出现 hash 不会被误判）", () => {
    const input = "abc1234 x\ndef5678 y\n".repeat(3);

    assert.equal(guardCompressed(opts(input, "abc1234", "grep")).ok, true);
  });
});

describe("listing 类查折叠标记", () => {
  it("find 的 +180 more dirs 判拒", () => {
    // 200 个目录名是 rtk find 的真实输入规模；输出只剩首条 + 折叠标记。
    const many = Array.from({ length: 200 }, (_unused, index) => `./dir${String(index)}`).join(
      "\n",
    );

    assert.deepEqual(guardCompressed(opts(many, "./dir0\n+180 more dirs", "find")), {
      ok: false,
      reason: FOLDED,
    });
  });

  it("grep 的 +2 判拒", () => {
    assert.deepEqual(guardCompressed(opts(GREP_HITS, "f:1:a\n+2", "grep")), {
      ok: false,
      reason: FOLDED,
    });
  });

  // 九族折叠标记逐条打：这张表是数据，不逐条验一遍的话，少写一条正则没有任何门会红
  // ——而它的失效形态正是「rtk 换了一种折叠写法，护栏静默放行」。输入刻意只有 3 个非空行
  // （低于塌缩判据的下限 20），所以这一格只可能由标记命中，不会被行数判据兜住。
  // 输入要够长（绕过 low-gain），但非空行数要低于塌缩判据的 20 行下限——
  // 这样这一格只可能由标记命中。两条长行正好同时满足这两个条件。
  const SHORT_INPUT = `${"./very-long-directory-name-".repeat(20)}\n${"./another-long-one-".repeat(20)}\n`;
  const LISTING_MARKS: readonly (readonly [string, string])[] = [
    ["+190", "  +190"],
    ["+28 more dirs", "+28 more dirs"],
    ["... (150 more)", "... (150 more)"],
    ["... (12 filtered)", "... (12 filtered)"],
    ["... (9 more, 3 filtered)", "... (9 more, 3 filtered)"],
    ["[+150 hidden: ...]", "[+150 hidden: rtk recall 9f2c1d]"],
    ["... +40 more files", "... +40 more files"],
    ["[+56 lines omitted]", "[+56 lines omitted]"],
    ["[9 more lines]", "[9 more lines]"],
  ];

  it.each(LISTING_MARKS)("九族折叠标记 %s 判拒", (_name, marker) => {
    assert.deepEqual(guardCompressed(opts(SHORT_INPUT, `./a\n${marker}`, "find")), {
      ok: false,
      reason: FOLDED,
    });
  });

  it("不是折叠标记的 +N 计数不判拒（摘要类计数不属 listing 折叠）", () => {
    // `… +15 more failures` 是 pytest/cargo-test 的摘要折叠，属 summary 类；
    // 把 listing 的标记判据放宽到「任何 +N」会把它错判成 listing 丢失。
    assert.equal(guardCompressed(opts(SHORT_INPUT, "./a\n+15 more failures", "find")).ok, true);
    assert.equal(guardCompressed(opts(SHORT_INPUT, "./a\n+3", "find")).ok, false);
  });

  it("行数塌缩也判拒（有些折叠不带 +N 标记），但只对路径类 listing", () => {
    // find/ls/git-status 的折叠可以不写 `+N`，所以补一条行数判据。
    // grep/rg 刻意不走这条：真实 grep 输出常有 300→421 行的「变多」形态，行数判据会假阳。
    const input = Array.from({ length: 40 }, (_unused, index) => `./entry${String(index)}`).join(
      "\n",
    );

    assert.deepEqual(guardCompressed(opts(input, "./entry0\n./entry1", "find")), {
      ok: false,
      reason: FOLDED,
    });
  });

  it("行数本来很少时不按塌缩判（短输出没有统计意义）", () => {
    // 5 行 → 2 行也是「不到一半」，但 5 行这种规模本来就是压缩后的正常摘要，
    // 拿它判塌缩会把正常结果全部拒掉。下限存在的意义就是这一格。
    const input = "./a\n./b\n./c\n./d\n./e\n";

    assert.equal(guardCompressed(opts(input, "./a\n./b", "find")).ok, true);
  });

  it("grep 不走行数判据（300→421 行是真实形态）", () => {
    // 输入 40 行、输出 3 行：若走行数判据这里会被判折叠，而 grep 恰恰不该走。
    const input = Array.from({ length: 40 }, (_unused, index) => `f:${String(index)}:hit`).join(
      "\n",
    );
    const output = "f:1:a\nf:2:b\nf:3:c";

    assert.equal(guardCompressed(opts(input, output, "grep")).ok, true);
  });

  it("没有折叠标记且行数守恒则通过", () => {
    assert.deepEqual(guardCompressed(opts(GREP_HITS, "f:1:a\nf:3:c", "grep")), {
      ok: true,
      output: "f:1:a\nf:3:c",
    });
  });

  it("非 listing 类不看折叠标记", () => {
    const input = CARGO_OK.repeat(3);

    assert.equal(
      guardCompressed(opts(input, "cargo test: 3 passed\n+5 more", CARGO_FILTER)).ok,
      true,
    );
  });
});

describe("未登记类别", () => {
  it("未登记 filter 一律判拒（分类不确定就不压）", () => {
    assert.deepEqual(guardCompressed(opts("aaaa", "a", "nope")), {
      ok: false,
      reason: "unclassified",
    });
  });
});
