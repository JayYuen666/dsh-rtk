import { statSync } from "node:fs";
import path from "node:path";

/** 结构性拒绝的四种形态；`rewrite-gate` 把它们折进 `RewriteSkipReason`。 */
export type StructuralReject = "empty-command" | "compound" | "detail-flag" | "already-rtk";

/**
 * 复合命令拆出来的一段。
 *
 * `sep` 是这一段**前面**那个分隔符的原样文本（首段为空串）。留原样而不是归一化，
 * 是为了让校验层能逐字核对「分隔符序列没被动过」——把 `&&` 归一成 `;` 就没有这层保护了。
 */
export interface CommandSegment {
  /** 前导分隔符原样文本（`" && "` / `" | "` / `"; "` / `"\n"`；首段为 `""`）。 */
  readonly sep: string;
  /** 段文本原样（不含分隔符，保留原有前后空白）。 */
  readonly text: string;
}

/** 数字（fd 复制形态 `2>&1` 的目标位）。 */
const DIGIT = /\d/u;

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
 * `undefined` 表示这是**真重定向**（`>file` / `>>file` / `&>file`），拆分必须整条放弃：
 * 重定向会写盘，改写任何一段都可能改变副作用落点。
 */
function skipFdCopy(command: string, index: number): number | undefined {
  const after = command.charAt(index + 1);
  const digit = command.charAt(index + 2);
  return after === "&" && DIGIT.test(digit) ? index + 3 : undefined;
}

/**
 * 这个位置是不是顶层分隔符；是就回 `[分隔符, 长度]`。
 *
 * 用元组而不是对象：调用点要把两位各自拆给两个局部变量（`sep` 与推进要用的下标），
 * 对象形式在「解构一位、另一位拼算」时会被 `prefer-destructuring` 判红。
 */
function separatorAt(command: string, index: number): readonly [string, number] | undefined {
  return SEPARATORS.filter((candidate) => command.startsWith(candidate.token, index))
    .map((candidate): readonly [string, number] => [candidate.sep, candidate.token.length])
    .at(0);
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
    next = index + 2;
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
 * 不可拆的四类，每一类都是「拆开之后插件无法证明语义没变」：
 *   · 反引号与 `$(...)`——命令替换的产物要等运行才知道，改写其中一段等于改另一段的输入；
 *   · 重定向（`>`、`<`，以及写成 `&>` 的形态）——写盘目标一变，副作用就变了；
 *   · 单独一个 `&`（后台执行）——返回时序与信号语义都不一样；
 *   · 引号不配对——连边界在哪都判不出来。
 *
 * **允许 fd 复制**（`2>&1` / `>&2`）：它只把 stderr 并到 stdout，不写文件，rtk 对它也照常改写
 * （实测 `cargo test 2>&1` → `rtk cargo test 2>&1`）。这与「重定向」是两件事，不能一并拒。
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

// 详情意图 flag：rtk rewrite 不给它们任何豁免（`cargo test -- --nocapture` 照改），
// 改完后 marker 与断言差异直接消失——实测 256B→43B、1190B→224B。
//
// 两条边界都要：`-v` 前面得是空白（否则 `--version` 的第二个 `-` 会让它命中），
// 后面也得是空白或行尾（否则 `-vx` 这种组合短选项会被误判成详情意图）。
//
// `--reporter` / `--tb` 带取值，**值不加空格直接跟在 `=` 后面**（`--reporter=json`、
// `--tb=long` 是这两个 flag 的常规写法）。把它们写成 `--reporter=` 再要求尾随空白的形态，
// 两条最常见的形式反而漏判。所以用 `(?:=\S*)?` 吃掉取值，再落到词边界。
const DETAIL_FLAG =
  /(?:^|\s)(?:-v|-vv|-vvv|--verbose|--nocapture|--collect-only|--reporter(?:=\S*)?|--tb(?:=\S*)?|--capture=no|-s|-rA)(?:\s|$)/u;

// 词边界必须有：`rtkx` 是另一个程序，把它当成已改写会白白放过一次改写机会。
const RTK_PREFIX = /^rtk(?:\s|$)/u;

/**
 * 四道结构性不变式，按「空 → 已 rtk → 详情 → 拆不开」的次序判，先命中先返回。
 *
 * **`compound` 的语义变了**：从「含分隔符就拒」收窄成「拆不成若干独立段才拒」。可拆的复合命令
 * （`cd X && cargo test`、`cargo test | tail -5`）交给 rtk 逐段改写，再由 `lib/rewrite-verify.ts`
 * 逐段核对——那边拒的是「某一段被改成了非前插形态」，比整条拒精确得多。拆不开的（反引号、
 * `$(...)`、重定向、后台 `&`、引号不配对）仍然整条原样执行。
 *
 * 单出口写法：这个工作区的 `consistent-return` 带 `treatUndefinedAsUnspecified: true`，
 * 函数里一旦出现 `return undefined;`，其余分支的返回值就被判成不一致。
 */
export function structuralReject(command: string): StructuralReject | undefined {
  const trimmed = command.trimStart();
  const segments = splitCommand(command);
  let reject: StructuralReject | undefined;
  if (trimmed.trimEnd() === "") {
    reject = "empty-command";
  } else if (RTK_PREFIX.test(trimmed)) {
    reject = "already-rtk";
  } else if (DETAIL_FLAG.test(command)) {
    reject = "detail-flag";
  } else if (segments === undefined || segments.some((segment) => segment.text.trim() === "")) {
    // 空段（`cd x &&` / `&& cargo test`）与拆不开的构造同样整条放行：前者是 shell 自己的语法错，
    // 后者拆开之后插件无法证明语义没变。
    reject = "compound";
  }
  return reject;
}

/** pipe 层认得的那两条：用户要细节、以及输出已经被 rtk 压过一遍。 */
export type PipeStructuralReject = "detail-flag" | "already-rtk";

/**
 * pipe 层的结构性拒绝：`structuralReject` 的一个真子集，只留对「结果侧压缩」有意义的两条。
 *
 * 为什么不是直接复用 `structuralReject`：`compound` 在前缀层必须拒（`cd /tmp && cargo test`
 * 只改后半句会改语义），但 **pipe 不执行命令、只看输出**——`cd /tmp && cargo test` 的输出去压
 * 一压完全安全，按 `compound` 拒掉等于白丢一档收益。
 *
 * 留下这两条的理由各自独立：
 *   · `detail-flag`——用户明确要看细节（`--nocapture` / `-vv` / `--tb=long`），**任何压缩都是背叛**。
 *     实测 rtk 的 cargo-test filter 会把 189B 里那行 `DEBUG-VISIBLE-MARKER` 连同整段 stdout 压成
 *     37B 的 `cargo test: 1 passed`，标记出现 0 次。前缀层已按这条拒改写，pipe 层也必须拒。
 *   · `already-rtk`——命令本身就以 `rtk ` 开头，输出**已经被 rtk 压过一遍**。再喂给 pipe 就是
 *     「压两次比压一次更坏」：实测 938B → `rtk cargo test` 545B → 再喂 `rtk pipe -f cargo-test`
 *     97B，`panicked at` 与 `left:/right:` 全丢（§4.1 去重护栏的同源理由）。
 */
export function pipeStructuralReject(command: string): PipeStructuralReject | undefined {
  const trimmed = command.trimStart();
  let reject: PipeStructuralReject | undefined;
  if (RTK_PREFIX.test(trimmed)) {
    reject = "already-rtk";
  } else if (DETAIL_FLAG.test(command)) {
    reject = "detail-flag";
  }
  return reject;
}

/**
 * mode 里有没有任何一个执行位（owner / group / other 任一枚）。
 *
 * 用整除取余而不是 `mode & 0o111`：本仓基线禁位运算（`eslint(no-bitwise)`），而这一判的语义
 * 值得逐位写清楚——权限三元组每组的 4/2/1 里只有 1 是「执行」，所以三组各自的低位只要有一个
 * 是 1 就算可执行。
 */
function hasExecBit(mode: number): boolean {
  const permission = mode % 0o1000;
  const owner = Math.floor(permission / 0o100) % 2;
  const group = Math.floor(permission / 0o010) % 2;
  const other = permission % 2;
  return owner + group + other > 0;
}

/**
 * 「这个文件算不算可执行」——平台语义在这里分叉，所以单独抽出来。
 *
 *   · **POSIX**：看 mode 的执行位（`0o111`）。不用 `accessSync(X_OK)`，理由两条：它对
 *     **目录**也成立（早先就因此把目录当成了二进制），且它把「当前进程是不是 root」这种
 *     运行环境带进了判定——同一份目录树换个 uid 就该有同一个答案。mode 位是文件自己的事实。
 *   · **win32**：NTFS 没有 POSIX 执行位，`chmodSync(file, 0o644)` 之后 `accessSync(X_OK)`
 *     照样通过（Node 在 win32 上只判「存在且可读」）。那条平台上的约定是「扩展名对 +
 *     文件存在」，执行位不是判据。
 *
 * 抽出来的第二个理由是可测：两条 policy 都能在任何平台上直接跑，测试不必再按宿主 OS 跳过
 * （早先那条「无执行位就不算」在 Windows 上恒假，只能 `skipIf`）。
 */
export function executableOf(platform: NodeJS.Platform): (full: string) => boolean {
  if (platform === "win32") {
    return (full) => {
      try {
        return statSync(full).isFile();
      } catch {
        return false;
      }
    };
  }
  return (full) => {
    try {
      const info = statSync(full);
      return info.isFile() && hasExecBit(info.mode);
    } catch {
      return false;
    }
  };
}

/**
 * 在 PATH 上找**可执行文件**；找不到返回 `undefined`（调用方据此整层不装）。
 *
 * 两判都要，缺一条就会把目录当成二进制：
 *   · 可执行判定（见 `executableOf`）——**目录也能通过 `accessSync(X_OK)`**（POSIX 上目录的
 *     搜索位就是 X）。实测把一个目录命名成 `rtk` 放进 PATH，旧实现把它当成了 rtk。
 *   · `statSync().isFile()` 回答「它到底是不是文件」——两条 policy 里都带着这一判。
 * 少了第二条的后果是静默的：装配期门禁误判「rtk 装好了」，遮蔽层照装，而每次改写 spawn 那个
 * 目录都拿 `EACCES`、fail-open 原样执行；`status().rtkPath` 报出那条伪路径，版本探测又探不到
 * （`supported === null`），于是卡片既不报「没装」也不报「版本过低」——看着一切正常，压缩从不生效。
 *
 * `platform` 可注入只为可测：win32 的三档后缀在 POSIX 机器上永远走不到，若把平台判定
 * 焊死在 `process.platform` 上，那一条分支在本仓覆盖率统计里永远是半条，只能靠放宽阈值
 * 或 ignore 注释糊过去——两样这个工作区都不做。
 *
 * `executable` 的缺省跟着**宿主**（`process.platform`）而不是 `platform` 参数：这两个参数
 * 回答的是两个不同的问题。`platform` 说「目标平台上的 rtk 叫什么名字」（`.exe`/`.cmd`/裸名，
 * 那条机器上 PATH 的约定）；`executable` 说「我脚下这个文件系统怎么算可执行」（POSIX 看
 * mode 位、NTFS 只看存在）。让后者跟着前者走，等于在 POSIX 机器上假装 win32 时用 NTFS 的
 * 规则去读 APFS——名字档位测对了，可执行判定却是任何一台真机都不会有的组合。
 *
 * `executable` 的缺省读的是**模块加载时**记下的宿主平台（`HOST_EXECUTABLE`），不是调用那一刻的
 * `process.platform`。这一位有真实牙齿：`process.platform` 是 `configurable` 的，测试里
 * 可能把它改掉；若缺省跟着调用那一刻读，运行期伪造平台就会让可执行判定落到另一个文件系统
 * 语义上（POSIX 的 mode 位对 NTFS、或反过来），任何一台真机都不会有这个组合。实测复现过：
 * 伪造 win32 加载模块、再把平台改成 linux，`findOnPath("fakebin")` 对一个 0644 文件返回 `undefined`。
 */
const HOST_EXECUTABLE: (full: string) => boolean = executableOf(process.platform);

export function findOnPath(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  executable: (full: string) => boolean = HOST_EXECUTABLE,
): string | undefined {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((each) => each !== "");
  // Windows 的 PATHEXT 常见三档一并在候选里试（`.exe`/`.cmd`，最后一档是裸名）；
  // POSIX 只看名字本身。
  const exts = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  let found: string | undefined;
  for (const dir of dirs) {
    for (const ext of exts) {
      if (found !== undefined) {
        break;
      }
      const full = path.join(dir, bin + ext);
      if (executable(full)) {
        found = full;
      }
    }
  }
  return found;
}
