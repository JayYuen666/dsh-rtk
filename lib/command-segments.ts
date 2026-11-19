/**
 * 复合命令的分段器：纯字符串逻辑，**不碰 node 内置模块**。
 *
 * 为什么单独一个模块：`lib/prefix-safety.ts` 要 `node:fs` / `node:path` 才能判可执行位，
 * 而客户端也要拆段——`lib/command-filter.ts` 的 `filterOf` 现在要跳过静默设置段，它被
 * `src/client-entry.ts` 拖着进 client 产物。从 `prefix-safety.ts` 取会让 `node:fs` 成为
 * client 产物的外置依赖，构建期那道人名登记门会当场拦下（实测：`client.js` 里有未登记的
 * 外置 require `node:fs`）。拆出来之后两边各取所需，产物里那条边就消失了。
 *
 * 分隔符记原样文本的理由、以及哪四类构造不能拆，见下方 `CommandSegment` / `splitCommand` 的注释。
 */

/**
 * 复合命令拆出来的一段。
 *
 * `sep` 是这一段**前面**那个分隔符的原样文本（首段为空串）。留原样而不是归一化，
 * 是为了让校验层能逐字核对「分隔符序列没被动过」——把 `&&` 归一成 `;` 就没有这层保护了。
 */
export interface CommandSegment {
  /**
   * 前导分隔符：**只有运算符本身**（`"&&"` / `"||"` / `"|"` / `";"` / `"\n"`；首段为 `""`），
   * 运算符周围的空白留在 `text` 里。所以 `a && b` 拆成 `{ sep: "", text: "a " }` 与
   * `{ sep: "&&", text: " b" }`——`sep` 与 `text` 逐字相接就能拼回原串，调用方靠这条
   * 不变式插环境变量（`lib/rtk-paths.ts`）与还原被拦下的段（`lib/rewrite-gate.ts`）。
   */
  readonly sep: string;
  /** 段文本原样（不含分隔符，保留原有前后空白）。 */
  readonly text: string;
}

/** 数字（fd 复制形态 `2>&1` 的目标位）。 */
const DIGIT = /\d/u;

/**
 * fd 复制目标词之后的合法词尾：结束（空串）、空白，或下一个 shell 元字符。
 *
 * bash 判定 `>&` 后面那个词是不是纯数字**看的是整个词**，`1x` 会被当成文件名。
 */
const WORD_TAIL = /[\s&|;<>]/u;

/**
 * `#` 只有在**词首**才是注释起点：`echo a#b` 里它是普通字符（实测 bash 打印 `a#b`）。
 *
 * 词首 = 行首，或前一个字符是空白 / 分隔符 / 括号。
 */
const COMMENT_HEAD = /[\s;&|()]/u;

/** 分隔符表：**长的排前面**（`&&` 在 `&` 之前没用，但 `||` 必须在 `|` 之前）。 */
const SEPARATORS: readonly { readonly token: string; readonly sep: string }[] = [
  { token: "&&", sep: "&&" },
  { token: "||", sep: "||" },
  { token: "|", sep: "|" },
  { token: ";", sep: ";" },
  { token: "\n", sep: "\n" },
];

/**
 * 跳过一整段引号（`start` 指向开引号），返回闭引号之后的位置。
 *
 * `undefined` = 引号不配对，或双引号里出现命令替换（`$(...)` / 反引号）——两者都让「段边界在哪」
 * 无从判断，调用方整条放弃拆分。单引号里一切都是字面量，连反斜杠都不转义。
 */
function skipQuoted(command: string, start: number): number | undefined {
  const quote = command.charAt(start);
  let index = start + 1;
  let closed = false;
  let broken = false;
  while (index < command.length && !closed && !broken) {
    const char = command.charAt(index);
    if (quote === '"' && char === "\\") {
      index += 2;
    } else if (char === quote) {
      closed = true;
      index += 1;
    } else if (
      quote === '"' &&
      (char === "`" || (char === "$" && command.charAt(index + 1) === "("))
    ) {
      broken = true;
    } else {
      index += 1;
    }
  }
  return closed && !broken ? index : undefined;
}

/**
 * 跳过 fd 复制（`>&2` / `2>&1` 里 `>` 之后那三位），返回之后的位置。
 *
 * `undefined` 表示这是**真重定向**（`>file` / `>>file` / `&>file` / `>&2log` / `2>&1x`），
 * 拆分必须整条放弃：重定向会写盘，而下一段读到的还是被压过的内容，副作用与数据流一起变。
 *
 * 目标位必须是**完整的纯数字词**——`>&` 里那个词只要是 `2log` / `1x` 这类非纯数字，
 * bash 就把它当文件名（实测 `echo hi >&2log` 真的建出了 3 字节的 `2log`，`2>&1x` 报
 * 「有歧义的重定向」）。只看第一位数字就会把这两条当成 fd 复制放过去。
 */
function skipFdCopy(command: string, index: number): number | undefined {
  const after = command.charAt(index + 1);
  const digit = command.charAt(index + 2);
  // 词尾：结束、空白，或下一个 shell 元字符（实测 `echo hi 2>&1|head` 是「复制 fd 再管道」）。
  const tail = command.charAt(index + 3);
  const wholeWord = tail === "" || WORD_TAIL.test(tail);
  return after === "&" && DIGIT.test(digit) && wholeWord ? index + 3 : undefined;
}

/**
 * 这个位置是不是顶层分隔符；是就回 `[分隔符, 长度]`。
 *
 * 用元组而不是对象：调用点要把两位各自拆给两个局部变量（`sep` 与推进要用的下标），
 * 对象形式在「解构一位、另一位拼算」时会被 `prefer-destructuring` 判红。
 *
 * 首次命中即返回：`SEPARATORS` 的顺序就是优先级（`||` 在 `|` 之前），所以第一个命中
 * 就是最长匹配。旧写法 `filter().map().at(0)` 会为每个字符都建一份临时数组。
 *
 * 单出口：这个工作区的 `consistent-return` 带 `treatUndefinedAsUnspecified: true`，
 * 函数里一旦出现 `return undefined;`，其余分支的返回值就被判成不一致（同 `prefix-safety.ts`）。
 */
function separatorAt(command: string, index: number): readonly [string, number] | undefined {
  const hit = SEPARATORS.find((candidate) => command.startsWith(candidate.token, index));
  return hit === undefined ? undefined : [hit.sep, hit.token.length];
}

/**
 * 这个位置是不是 shell 注释的起点（`#` 且处在一个词的开头）。
 *
 * 注释之后的整行都不属于命令，边界由 shell 的词法器定——插件不实现它，所以碰上就放弃拆分。
 */
function isCommentStart(command: string, index: number): boolean {
  if (command.charAt(index) !== "#") {
    return false;
  }
  const previous = index === 0 ? "" : command.charAt(index - 1);
  return previous === "" || COMMENT_HEAD.test(previous);
}

/**
 * 扫一个位置：返回「下一个要看的位置」，`undefined` 表示这里出现拆不开的构造。
 *
 * 返回 `index` 本身 = 这是个普通字符（或一个分隔符的开头），由调用方再判一次分隔符。
 * 拆成这么一枚小程序是为了让主循环只剩「跳过 / 碰壁 / 切段」三种动作——把它们塞在一个
 * 循环里会同时撞 `complexity` 与 `cognitive-complexity` 两道门。
 */
function advance(command: string, index: number): number | undefined {
  const char = command.charAt(index);
  let next: number | undefined = index;
  if (char === "'" || char === '"') {
    next = skipQuoted(command, index);
  } else if (char === "\\") {
    // 末尾孤立的 `\` 表示命令还没写完（续行在等下一行），段边界无从判断；推进到字符串
    // 之外会静默截断，调用方拿到的段数就与 shell 看到的不是一回事。
    next = index + 1 >= command.length ? undefined : index + 2;
  } else if (isCommentStart(command, index)) {
    // 实测 `bash -c 'echo ok # note; more'` 只打印 `ok`：`; more` 在注释里，不是第二段命令。
    // 切出来会让统计与 filter 判据都对着一个不存在的命令做决定。
    next = undefined;
  } else if (char === "`" || char === "<" || (char === "$" && command.charAt(index + 1) === "(")) {
    next = undefined;
  } else if (char === ">") {
    next = skipFdCopy(command, index);
  } else if (char === "&" && command.charAt(index + 1) !== "&") {
    // 光秃秃的 `&` 是后台执行；`&>file` 也落在这里（它不是 `&&`）。两者都不拆。
    next = undefined;
  }
  return next;
}

/**
 * 把命令按**顶层**分隔符（`&&` / `||` / `;` / `|` / 换行）拆成若干段。
 *
 * 返回 `undefined` = 这条命令**不能拆**，调用方按复合命令整体跳过改写（fail-open 原样执行）。
 * 不可拆的五类，每一类都是「拆开之后插件无法证明语义没变」：
 *   · 反引号与 `$(...)`——命令替换的产物要等运行才知道，改写其中一段等于改另一段的输入；
 *   · 重定向（`>`、`<`，以及写成 `&>` / `>&2log` / `2>&1x` 这种目标词不是纯数字的形态）
 *     ——写盘目标一变，副作用就变了；
 *   · 单独一个 `&`（后台执行）——返回时序与信号语义都不一样；
 *   · 引号不配对——连边界在哪都判不出来；
 *   · shell 注释（词首的 `#` 到行尾）——那一段根本不属于命令，边界归 shell 词法器；
 *   · 末尾孤立的 `\`——命令还没写完，段边界无从判断。
 *
 * **允许 fd 复制**（`2>&1` / `>&2`）：目标词是纯数字，它只把 stderr 并到 stdout，不写文件，
 * rtk 对它也照常改写（实测 `cargo test 2>&1` → `rtk cargo test 2>&1`）。这与「重定向」是两件事，
 * 不能一并拒——但**判据必须看整个目标词**，只看第一位数字就会把 `>&2log` 放进来。
 *
 * 为什么值得拆：rtk 自己**就是逐段改写的**（`discover/registry.rs` 的 `rewrite_compound`），
 * 实测 `cd /tmp && cargo test` → `cd /tmp && rtk cargo test`——只有承载输出的那一段被换掉，
 * `cd` 原样留在前面。模型在多仓开发时几乎每条命令都是这个形状，整条拒掉等于把最常见的一类
 * 命令排除在压缩面之外（本插件早期版本正是如此）。
 */
export function splitCommand(command: string): readonly CommandSegment[] | undefined {
  const segments: CommandSegment[] = [];
  let sep = "";
  let start = 0;
  let index = 0;
  let broken = false;
  while (index < command.length && !broken) {
    const resume = advance(command, index);
    const skipped = resume === undefined;
    const plain = resume === index;
    if (skipped) {
      broken = true;
    } else if (plain) {
      const found = separatorAt(command, index);
      if (found === undefined) {
        index += 1;
      } else {
        const [token, length] = found;
        segments.push({ sep, text: command.slice(start, index) });
        sep = token;
        start = index + length;
        index = start;
      }
    } else {
      index = resume;
    }
  }
  const finished = !broken;
  if (finished) {
    segments.push({ sep, text: command.slice(start) });
  }
  return finished ? segments : undefined;
}
