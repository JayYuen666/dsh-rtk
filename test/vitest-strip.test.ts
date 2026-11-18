// lib/vitest-strip.ts 单测：删「通过」行，其余逐字留下。
//
// 判据全部按**行**读，不按字节总数：这份变换的唯一承诺是「失败块与汇总行一个字符都不动」，
// 而「省了多少」是护栏（`lib/guard.ts`）的事。用总字节数当判据的话，把失败块也删掉反而
// 更「绿」——那正是这条路径最该防的错。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { stripPassingTests } from "../lib/vitest-strip.ts";

/** vitest 5 的真实形状：文件结果行恰好一个前导空格，测试与套件行缩进更深。 */
const FAIL_LINE = "   × fails A 4ms";
const PASSING_SUMMARY = "Test Files  1 passed (1)";
const CONSOLE_LINE = "   ✓ console line";
const AFTER_BLOCK = "   ✓ after the block";
const FILE_RESULT_PASS = " ✓ test/a.test.ts (1 test) 3ms";

const FIXTURE = [
  " RUN  v5.1.0 /repo",
  "",
  "stdout | test/a.test.ts > passes one",
  "   ✓ this is a log line",
  "   ✓ deployed in 42ms",
  "",
  " ✓ test/b.test.ts (2 tests) 206ms",
  "   ✓ passes two 3ms",
  "   ✓ passes three 1ms",
  " ❯ test/c.test.ts (1 test | 1 failed) 12ms",
  FAIL_LINE,
  "",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  test/c.test.ts > fails A",
  "AssertionError: expected +0 to be 99",
  "",
  " ❯ test/c.test.ts:3:15",
  "",
  " Test Files  1 failed | 1 passed (2)",
  "      Tests  1 failed | 2 passed (3)",
  "   Duration  300ms",
].join("\n");

describe("stripPassingTests", () => {
  it("删掉通过行，失败块、console 块与汇总行逐字留下", () => {
    const out = stripPassingTests(FIXTURE);

    // 三行通过行：文件级那行带计数、另两行带时长，都在「通过」这一侧。
    assert.equal(out.dropped, 3);
    // console 块里的两行长得也像通过行——它们是被测程序的输出，必须留下。
    assert.ok(out.text.includes("   ✓ this is a log line"), out.text);
    assert.ok(out.text.includes("   ✓ deployed in 42ms"), out.text);
    // 失败证据一个字符都不能动。
    for (const kept of [
      FAIL_LINE,
      "AssertionError: expected +0 to be 99",
      " ❯ test/c.test.ts:3:15",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      " FAIL  test/c.test.ts > fails A",
    ]) {
      assert.ok(out.text.includes(kept), `丢了「${kept}」：\n${out.text}`);
    }
    // 汇总行是「本次跑成什么样」的唯一来源，四行都要在。
    for (const kept of [
      "Test Files  1 failed | 1 passed (2)",
      "Tests  1 failed | 2 passed (3)",
      "Duration  300ms",
      "RUN  v5.1.0 /repo",
    ]) {
      assert.ok(out.text.includes(kept), `丢了「${kept}」：\n${out.text}`);
    }
    // 通过行本身必须消失（按行判，避免子串误判）。
    for (const gone of ["   ✓ passes two 3ms", "   ✓ passes three 1ms"]) {
      assert.equal(out.text.split("\n").includes(gone), false, `没删掉「${gone}」`);
    }
  });

  it("没有通过行时原样返回，dropped 为 0（收益判据会因此拒掉这次压缩）", () => {
    const plain = "FAIL  test/a.test.ts > a\nAssertionError: nope\n[exit code: 1]";

    assert.deepEqual(stripPassingTests(plain), { text: plain, dropped: 0 });
  });

  it("全部通过时只留汇总：删空正文不算空输出", () => {
    const allPass = [
      FILE_RESULT_PASS,
      "   ✓ a1 2ms",
      "",
      ` ${PASSING_SUMMARY}`,
      "      Tests  1 passed (1)",
      "   Duration  12ms",
    ].join("\n");
    const out = stripPassingTests(allPass);

    assert.equal(out.dropped, 2);
    // 汇总三行仍在——「200 个用例全过」这个结论不能因为压缩而消失。
    assert.ok(out.text.includes(PASSING_SUMMARY), out.text);
    assert.ok(out.text.includes("Tests  1 passed (1)"), out.text);
  });

  it("console 块在文件结果行处结束：块后的通过行照样删", () => {
    const text = ["stdout | test/a.test.ts > a", CONSOLE_LINE, FILE_RESULT_PASS, AFTER_BLOCK].join(
      "\n",
    );
    const out = stripPassingTests(text);

    assert.equal(out.dropped, 2);
    assert.ok(out.text.includes(CONSOLE_LINE), out.text);
    assert.equal(out.text.split("\n").includes(AFTER_BLOCK), false);
  });

  it("console 块在汇总行处结束：没有文件结果行时也不会把后面的通过行当成 console 正文", () => {
    const text = [
      "stderr | test/a.test.ts > a",
      CONSOLE_LINE,
      ` ${PASSING_SUMMARY}`,
      AFTER_BLOCK,
    ].join("\n");
    const out = stripPassingTests(text);

    assert.equal(out.dropped, 1);
    // stderr 段落同样受 console 保护——两块的判据是同一个前缀；汇总行本身不是通过行。
    assert.ok(out.text.includes(CONSOLE_LINE), out.text);
    assert.ok(out.text.includes(PASSING_SUMMARY), out.text);
    assert.equal(out.text.split("\n").includes(AFTER_BLOCK), false);
  });

  it("skipped / todo / failed 三种符号都不删：只有 ✓ 是通过", () => {
    const text = [
      "   ↓ skipped one 1ms",
      "   □ todo one 0ms",
      "   × fails A 4ms",
      "   → interrupted one",
      "   ✓ passes one 2ms",
    ].join("\n");
    const out = stripPassingTests(text);

    assert.equal(out.dropped, 1);
    for (const kept of ["↓ skipped one", "□ todo one", "× fails A", "→ interrupted one"]) {
      assert.ok(out.text.includes(kept), `丢了「${kept}」：\n${out.text}`);
    }
    assert.equal(out.text.split("\n").includes("   ✓ passes one 2ms"), false);
  });
});
