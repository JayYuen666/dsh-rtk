import path from "node:path";
import { splitCommand, structuralReject } from "./prefix-safety.ts";
import { detectVitestMajor, isVitestCommand } from "./vitest-major.ts";

/**
 * 改写前唯一的闸门：先回答「这条命令该不该交给 rtk」，答案是否就原样执行。
 *
 * 判据次序有成本理由：结构判据不读盘，用户表是显式意图，内建表是证据表，vitest 版本门控
 * 要读 `node_modules`（最贵），所以按这个顺序短路。
 */

/** 改写被跳过（= 命令原样执行）的原因。改写失败不报错、不拦截，只如实记账。 */
export type RewriteSkipReason =
  | "compound"
  | "detail-flag"
  | "already-rtk"
  | "deny-table"
  | "user-deny"
  | "vitest-version"
  | "empty-command";

/**
 * 内建信息损失表的一条。
 *
 * 判据是「首词 + 子命令」的**字面前缀匹配**，不用正则表——表要能被人一眼核对，正则表不能。
 * 每条都带实测证据（spec §2.2）。
 */
interface DenyEntry {
  readonly first: string;
  readonly second?: string;
  readonly note: string;
}

const DENY_TABLE: readonly DenyEntry[] = [
  {
    first: "git",
    second: "log",
    note: "--oneline -20 与原生逐字节相同（1911B，零收益）；-50 才压但丢 26 个 hash",
  },
  { first: "git", second: "diff", note: "5 行头全丢、patch 不可 apply，且没有 recall 兜底" },
  { first: "git", second: "show", note: "丢 commit <full-hash> / Author: / Date: 原始格式" },
  { first: "ls", note: "60 文件→52 行，丢 10 个名字（... (10 more) / [+10 hidden]）" },
  { first: "find", note: "81→5 行，丢 31 个路径" },
  { first: "grep", note: "200 命中→28 行" },
  { first: "rg", note: "同上（rtk 用 grep filter 处理）" },
  { first: "cargo", second: "clippy", note: "382B→100B，warning 0 行全丢" },
  { first: "aws", note: "退出码失真：原生 rc=127 时 rtk 回 rc=1" },
];

/**
 * **显式保留、不拒**——这张名单是写给后人的护栏，不是代码的一部分：
 * `cargo build` / `cargo check` / `cargo test` / `pytest`（剥掉 `python -m` 后）/ `ctest` /
 * `go test` / `go build` / `tsc` / `mypy` / `ruff*` / `prettier` / `jest` / `docker` / `kubectl` /
 * `gh` / `terraform` / `make` / `pnpm run build`（最后这条走 P3：`rtk pnpm run build` 是纯前插，
 * `rest` 等于原串后缀、且被剥的前缀为空，不触发 P4）。
 *
 * 为什么值一条注释：上面那张 `DENY_TABLE` 的每一条都带「丢什么」的实测理由，而这份名单一条理由
 * 都没有——**它们没丢信息**。后人看到「`cargo build` 在改写面里」时最容易的反应是「构建命令也敢改？」
 * 然后顺手把它加进拒绝表；那会让默认形态（prefix）对最常见的一类命令彻底失效。要动这里，
 * 先拿 §2.2 的实测证据说话，不要凭直觉。
 */

// git diff 的统计型 flag：输出本来就是汇总，折叠不丢信息，放行。
const GIT_DIFF_KEEP: ReadonlySet<string> = new Set([
  "--stat",
  "--name-only",
  "--name-status",
  "--porcelain",
  "--numstat",
  "--shortstat",
  "--summary",
]);

// 切词用的正则提到模块级：`splitWords` 每条命令都会跑，写在函数体里等于每次重建。
const WHITESPACE = /\s+/u;

/** 按空白切词（连续空白当分隔，空串丢弃）。 */
function splitWords(command: string): string[] {
  return command
    .trim()
    .split(WHITESPACE)
    .filter((word) => word !== "");
}

/** `git diff --stat` 这类「输出本来就是汇总」的形态：折叠不丢信息，不该被内建表挡住。 */
function isGitDiffSummary(words: readonly string[]): boolean {
  return words.some((word) => GIT_DIFF_KEEP.has(word));
}

/**
 * `git show <ref>:<path>` 逐字节保真（实测 1263B / 42 行，diff = 0），放行；
 * `<commit-ish>` 形态会丢 `commit <full-hash>` / `Author:` / `Date:`，要拒。
 */
function isGitShowBlob(words: readonly string[]): boolean {
  return words.slice(2).some((word) => word.includes(":"));
}

/** 内建表判据；命中返回该条的实测理由（进日志/统计），未命中返回 undefined。 */
function denyTableReason(command: string): string | undefined {
  const words = splitWords(command);
  const [first, second] = words;
  let reason: string | undefined;
  for (const entry of DENY_TABLE) {
    const matched =
      first === entry.first && (entry.second === undefined || entry.second === second);
    if (matched) {
      const exempt =
        entry.second === "diff"
          ? isGitDiffSummary(words)
          : entry.second === "show" && isGitShowBlob(words);
      reason = exempt ? undefined : entry.note;
      break;
    }
  }
  return reason;
}

/** vitest 版本门控：探不到版本一律拒（保守），因为 vitest 5 上 rtk 会吞掉全部输出并建副作用文件。 */
function vitestGateReason(
  command: string,
  cwd: string,
  vitestMaxMajor: number,
): RewriteSkipReason | undefined {
  const major = detectVitestMajor(cwd, command);
  const supported = major !== undefined && major < vitestMaxMajor;
  return supported ? undefined : "vitest-version";
}

/** 门禁判据的输入。 */
export interface RewriteGateOptions {
  readonly denyCommands: readonly string[];
  readonly cwd: string;
  readonly vitestMaxMajor: number;
}

/**
 * 单段的判据：用户拒绝表 → 内建信息损失表 → vitest 版本门控。
 *
 * **必须逐段判**：`cd x && git diff` 的首词是 `cd`，按整条命令判会让内建表整片失效，
 * 结果是 rtk 把后半段改成 `rtk git diff`（丢 5 行 patch 头、patch 不可 apply）。同理
 * `cd x && vitest run` 绕过了版本门控——vitest 5 上 rtk 会吞掉全部输出。
 */
function segmentSkipReason(
  segment: string,
  options: RewriteGateOptions,
): RewriteSkipReason | undefined {
  const [first] = splitWords(segment);
  let reason: RewriteSkipReason | undefined;
  if (first !== undefined && options.denyCommands.includes(first)) {
    reason = "user-deny";
  } else if (denyTableReason(segment) !== undefined) {
    reason = "deny-table";
  } else if (isVitestCommand(segment)) {
    reason = vitestGateReason(segment, options.cwd, options.vitestMaxMajor);
  }
  return reason;
}

/**
 * 判这条命令要不要跳过改写。
 *
 * `undefined` = 可以交给 `rtk rewrite`；返回值 = 原样执行的原因。
 *
 * 结构判据对**整条**命令判（拆不开就是拆不开），后三道对**每一段**判：任意一段命中就整条原样
 * 执行。整条原样执行而不是「跳过那一段、改其余段」——用户按 `cd X && git status` 敲下来时，
 * 他期望的是一次完整执行；把前一段交出去、后一段自己拼，等于让插件替用户重写命令。
 */
export function shouldSkipRewrite(
  command: string,
  options: RewriteGateOptions,
): RewriteSkipReason | undefined {
  const structural = structuralReject(command);
  // 拆不开的命令（`structuralReject` 已经拒掉了这种）走单段兜底：结构与后三道判据的入参
  // 统一成「段表」，下面那条循环就不必再分两种形状。
  const segments = splitCommand(command) ?? [{ sep: "", text: command }];
  const reasons = segments.map((segment) => segmentSkipReason(segment.text, options));
  return structural ?? reasons.find((each) => each !== undefined);
}

/** 从 `unknown` 形状的 agent 上取 `session.header.cwd`；任何一层缺席都给 undefined。 */
function headerCwd(agent: unknown): unknown {
  let header: unknown;
  if (typeof agent === "object" && agent !== null) {
    const { session } = agent as { session?: unknown };
    if (typeof session === "object" && session !== null) {
      ({ header } = session as { header?: unknown });
    }
  }
  const { cwd } =
    typeof header === "object" && header !== null ? (header as { cwd?: unknown }) : {};
  return cwd;
}

/**
 * 命令生效的 cwd：**模型按调用传的 `workdir` 优先，其次是会话 cwd 的三级真源**。
 *
 * 会话 cwd 那部分，宿主 tool-bash 自己是两级：`ctx.workingDirectory.ensure(agent)` 优先，
 * `session.header.cwd` 只在 ensure 不可用时兜底（header 可能整段缺席）。插件在遮蔽层拿不到
 * tool-bash 内部那个 cwd，只能自己按同一顺序问一次；都拿不到落 `process.cwd()`。
 *
 * `override` 是模型这次调用传的 `workdir`（宿主 bash schema 有这一位：'Working directory for
 * this command. Defaults to the session workspace; a relative path is resolved against it.'）。
 * **必须读它**，否则「模型要求在某仓里跑 `cargo test`」与「在会话根跑」会算成同一个目录：
 * `rtk rewrite` 的退出码取决于从 cwd 向上找到的 `.claude/settings*`（审批裁决会按错的仓算），
 * `detectVitestMajor` 也会从错的起点向上找 `node_modules/vitest`（版本门判错 → 该压的不压）。
 * 合成规则与宿主 `packages/shell/tool-bash/src/index.ts` 的 `resolveWorkdir(modelWorkdir, sessionCwd)`
 * 一致：缺席/非字符串/空串 → 会话 cwd；绝对路径 → 原样；相对路径 → 拼在会话 cwd 之后。
 */
export async function resolveWorkdir(
  exec: { readonly agent?: unknown },
  ensure: (agent: unknown) => Promise<string | undefined>,
  override?: unknown,
): Promise<string> {
  const { agent } = exec;
  let resolved: string | undefined;
  if (agent !== undefined) {
    try {
      const ensured = await ensure(agent);
      resolved = typeof ensured === "string" && ensured !== "" ? ensured : undefined;
    } catch {
      // 服务缺席或 ensure 抛错：退下一级，绝不因此拒绝执行命令。
    }
    if (resolved === undefined) {
      const raw = headerCwd(agent);
      resolved = typeof raw === "string" && raw !== "" ? raw : undefined;
    }
  }
  const sessionCwd = resolved ?? process.cwd();
  // 脏值（数字/null/对象）一律当没传：在 cwd 上猜等于把命令跑进一个模型没指定的目录。
  if (typeof override !== "string" || override === "") {
    return sessionCwd;
  }
  return path.isAbsolute(override) ? override : `${sessionCwd}${path.sep}${override}`;
}
