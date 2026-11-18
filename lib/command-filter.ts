/**
 * B 形态的 pipe 表：命令形态 → rtk 自带的 filter 名。
 *
 * 这不是命令范围的权威——C 形态的范围由 `rtk rewrite` 的输出定义（官方 95 条规则 +
 * 62 个 TOML filter）。这张表只回答「这段输出该喂给哪个 filter 压」，所以：
 *   · rg 归 grep、fd 归 find——`rtk pipe` 只认 `grep` / `find` 这两个名字；
 *   · prettier 永久不入表：实测 rtk 对它输出「All files formatted correctly」而原始输出
 *     里有违例，属伪造成功，护栏补救不了；
 *   · vitest 的四行（`vitest` / `pnpm test` / `npm test` / `yarn test`）在默认集合里，但那一路
 *     的压缩**不经 rtk**：`host.ts` 的 `modeOf` 把它导到 `lib/vitest-strip.ts` 本地删通过行。
 *     rtk 在 vitest 5 上三层解析全失败（JSON 走了文件），喂原生文本又只剩失败名——两条都不可用。
 *
 * 启用集合装的是 **filter 名**（Config 的 `enabledFilters` 就是这些字符串），不是行 id：
 * 三行 `npm/pnpm/yarn test` 共用 `vitest` 这一个 filter，行 id 与 filter 名不是一一对应。
 * （`rtk rewrite` 认 `bun test`，但那一路由 C 形态处理；B 形态这张表只管「输出该喂谁」，
 * 没实测过 bun 的 pipe 过滤结果，所以不入表——不入表比猜一个 filter 名安全。）
 */

/**
 * B 形态的一行：命令形态 → pipe filter。
 *
 * 表里**没有** `defaultEnabled` 这一位：默认启用集合是 `DEFAULT_ENABLED_FILTERS` 一个常量，
 * schema 的 `.default()` 与 `apply` 的兜底都读它。早先每行带一个 `defaultEnabled` 布尔，
 * 而生产代码从不读它（默认值另有两处硬写字面量），只有测试拿它自比——那是「用表验表」：
 * 把某行改成 false，测试跟着改绿，而用户看到的默认集合一动不动。
 */
export interface PipeEntry {
  readonly id: string;
  readonly pattern: RegExp;
  readonly filter: string;
}

/**
 * 默认参与 pipe 的 filter 集合。
 *
 * 两项判据拼成这一份，缺一项就有一半的命令没有压缩机会：
 *
 * 1. **前缀形态交不出去的那批**：`git log` / `git diff` / `git status` / `grep` / `find`。
 *    它们在 `lib/rewrite-gate.ts` 的拒绝表收窄之后**已经**被前缀层接走（rc=3 实测），所以
 *    结果侧再压会命中 `already-rewritten` 让路。留在默认集合里是因为前缀层在某些形态下仍
 *    交不出去（超出闸门、`aws` 那一类 `DENY_TABLE` 命中、命令拼接里有一段不能改），那时
 *    结果侧是唯一的压缩机会。
 * 2. **`vitest`**：rtk 对它自己那三层解析在 vitest 5 上全线失败，但本包不再依赖 rtk——
 *    `modeOf("vitest")` 把它导到 `lib/vitest-strip.ts` 的本地删行路径，与 rtk 版本无关。
 *    所以它不再需要用户手动勾选：`pnpm test` / `npm test` / `yarn test` 这三种**前缀层改不动**
 *    的形态（rtk 的规则要求显式 `run`，实测 rc=1）全部落在这里。
 *
 * 其余 8 项仍留给用户按仓库勾选：`cargo-test` / `pytest` / `ctest` / `tsc` / `mypy` /
 * `go-test` / `go-build` / `ruff-*` 都会被前缀层先接手，勾上通常只增 `already-rewritten` 计数。
 */
export const DEFAULT_ENABLED_FILTERS: readonly string[] = [
  "git-log",
  "git-diff",
  "git-status",
  "grep",
  "find",
  "vitest",
];

/** 表共 18 行；`filter` 取值必须落在 rtk 的已知 filter 名单内（测试交叉核对）。 */
export const PIPE_TABLE: readonly PipeEntry[] = [
  {
    id: "cargo test",
    pattern: /^cargo\s+test(?:\s|$)/u,
    filter: "cargo-test",
  },
  {
    id: "pytest",
    pattern: /^(?:pytest|python3?\s+-m\s+pytest)(?:\s|$)/u,
    filter: "pytest",
  },
  { id: "ctest", pattern: /^ctest(?:\s|$)/u, filter: "ctest" },
  {
    id: "vitest",
    pattern: /^(?:vitest|npx\s+vitest|pnpm\s+exec\s+vitest)(?:\s|$)/u,
    filter: "vitest",
  },
  { id: "pnpm test", pattern: /^pnpm\s+test(?:\s|$)/u, filter: "vitest" },
  { id: "npm test", pattern: /^npm\s+test(?:\s|$)/u, filter: "vitest" },
  { id: "yarn test", pattern: /^yarn\s+test(?:\s|$)/u, filter: "vitest" },
  { id: "go test", pattern: /^go\s+test(?:\s|$)/u, filter: "go-test" },
  { id: "go build", pattern: /^go\s+build(?:\s|$)/u, filter: "go-build" },
  { id: "tsc", pattern: /^(?:tsc|npx\s+tsc)(?:\s|$)/u, filter: "tsc" },
  { id: "mypy", pattern: /^mypy(?:\s|$)/u, filter: "mypy" },
  {
    id: "ruff check",
    pattern: /^ruff\s+check(?:\s|$)/u,
    filter: "ruff-check",
  },
  {
    id: "ruff format",
    pattern: /^ruff\s+format(?:\s|$)/u,
    filter: "ruff-format",
  },
  { id: "git log", pattern: /^git\s+log(?:\s|$)/u, filter: "git-log" },
  { id: "git diff", pattern: /^git\s+diff(?:\s|$)/u, filter: "git-diff" },
  {
    id: "git status",
    pattern: /^git\s+status(?:\s|$)/u,
    filter: "git-status",
  },
  { id: "grep", pattern: /^(?:grep|rg)(?:\s|$)/u, filter: "grep" },
  { id: "find", pattern: /^(?:find|fd)(?:\s|$)/u, filter: "find" },
];

/** 卡片提示用：表里出现过的全部 filter 名（去重排序），不是只有默认启用那三项。 */
export const ALL_FILTERS: readonly string[] = [
  ...new Set(PIPE_TABLE.map((entry) => entry.filter)),
].toSorted();

/** 命中表且该行 filter 已启用才返回 filter 名；否则 `undefined`（这条不做 pipe 压缩）。 */
export function filterOf(cmd: string, enabled: ReadonlySet<string>): string | undefined {
  const trimmed = cmd.trimStart();
  const found = PIPE_TABLE.find(
    (entry) => entry.pattern.test(trimmed) && enabled.has(entry.filter),
  );
  return found?.filter;
}
