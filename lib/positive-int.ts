/**
 * 把配置面上的容量/上限归一到 `[1, ∞)` 的整数。
 *
 * 为什么要有这一个文件：`createRewriteCache` 的容量与 `createRewrittenCalls` 的上限本来就是
 * 同一件事——都得挡住「非有限值与 0 会让有界容器永远不逐出」这一格。两处各抄一份等价实现
 * 时，改一处漏一处就是静默泄漏。shared 里没有这个键，所以它留在本包，但只留一份。
 *
 * `Math.trunc(NaN)` 仍是 NaN，NaN 参与的比较恒为 false，于是容量检查永远通过、逐出永不发生，
 * 容器无限长。非有限值一律退到 1。
 */
export function positiveInt(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}
