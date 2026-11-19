/**
 * 本地 head+tail 窗口：把「本来也没有过滤器可用」的大段日志压成头 N + 尾 M 行。
 *
 * 为什么需要另一条路：`rtk pipe` 只认 27 个固定 filter，`cat build.log` / `journalctl` /
 * `docker logs` / `ps aux` 这些命令一条都不在表里（真实账本里 `cat` 独占 35.4% 的 input token，
 * 是所有家族里最大的一块）。rtk 自己在 `rtk read` 上的默认档是 `--level none`（`src/lib.rs:204`
 * 的 `default_value = "none"`），也就是**逐字节不变**——前缀层把 `cat X` 改写成 `rtk read X`
 * 之后仍然是全量输出。所以这一段收益只能由本包自己做。
 *
 * 为什么只做日志类目标（用户裁决）：模型读源码时被截掉中间，比多看几千 token 更贵。
 * `cat src/foo.ts` 一律不动。判据是两条独立的证据，**按命令的语义分工**：
 *   · `journalctl` / `dmesg` / `docker logs` / `kubectl logs` / `ps` 的输出形态由命令本身
 *     决定，与操作数无关，命令命中即算；
 *   · `cat` / `tail` / `head` / `less` / `more` / `zcat` 读的是**调用者指定的文件**，同一条
 *     命令这次读日志、下次读源码，所以只能看操作数的扩展名。
 * 把后者也按命令判是个真缺陷（曾发生过）：`head -1000 src/app.ts` 会把 900 行源码砍成头
 * 50 + 尾 200，而模型没有任何迹象表明自己读到的是一份中间被挖掉的代码。
 *
 * 为什么必须配 spill：窗口丢掉的中间段是真丢了。没有取回通道的有损压缩不该进上下文，所以
 * 调用点（`host.ts` 的 `acceptCompressed`）在原文落不成 spill 时会整条放弃这次窗口。
 *
 * 窗口口径默认取 rtk `cap` method 的那一组（`engine/src/methods/cap.rs:10-12` 的
 * `HEAD_LINES = 50` / `TAIL_LINES = 200`）：同一份输出走 rtk hook 时是这两个数，走本包时也
 * 该是同样两个数，否则「换一条路径看到的东西不一样」这件事没人解释得清。
 *
 * **判据按段，不按整条**：模型的命令几乎都是复合形态（`cd X && cat Y`），而下面两个判据
 * 曾经只看整条的**首词**——首词是 `cd` 时它们一起回 false，于是日志白丢一次窗口机会、
 * 阅读材料反而落进清理链被 `dedup` 折成 `[xN]`。这两种副作用一个少省、一个改样，后者
 * 是硬伤，所以拆分用 `splitCommand`（与改写层同一把尺子，拆不开的形状两者都退回整条）。
 */
import { splitCommand } from "./command-segments.ts";

/** 默认保留的头部行数。与 rtk `cap` 的 `HEAD_LINES` 同值。 */
export const DEFAULT_WINDOW_HEAD_LINES = 50;

/** 默认保留的尾部行数。与 rtk `cap` 的 `TAIL_LINES` 同值。 */
export const DEFAULT_WINDOW_TAIL_LINES = 200;

/**
 * 日志类文件的扩展名。**白名单**：不在其中的（`.ts` / `.py` / `.go` / `.md` / `.txt` …）一律不动。
 *
 * `.txt` 曾经在里面，后来被拿掉了：账本里那些 `.txt` 是 `coverage/rust-summary.txt`、
 * `.scratch/*-gaps.txt`、`huge.txt` 这类报告，它们与 `.log` 的差别不在「一屏看不完」而在
 * 「要不要逐字读完」。同名扩展名既覆盖日志也覆盖正文时，按它判就会把正文截掉——那正是
 * 「压缩影响模型决策」的形状。带 `.log` 字样的报告仍走日志档（`*.log.txt` 不在白名单，
 * 但 `*.txt` 里那些要读的正文也不在）。
 *
 * 压缩后缀（`.gz` / `.zst` …）与轮转编号（`.1`）可以叠加：`zcat archive.log.gz.gz` 命中。
 */
const LOG_EXTENSION =
  /\.(?:log|out|err|jsonl|ndjson|trace|dump)(?:\.\d+)?(?:\.(?:gz|zst|bz2|xz|zip))*(?:\.\d+)?$/iu;

/**
 * **自身输出就是日志/进程清单**的命令：输出形态由命令决定，与操作数无关。
 *
 * 这一段不带目标判据是对的——`journalctl` 读的就是 journal、`ps` 列的就是进程，
 * 没有「同一个命令这次读日志下次读源码」的歧义。
 */
const SELF_LOG_COMMANDS: readonly RegExp[] = [
  /^(?:journalctl|dmesg)(?:\s|$)/u,
  /^docker\s+logs(?:\s|$)/u,
  /^kubectl\s+logs(?:\s|$)/u,
  /^ps(?:\s|$)/u,
];

/**
 * **带文件操作数**的读取/浏览命令：输出是什么取决于它读哪个文件，必须按扩展名判。
 *
 * `head` / `tail` / `less` 曾经无条件算日志，那是个真缺陷：`head -1000 src/app.ts`
 * 会把 900 行源码砍成「头 50 + 尾 200」，模型拿到的是一份中间被挖掉的代码文件——
 * 它没有任何迹象表明自己读到的是残件之外的东西。同一条命令既能读日志也能读源码时，
 * 判据只能是目标，不能是命令。
 */
const FILE_READ_COMMANDS: readonly RegExp[] = [
  /^(?:tail|head|less|more|zcat|zless|zmore)(?:\s|$)/u,
  /^cat(?:\s|$)/u,
];

/** 词的分隔符：空白与 shell 的管道/重定向符。 */
const WORD_SEP = /[\s|<>;&]+/u;

/**
 * 把一条命令拆成**段**：复合命令（`cd /tmp && cat build.log`）里每一段都是独立的输出来源。
 *
 * 拆不开的（命令替换 `$(...)`、真重定向 `>file`、后台执行 `&`）退回**整条当一段**——
 * `splitCommand` 对这些形状返回 `undefined`，那本来就是「插件证明不了拆开之后语义没变」
 * 的三类；判据在这里也不该比它更敢猜。
 * @param command - 模型给的原始命令
 * @returns 至少一段；空命令给 `[""]`
 */
function segmentsOf(command: string): readonly string[] {
  const parts = splitCommand(command);
  return parts === undefined ? [command] : parts.map((part) => part.text.trim());
}

/** 单段的日志判定：自带日志语义的命令命中，读文件的命令按操作数扩展名判。 */
function isLogSegment(segment: string): boolean {
  if (SELF_LOG_COMMANDS.some((pattern) => pattern.test(segment))) {
    return true;
  }
  if (!FILE_READ_COMMANDS.some((pattern) => pattern.test(segment))) {
    return false;
  }
  // 取**操作数**里的扩展名，跳过以 `-` 开头的选项：`cat -n build.log`、
  // `cat build.log | head` 都该命中，`cat src/app.ts` 不该。
  const operands = segment.split(WORD_SEP).slice(1);
  return operands.some((word) => !word.startsWith("-") && LOG_EXTENSION.test(word));
}

/** 单段的阅读材料判定：读文件的命令 + 一个日志扩展名都没有。 */
function isReadingSegment(segment: string): boolean {
  if (!FILE_READ_COMMANDS.some((pattern) => pattern.test(segment))) {
    return false;
  }
  const operands = segment.split(WORD_SEP).slice(1);
  return !operands.some((word) => !word.startsWith("-") && LOG_EXTENSION.test(word));
}

/**
 * 这条命令读出的是不是日志。
 *
 * **按段判**，不按整条的首词判：`cd /tmp && cat build.log` 的首词是 `cd`，按整条判会得出
 * 「既不是日志也不是阅读材料」，于是两条压缩路一起放过它——日志那份白丢一次窗口机会
 * （真宿主实测 55,213 B 的构建日志在 `cd` 前缀下一个字没压）。
 * @param command - 模型给的原始命令（不带前缀层的改写）
 * @returns 任一段是日志类目标时 true
 */
export function isLogTarget(command: string): boolean {
  return segmentsOf(command).some((segment) => isLogSegment(segment));
}

/**
 * 这条命令读的是不是**给人/给模型逐字读的东西**（源码、文档、配置、报告）。
 *
 * 与 `isLogTarget` 是同一把尺子的反面，判据的用途却不同：窗口只处理日志，清理链则要
 * **避开**阅读材料。`rtk hook` 的 `dedup` 会把「连续 ≥3 行完全相同」折成一行 + `[xN]`——
 * 对构建日志那是对的（200 行相同告警本来只需看一条），但对一份正文是灾难：实测 200 行
 * 完全相同的文档 6,221 B → 102 B（丢 197 行），150 行重复的 CSV 912 B → 68 B。真实
 * `README.md`（27,655 B）、`docs/DETAIL.zh.md`、`lib/guard.ts` 这类文件目前都回 0 字节
 * 不变，但那是「恰好没有连续 3 行相同」，不是判据给的保证。
 *
 * 所以判据写成：**读文件的命令 + 操作数里一个日志扩展名都没有** → 这是阅读材料，两条压缩
 * 路都不许碰。反过来 `cat build.log` 不是阅读材料（日志），可以走链。
 *
 * **复合命令按段判**，这一条比日志那面更要紧：`cd /tmp && cat src/app.ts` 按整条判会得出
 * 「两项都不是」，落进清理链被 dedup 折掉（真宿主实测 8,044 B 的源码回 360 B，200 行
 * 相同折成 `[x200]`），而模型拿到的是残件——「阅读材料一律不碰」这条硬规矩在复合形态上
 * 从来没生效过。现在任一段是日志 → 不是阅读材料（有日志可压时压日志，既有裁决不变）；
 * 否则任一段是阅读材料 → 是阅读材料，一个字都不许动。
 * @param command - 模型给的原始命令（不带前缀层的改写）
 * @returns 是阅读材料时 true
 */
export function isReadingTarget(command: string): boolean {
  const segments = segmentsOf(command);
  // 有日志段时让给日志：两条路的方向相反，同时成立会让同一份输出去向不明。
  if (segments.some((segment) => isLogSegment(segment))) {
    return false;
  }
  return segments.some((segment) => isReadingSegment(segment));
}

/** 一次窗口化的结果。 */
export interface WindowedOutput {
  /** 头 + 省略标记 + 尾。 */
  readonly text: string;
  /** 省掉的行数（写进省略标记，也用于收益记账）。 */
  readonly omitted: number;
}

/**
 * 把长文本截成头 `headLines` + 尾 `tailLines`，中间换成一行省略标记。
 *
 * `undefined` 表示「不该窗口」（总行数不超过头尾之和、或入参不合法）：让调用方按原样继续，
 * 而不是返回一份和输入等长的「窗口」。上界判在这里是因为只有这里知道总行数。
 * @param text - 完整正文
 * @param headLines - 头部保留行数
 * @param tailLines - 尾部保留行数
 * @returns 窗口化结果，或 undefined
 */
export function windowOf(
  text: string,
  headLines: number,
  tailLines: number,
): WindowedOutput | undefined {
  // 单出口：三种「不动手」的理由（入参不合法、够不到阈值）都要交回 `undefined`，
  // 而 `consistent-return` 不接受「有的分支返回值、有的分支空手回」。
  let windowed: WindowedOutput | undefined;
  const usable = headLines >= 0 && tailLines >= 0 && headLines + tailLines > 0;
  if (usable) {
    const endsWithNewline = text.endsWith("\n");
    const all = endsWithNewline ? text.slice(0, -1).split("\n") : text.split("\n");
    const total = all.length;
    if (total > headLines + tailLines) {
      const kept = [
        ...all.slice(0, headLines),
        // 标记刻意用 rtk 自己的那一族写法（`[+56 lines omitted]`，语出 `smart_truncate`）：
        // `lib/guard.ts` 的 `LISTING_COLLAPSE` 正是按这族形状认「这里被砍掉了一段」，
        // 换一种写法就会让护栏看不见这次丢失，窗口变成一条绕过护栏的静默截断。
        `[+${String(total - headLines - tailLines)} lines omitted]`,
        ...(tailLines === 0 ? [] : all.slice(total - tailLines)),
      ];
      windowed = {
        text: kept.join("\n") + (endsWithNewline ? "\n" : ""),
        omitted: total - headLines - tailLines,
      };
    }
  }
  return windowed;
}
