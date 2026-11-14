/**
 * filter 名 → 护栏类别。
 *
 * 类别决定护栏走哪几条分支：
 *   summary  —— 折叠相邻重复的摘要行（`test result:` 之类的重复）
 *   compile  —— 不折叠，只查「有没有把诊断行吃掉」
 *   lint     —— 同上，但允许工具自己的统计行
 *   vcs      —— 查 hash / 提交号守恒（`git log` 的短 hash 不能被改写）
 *   listing  —— 查折叠标记（`+N more` 之类必须带取回指针，或被行数塌缩判据兜住）
 *
 * 未登记的 filter 返回 `undefined`：`guardCompressed` 会把 `unclassified` 当作拒绝理由，
 * 也就是「分类不确定就不压」。这条方向比「猜一个类别」安全。
 */
export type FilterClass = "summary" | "compile" | "lint" | "vcs" | "listing";

/**
 * 键是 `PIPE_TABLE` 里真的会出现的那 15 个 filter 名。`rg` / `fd` 曾在这里各占一行，
 * 但 `filterOf` 只会回 `grep` / `find`（rtk 不接受 `rg` / `fd` 作 filter），那两行永远匹配不到——
 * 死映射不只是冗余，它会让「同一件事有两套名字」这个错觉留下来，下一个读表的人按它加 filter 就会错。
 *
 * 用 Map 而不是对象字面量：`CLASSES["constructor"]` 之类的原型键会返回 Object 的成员，
 * 让「未登记」变成「登记成了一个不是类别的值」——那正是这条判据最该挡住的一类输入。
 */
const CLASSES: ReadonlyMap<string, FilterClass> = new Map<string, FilterClass>([
  ["cargo-test", "summary"],
  ["pytest", "summary"],
  ["vitest", "summary"],
  ["ctest", "summary"],
  ["go-test", "summary"],
  ["tsc", "compile"],
  ["mypy", "compile"],
  ["go-build", "compile"],
  ["ruff-check", "lint"],
  ["ruff-format", "lint"],
  ["git-log", "vcs"],
  ["git-diff", "vcs"],
  ["grep", "listing"],
  ["find", "listing"],
  ["git-status", "listing"],
]);

/** filter 的护栏类别；未登记返回 `undefined`。 */
export function classOf(filter: string): FilterClass | undefined {
  return CLASSES.get(filter);
}
