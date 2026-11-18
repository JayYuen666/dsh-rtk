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
 * 内建拒绝表的一条。
 *
 * 判据是**首词的逐字相等**，不用正则表——表要能被人一眼核对，正则表不能。
 */
interface DenyEntry {
  readonly first: string;
  readonly note: string;
}

/**
 * 内建拒绝表：只留「改写会让**结论**变错」的那几条。
 *
 * **口径（修订，用户裁定）**：这个插件的默认形态就是「rtk 支持什么就改写什么」，
 * 输出变短是缩略该做的事，**不是拒绝改写的理由**。所以这张表里不再有「丢 hash / 丢路径 /
 * 丢 warning」这类条目——那些命令 rtk 全都支持（`rtk rewrite` 对 `git log`、`git diff`、
 * `git show`、`ls`、`find`、`grep`、`rg`、`cargo clippy` 一律回 rc=3，实测），一律改写。
 *
 * 上一版这里曾有九条，前八条的依据是「输出会变短」，那是把插件的目标判反了；第九条 `aws`
 * 留下，因为它造成的不是信息量变化而是**退出码换了含义**：`aws` 不在 PATH 上时原生回
 * rc=127（command not found），经 rtk 回 rc=1（generic error）——模型会据此把「环境没装」
 * 读成「命令跑失败」。实测见 `src/cmds/cloud/aws_cmd.rs:250`：aws 存在时 rtk 原样透传
 * 退出码，所以这一条只在「命令不存在」这一态上成立。
 */
const DENY_TABLE: readonly DenyEntry[] = [
  { first: "aws", note: "退出码换含义：命令不存在时原生 rc=127、rtk 回 rc=1" },
];

// 切词用的正则提到模块级：`splitWords` 每条命令都会跑，写在函数体里等于每次重建。
const WHITESPACE = /\s+/u;

/** 按空白切词（连续空白当分隔，空串丢弃）。 */
function splitWords(command: string): string[] {
  return command
    .trim()
    .split(WHITESPACE)
    .filter((word) => word !== "");
}

/** 内建表判据；命中返回该条的实测理由（进日志/统计），未命中返回 undefined。 */
function denyTableReason(command: string): string | undefined {
  const [first] = splitWords(command);
  return DENY_TABLE.find((entry) => entry.first === first)?.note;
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
 * 结构判据对**整条**命令判（拆不开就是拆不开）。**只有全部段都不能改写时才整条跳**——
 * 只要有一段能改写，就把整条交给 rtk，再由 `restoreGatedSegments` 把不能改的那几段还原成
 * 原文。这个次序是被实测逼出来的：`rtk rewrite` 是**逐段**改写的，它会连同不能改的段一起
 * 加上 `rtk`（实测 `aws s3 ls && cargo test` → 两段都加），所以「整条交出去 + 逐段还原」
 * 才能既拿到能改的那部分、又不让不能改的段被改。
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
  const eligible = reasons.some((each) => each === undefined);
  return structural ?? (eligible ? undefined : reasons.find((each) => each !== undefined));
}

/**
 * 把「不能改写的那几段」还原成原文，其余段保留 rtk 的改写结果。
 *
 * **必须用 `segment.text` 原样**（含段尾空白），不能 `.trim()`：`verifyRewrite` 逐段比
 * `sep`，而还原时少掉一个空格会让那一段过不了「未改动段」的判据，整条被丢回原样执行。
 *
 * 段数对不齐（rtk 吐出了不同条数的段）时原样返回 rtk 的结果——那种形状交给
 * `verifyRewrite` 拒掉，而不是由这里猜。
 */
export function restoreGatedSegments(
  original: string,
  rewritten: string,
  options: RewriteGateOptions,
): string {
  const before = splitCommand(original);
  const after = splitCommand(rewritten);
  if (before === undefined || after === undefined || before.length !== after.length) {
    return rewritten;
  }
  const parts = before.map((segment, index): string => {
    const produced = after[index];
    const gated = segmentSkipReason(segment.text, options) !== undefined;
    // `produced` 的两处 `=== undefined` 是类型位的防御：段数在上面判过相等，`after[index]`
    // 一定在（`noUncheckedIndexedAccess` 不知道这件事，所以类型上仍带 `| undefined`）。
    /* v8 ignore next —— 走不到的分支，与 `lib/command-family.ts` 同口径。 */
    const text = gated || produced === undefined ? segment.text : produced.text;
    /* v8 ignore next —— 同上：越界取不到，这是类型位的兜底，不是一条真分支。 */
    const sep = produced === undefined ? segment.sep : produced.sep;
    return `${sep}${text}`;
  });
  return parts.join("");
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
