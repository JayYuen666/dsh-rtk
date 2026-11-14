/**
 * 输入形态预检：在花一次 spawn 之前，先把「把 pytest 输出喂给 cargo filter」这类错配拦掉。
 *
 * 判据只能是该工具**独有**的结构标记。`passed` / `FAILED` 这类通用词不能用：真 cargo 输出
 * 也含 `passed`，那样 cargo 输出会通过 pytest 的预检，这道门就成了摆设。
 *
 * 未登记的 filter 一律放行（返回 `true`）。理由：它们默认不启用，而且形态未知时拒绝
 * 等于「永远不压」——预检是省一次 spawn 的优化，不该变成功能开关。
 */

/** filter → 该工具独有的结构标记；命中任意一条即认为形态可信。 */
const SHAPE_TOKENS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  [
    "cargo-test",
    ["test result:", "running 1 test", "running 2 tests", "failures:", "error[E", "---- test "],
  ],
  ["pytest", ["test session starts", "rootdir:", "platform darwin", "== FAILURES", "== ERRORS"]],
  ["vitest", ["Test Files", "Tests  ", "PASS ", "FAIL ", "✓ ", "× "]],
  ["ctest", ["tests passed", "tests failed", "Test #"]],
]);

/** 输入文本是否像该 filter 能处理的那一类输出；未登记的 filter 返回 `true`（不预检）。 */
export function shapeMatches(filter: string, input: string): boolean {
  const tokens = SHAPE_TOKENS.get(filter);
  return tokens === undefined || tokens.some((token) => input.includes(token));
}
