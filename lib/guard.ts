/**
 * 压缩结果的护栏：压完之后再过一道判据，防止「压是压了、信息没了」。
 *
 * 四道通用（空输出 / 收益不足 / 伪造成功 / 类别已登记）+ 两道分类专属（vcs 查 hash 守恒、
 * listing 查折叠）+ summary 的相邻重复行折叠。
 *
 * 收益一律按 **UTF-8 字节**算（`Buffer.byteLength`）：模型可见面里混着中文测试名与 emoji，
 * 用 `String.length` 会把 300 个汉字当成 300 字节，让明显没压下来的结果通过 `minGainRatio`。
 * 这一点有实测依据：`rtk pipe -f vitest` 把失败的断言原文整段吃掉时，压缩率判据是放行的。
 *
 * **设计教训（别再走回去）**：上一版用「负面词不得从有变无」做判据（原文出现 `error`/`Traceback`
 * 就必须在压缩结果里也出现），同一批夹具里误拒了 **6 例有价值的压缩**——cargo-test 失败、
 * pytest 失败、vitest 失败全被拒。原因是测试/lint 过滤器的设计目标就是把细节压掉、只留失败清单，
 * 按词表判必然全灭。正确判据是「原文有 N 个失败，压缩后仍能看出 ≥N 个失败」（看计数与结构），
 * 不是「每个 error 词都要在」。这条错误的成本是「6 例本可接受的压缩被拒而测试仍然显示正常」，
 * 所以每类护栏都必须有独立夹具与写死的期望值，且逐类定型——不要用一个词表兜所有类别。
 */
import { classOf } from "./filter-class.ts";
import type { FilterClass } from "./filter-class.ts";

/**
 * 护栏结论；`ok: true` 时 `output` 是最终要替换进上下文的那一段。
 *
 * `recoverable: true` 只在被拒时出现，表示「这条拒的理由是信息有损，而原文可以落库取回」。
 * 调用方据此决定要不要落库后放行；放行那一步取收尾结果用 `keptOutputOf`（见它自己的注释）。
 */
export type GuardResult =
  | { ok: true; output: string }
  | { ok: false; reason: string; recoverable?: true };

/**
 * 「成功宣告」词表。输出里出现它们、而输入里含失败标记 —— 就是伪造成功。
 * prettier 是已知的伪造成功案例（原始输出有违例、rtk 却回 `All files formatted correctly`）。
 * 它现在留在 `PIPE_TABLE` 里（rtk 1.2.1 的 `pipe -f` 名单要求对齐），**这一条就是它的安全网**：
 * 违例输出里带 warn / issues found，于是整段压缩被判 `fabricated-success` 拒绝；输入本来就
 * 没有失败标记时压缩才放行。同一张表也兜其它工具的这一类缺陷。
 */
const SUCCESS_CLAIMS: readonly string[] = [
  "All files formatted correctly",
  "No issues found",
  "No errors found",
  "No tests collected",
  "compilation completed",
  ": 0 errors",
];

/** 输入里的失败标记。与 `SUCCESS_CLAIMS` 配对使用，两个条件都成立才判伪造。 */
const FAILURE_MARK =
  /error|FAIL|failed|panic|Traceback|AssertionError|denied|refused|not found|No such file|warn|issues found/u;

/**
 * listing 的折叠标记。**每条正对一个真实产出点**，不是同一句话的几种写法：
 *
 * | 标记 | 产出点 |
 * |---|---|
 * | `  +190` / `  +2` | `pipe -f find` 平铺文件（每目录 >10 文件）、`pipe -f grep` 单文件 >10 命中 |
 * | `+28 more dirs` | `pipe -f find` 目录数 > CAP_LIST；文件版是 `... +40 more files` |
 * | `... (150 more)` / `... (12 filtered)` / `... (9 more, 3 filtered)` | `rtk ls` 的 hidden_hint 三个臂 |
 * | `[+150 hidden: rtk recall <hash>]` | `rtk ls` 默认 env（SQLite 模式且 hidden_lines > 0） |
 * | `[+56 lines omitted]` | `pipe -f git-log` |
 * | `[9 more lines]` | `smart_truncate` |
 * | `[x200]` | `rtk hook` 的 `dedup` method（`engine/src/methods/dedup.rs`，连续 ≥3 行相同合并成一行 + 这个计数） |
 *
 * 一条正则覆盖不了它们：措辞、括号形态、有没有 recall 指针各不相同。曾经这里只有
 * `^\s*\+\d+(?:\s+more\S*)?$` 一条，于是 9 种标记里漏了 7 种——那等于「rtk 新换一种
 * 折叠写法，护栏就静默放行」。`… +50 more failures` 这类 pytest/vitest 摘要**不在**此列：
 * 它属 summary 类，走的是摘要行去重，不是 listing 折叠判据。
 */
const LISTING_COLLAPSE: readonly RegExp[] = [
  /^\s*\+\d+$/u,
  /^\s*\+\d+\s+more\s+(?:dirs|files)$/u,
  /^\s*\.{3}\s*\(\d+\s+more\)$/u,
  /^\s*\.{3}\s*\(\d+\s+filtered\)$/u,
  /^\s*\.{3}\s*\(\d+\s+more,\s*\d+\s+filtered\)$/u,
  /^\s*\[\+\d+\s+hidden: .*\]$/u,
  /^\s*\.{3}\s*\+\d+\s+more\s+files$/u,
  /^\s*\[\+\d+\s+lines?\s+omitted\]$/u,
  /^\s*\[\d+\s+more\s+lines\]$/u,
  // `dedup` 的计数标记。它**不是**省略：被折掉的 N 行与留下的那行完全相同，信息量是 1 行。
  // 但护栏不该知道这个区别——`[x200]` 出现就说明行数塌缩了，交给 spill 兜底才是同一条纪律。
  /^\s*\[x\d+\]$/u,
];

/** 行数塌缩的判据：输出非空行不到输入的 95%。95% 而非「一半」：条目类输出要么全留、
 * 要么显式折叠，掉 5% 就已经是丢条目了，而「掉一半」放过的量足够让一次 find 少掉半棵树。 */
const COLLAPSE_RATIO = 0.95;

/** 空命中时的兜底：`Set` 不接受 undefined，而 `match` 无命中返回 null。 */
const EMPTY_HASHES: readonly string[] = [];

/** 短 hash / 提交号。7 位起，避免把普通单词当 hash。 */
const HASH_RE = /\b[0-9a-f]{7,40}\b/gu;

/**
 * 行数塌缩判据的适用范围。
 *
 * `grep` / `rg` **刻意不在其中**：grep 的输出是 `[file] path (N):` 头 + 缩进的命中行，
 * 行数常比输入**多**（实测 300 行输入 → 421 行输出），套行数判据会把每一次 grep 都判成丢弃。
 * 它们只靠上面的标记正则。
 *
 * `fd` 也不在：`rtk pipe` 只认 `find` 这个名字（`filterOf` 把 fd 归到 find），写在这里也匹配不到。
 * `ls` 留着是因为 `rtk` 有它自己的 listing 过滤器，将来若进 `PIPE_TABLE` 就直接生效。
 * `log` 在：`rtk pipe -f log` 把整段日志收成 `Log Summary` + 三行计数，原始行全丢——
 * 与 listing 折叠同一件事，必须落 spill 后再放行。
 */
const LINE_COLLAPSE_FILTERS: ReadonlySet<string> = new Set([
  "find",
  "ls",
  "git-status",
  "log",
  "window",
  "hook",
]);

/** 行数塌缩的下限：少于这个行数的输出不值得按「塌缩」判。 */
const MIN_COLLAPSE_LINES = 20;

/** 输出里出现的全部 hash。 */
function hashSet(text: string): ReadonlySet<string> {
  return new Set(text.match(HASH_RE) ?? EMPTY_HASHES);
}

/**
 * rtk 的 `FAILURES (N):` 题头，N 是**输出行数**而不是失败测试数。
 *
 * 依据在 rtk 自己的解析器（`src/cmds/rust/cargo_cmd.rs` 的 `parse_cargo_failures`）：进入
 * `failures:` 段之后，每遇到 `---- xxx stdout ----` 就开一个新条目，**后续每个非空行又各自
 * 算一个条目**，只有空行才收尾。于是一个失败块（头部 + `panicked at` + 断言 + left/right）
 * 被切成 2~3 条，题头数字因此大于失败数。
 *
 * 实测（本仓 15 失败夹具）：原文 15 个 `---- ` 块，`rtk pipe -f cargo-test` 打出
 * `FAILURES (31):`；40 失败夹具打出 `(81)`。模型把 31 读成「31 个测试失败」是这行唯一
 * 有害的读法，所以在它后面补一句对账——**改数字不行**：我们并不知道 rtk 那条解析路径
 * 每一步的意图，改了就变成「插件编了一个它没验证过的数」。
 */
const FAILURES_HEADER = /^FAILURES \((?<count>\d+)\):$/mu;

/** cargo 的失败块头：`---- <测试名> stdout ----`。它的条数就是失败测试数。 */
const CARGO_FAILURE_BLOCK = /^---- .+ stdout ----$/gmu;

/** rtk 折叠掉后续失败块时留的标记。 */
const MORE_FAILURES = /^\s*… \+\d+ more failures$/mu;

/**
 * 在 `FAILURES (N):` 后面补一句对账，说清 N 是什么、以及真正的失败测试数。
 *
 * 只在**能对上账**的情况下补：输入里数出了失败块、且块数与 N 不等。数不出来（不是 cargo 的
 * 形状、或输入被别的工具改过）就原样放行——补一句「我不知道」比不补更吵。
 * @param input - 压缩前的原文（唯一可靠的事实来源）
 * @param output - 压缩后的正文
 * @returns 可能在题头后多一行说明的输出
 */
function clarifyFailureCount(input: string, output: string): string {
  const header = FAILURES_HEADER.exec(output);
  if (header === null) {
    return output;
  }
  const tests = input.match(CARGO_FAILURE_BLOCK)?.length ?? 0;
  if (tests === 0 || String(tests) === header.groups?.["count"]) {
    return output;
  }
  const truncated = MORE_FAILURES.test(output)
    ? ", and not every failing block is expanded below"
    : "";
  const note = `note: the count above counts output lines, not failing tests — this run has ${String(tests)} failing tests${truncated}.`;
  return output.replace(FAILURES_HEADER, `$&\n${note}`);
}

/** 只折**相邻**重复行：非相邻的 `a b a` 是有信息量的（顺序本身说明问题）。 */
function collapseAdjacentDuplicates(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (kept.at(-1) !== line) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

/** 输出是否带折叠标记（九族里任一条命中）。 */
function hasFoldMark(output: string): boolean {
  return output.split("\n").some((line) => LISTING_COLLAPSE.some((mark) => mark.test(line)));
}

/** **非空**行数：两侧都常带末尾换行与空段，按全部行数比会把差距算小、把真丢条目放过。 */
function nonEmptyLineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/** 路径类 listing 的行数塌缩：输入够长、输出非空行丢掉 5% 以上。 */
function collapsedLines(input: string, output: string): boolean {
  const before = nonEmptyLineCount(input);
  const after = nonEmptyLineCount(output);
  return before >= MIN_COLLAPSE_LINES && after < before * COLLAPSE_RATIO;
}

/** 收益不足：按 UTF-8 字节比。 */
function lowGain(input: string, output: string, minGainRatio: number): boolean {
  return Buffer.byteLength(output, "utf8") >= Buffer.byteLength(input, "utf8") * minGainRatio;
}

/** 伪造成功：输出宣称成功、而输入里确有失败痕迹。 */
function fabricatedSuccess(input: string, output: string): boolean {
  return SUCCESS_CLAIMS.some((claim) => output.includes(claim)) && FAILURE_MARK.test(input);
}

/** vcs 丢 hash：输入里的每个 hash 都必须在输出里还在。 */
function lostHash(input: string, output: string): boolean {
  const after = hashSet(output);
  return [...hashSet(input)].some((hash) => !after.has(hash));
}

/** listing 折叠：带标记，或路径类 listing 发生了行数塌缩。 */
function foldedEntries(filter: string, input: string, output: string): boolean {
  return (
    hasFoldMark(output) || (LINE_COLLAPSE_FILTERS.has(filter) && collapsedLines(input, output))
  );
}

/** 一道判据：条件成立时给出拒绝原因。表驱动是为了让次序显式、也让复杂度落在数据上。 */
interface GuardRule {
  readonly reason: string;
  readonly violated: (input: GuardInput, filterClass: FilterClass) => boolean;
  /**
   * 这条拒是不是「信息有损、但原文可取回」。
   *
   * 只有 `lost-hash` 与 `folded-entries` 是。它们拦的事实都是「压缩体里少了东西」，
   * 而少了的东西在原文里——原文一旦落进宿主的 spill 存储，模型一条 `read` 就能看全。
   * 另三道不是这个形状：`empty-output`（压成空等于没有结果）、`low-gain`（省得不够多，
   * 原文在不在都该拒）、`fabricated-success`（**原文本身就不支持那句成功宣告**，取回原文
   * 只会让模型看到矛盾的两个人说法），它们没有「取回就好」这一说。
   */
  readonly recoverable?: true;
}

/** 判据共用的输入面。 */
interface GuardInput {
  readonly filter: string;
  readonly input: string;
  readonly output: string;
  readonly minGainRatio: number;
}

// 次序即优先级：空输出最确定，收益不足次之，之后才是各分类专属判据。
// 「未登记类别」不在这张表里——它连分类都没有，要在求值前单独判。
const GUARD_RULES: readonly GuardRule[] = [
  { reason: "empty-output", violated: (now) => now.output === "" },
  { reason: "low-gain", violated: (now) => lowGain(now.input, now.output, now.minGainRatio) },
  { reason: "fabricated-success", violated: (now) => fabricatedSuccess(now.input, now.output) },
  {
    reason: "lost-hash",
    recoverable: true,
    violated: (now, filterClass) => filterClass === "vcs" && lostHash(now.input, now.output),
  },
  {
    reason: "folded-entries",
    recoverable: true,
    violated: (now, filterClass) =>
      filterClass === "listing" && foldedEntries(now.filter, now.input, now.output),
  },
];

/** 第一个被违反的判据；全部通过时 undefined。 */
function firstViolation(now: GuardInput, filterClass: FilterClass): GuardRule | undefined {
  return GUARD_RULES.find((rule) => rule.violated(now, filterClass));
}

/**
 * 通过之后真正要交出去的那一段：summary 类做两步收尾，其余类原样。
 *
 * 单独导出是给「放宽放行」那条路用的：那一支已经知道判定会通过（能走到那儿，说明第一处
 * 违规是可被取回通道救回的那两条，而其余五道的结论与第一次判定时逐条相同），若再返回一个
 * 联合类型，调用点就得写一个**永远走不到**的兜底分支——那既没人测得到，也说不清它想兜什么。
 */
export function keptOutputOf(options: {
  readonly filter: string;
  readonly input: string;
  readonly output: string;
}): string {
  return classOf(options.filter) === "summary"
    ? clarifyFailureCount(options.input, collapseAdjacentDuplicates(options.output))
    : options.output;
}

/**
 * 六道判据，任一不通过即拒绝；全通过时按类别决定收尾处理。
 *
 * summary 类的收尾有两步：先折相邻重复行（rtk 会把 `test result:` 重复打），再给
 * `FAILURES (N):` 补一句对账（那个 N 是输出行数，不是失败测试数，见 `clarifyFailureCount`）。
 *
 * **这一层不判「原文能不能取回」**：它只回答「压成这样行不行」。`recoverable` 是给调用方的
 * 一个信号——这一拒的成因是「少了东西」，而少的东西在原文里。要不要靠落库放行，是调用方的
 * 事：本插件在 `acceptCompressed` 里先落库、拿到 locator 才放行，并把路径写进压缩体首行。
 * 护栏自己不去落库，是因为它没有 `ctx`、也不该有。
 *
 * 这道函数**不决定要不要放宽**：它只把「这一拒是有损可救的」标成 `recoverable`。放宽发生在
 * 调用方——先把原文落进 spill、拿到 locator，再用 `keptOutputOf` 取收尾后的那一段。
 */
export function guardCompressed(options: {
  readonly filter: string;
  readonly input: string;
  readonly output: string;
  readonly minGainRatio: number;
}): GuardResult {
  const filterClass = classOf(options.filter);
  const violated = filterClass === undefined ? undefined : firstViolation(options, filterClass);
  const keep = keptOutputOf(options);
  if (filterClass === undefined) {
    return { ok: false, reason: "unclassified" };
  }
  if (violated === undefined) {
    return { ok: true, output: keep };
  }
  return violated.recoverable === true
    ? { ok: false, reason: violated.reason, recoverable: true }
    : { ok: false, reason: violated.reason };
}
