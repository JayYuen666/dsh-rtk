/**
 * vitest 输出的「按行删通过测试」压缩。
 *
 * 为什么需要它：rtk 在 vitest 5 上只能 passthrough —— 它给 vitest 注入 `--reporter=json`，
 * 而 vitest 5 把 JSON 写进文件（`.vitest/json/output.json`），stdout 只剩一行通告，三级解析
 * 全失败（见 `vitest-major.ts` 的注释）。实测 `rtk vitest run` 对 850 通过 + 4 失败的输出只回
 * 127 B 的两行通告；那比「什么都不压」更糟——它连测试名都没了。
 *
 * 换 `--outputFile=/dev/stdout` 也不成立：vitest 单次 `writeFile` 写到**非阻塞管道**时写不动就
 * 放弃（stderr 一句 `EAGAIN: resource temporarily unavailable`），输出恒被砍在 65536 B；rtk
 * 内部正是 `cmd.output()` 的管道，于是 JSON 超过 64 KiB 就截断 → 解析失败 → passthrough 2000
 * 字符。真实仓库（850 个通过用例）的 JSON 是 149 KB，**必然崩**。
 *
 * 所以这一层不等 rtk：它只做一件纯文本变换——把「通过」的行删掉，失败块与汇总行原地不动。
 * 实测（本仓 860 用例真实输出 4105 B）：删 73 行后 412 B（省 90%），
 * `Test Files 52 passed (52)` / `Tests 860 passed (860)` / `Duration` 全在。
 *
 * **只作用于 stdout 段**：失败证据（`⎯⎯ Failed Tests`、`FAIL  …`、`AssertionError:`、
 * `Expected/Received`、源码行号）实测全在 stderr 段，而调用方传进来的是 `extractBody` 切出来
 * 的正文，`\n[stderr]\n` 之后的段落根本不经过这里。
 *
 * **收益与拒绝不归这一层管**：值不值得替换由 `lib/guard.ts` 照常判（`vitest` 属 summary 类，
 * 走 `empty-output` / `low-gain` / `fabricated-success`）。一行都没删掉时输出与输入等长，
 * `low-gain` 自己会拒——这里不另立一道。
 */

/**
 * 文件级结果行：**恰好一个**前导空格 + 状态符 + 空格。
 *
 * 状态符取自 vitest 自己的常量（`dist/chunks/utils.*.js` 的 `F_CHECK`/`F_CROSS`/`F_DOWN`/
 * `F_TODO`/`F_RIGHT`/`F_POINTER`）。缩进两格以上的行是测试与套件级，不在此列。
 */
const FILE_RESULT = /^ [✓×❯↓□→] /u;

/** console 块头：`stdout | <file> > <test name>` / `stderr | ...`。块里是用户的原始输出。 */
const CONSOLE_HEADER = /^(?:stdout|stderr) \| /u;

/**
 * 汇总行与分隔线：出现即说明 console 块已结束（它们不会出现在 console 块内部）。
 *
 * 前导空格不是可选的：vitest 把这几行右对齐到 13 列（实测 ` Test Files  52 passed (52)`），
 * 少了这段匹配，console 块就永远结束不了——紧随其后的通过行会被当作用户输出留下，
 * 于是「一句 console 之后的所有通过行都不删」。
 */
const SUMMARY_LINE = /^ *(?:Test Files|Tests {2}|Start at|Duration|⎯)/u;

/**
 * 「通过」的行：缩进（任意层）+ `✓ `。
 *
 * 只看前缀、不看结尾时长：vitest 的通过行有两种写法——叶子测试带时长（`✓ name 12ms`）、套件
 * 与文件带计数（`✓ file (40 tests) 206ms` / `✓ suite (9)`）。只删前一种省一半：本仓实测
 * 4105→2823 B（31%），两种都删是 412 B（90%）。
 *
 * 这与 vitest 自己的 `--reporter=minimal` 同义：实测 850 通过 + 1 失败的夹具里，
 * `grep -v '^[ \t]*✓'` 与 `--reporter=minimal` 输出**逐字节相同**（836 B / 32 行）。
 */
const PASSING = /^[ \t]*✓ /u;

/** 一段变换的结果。 */
export interface StrippedOutput {
  readonly text: string;
  /** 删掉的行数。0 表示这份输出本来就没有通过行（收益判据会因此拒掉这次压缩）。 */
  readonly dropped: number;
}

/**
 * 删掉「通过」的行，保留失败块、console 块与汇总。
 *
 * console 块（`stdout | ...` 到下一个文件结果行/汇总行为止）整段不动：用户 `console.log` 打出
 * 来的东西可能恰好长得像通过行（实测夹具里 `   ✓ deployed in 42ms` 就是这样），删掉它等于删掉
 * 被测程序的输出。
 *
 * @param text - 原始 stdout（不含 stderr 段与退出 marker：那两段归 `stdout-extract`）
 * @returns 删完之后的一段；删空了就回空串，由护栏按 `empty-output` 拒
 */
export function stripPassingTests(text: string): StrippedOutput {
  const kept: string[] = [];
  let dropped = 0;
  let inConsole = false;
  for (const line of text.split("\n")) {
    if (CONSOLE_HEADER.test(line)) {
      inConsole = true;
    } else if (inConsole && (FILE_RESULT.test(line) || SUMMARY_LINE.test(line))) {
      inConsole = false;
    }
    if (!inConsole && PASSING.test(line)) {
      dropped += 1;
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join("\n"), dropped };
}
