import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** 结构性拒绝的四种形态；`rewrite-gate` 把它们折进 `RewriteSkipReason`。 */
export type StructuralReject = "empty-command" | "compound" | "detail-flag" | "already-rtk";

// 复合命令：分隔符、管道、重定向、命令替换、反引号。任一条都不改写——拆开改写会改语义，
// 而 `cd /tmp && cargo test` 会被 rtk 改成 `cd /tmp && rtk cargo test`（只改后半句），
// 无法判断安全性。
const COMPOUND = /[;&|\n`<>]|\$\(/u;

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
 * 四道结构性不变式，按「空 → 已 rtk → 复合 → 详情」的次序判，先命中先返回。
 *
 * 单出口写法：这个工作区的 `consistent-return` 带 `treatUndefinedAsUnspecified: true`，
 * 函数里一旦出现 `return undefined;`，其余分支的返回值就被判成不一致。
 */
export function structuralReject(command: string): StructuralReject | undefined {
  const trimmed = command.trimStart();
  let reject: StructuralReject | undefined;
  if (trimmed.trimEnd() === "") {
    reject = "empty-command";
  } else if (RTK_PREFIX.test(trimmed)) {
    reject = "already-rtk";
  } else if (COMPOUND.test(command)) {
    reject = "compound";
  } else if (DETAIL_FLAG.test(command)) {
    reject = "detail-flag";
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
 * 在 PATH 上找**可执行文件**；找不到返回 `undefined`（调用方据此整层不装）。
 *
 * 两判都要，缺一条就会把目录当成二进制：
 *   · `accessSync(X_OK)` 回答「这个路径能不能执行」——**目录也能通过**（POSIX 上目录的
 *     搜索位就是 X）。实测把一个目录命名成 `rtk` 放进 PATH，旧实现把它当成了 rtk。
 *   · `statSync().isFile()` 回答「它到底是不是文件」。
 * 少了第二条的后果是静默的：装配期门禁误判「rtk 装好了」，遮蔽层照装，而每次改写 spawn 那个
 * 目录都拿 `EACCES`、fail-open 原样执行；`status().rtkPath` 报出那条伪路径，版本探测又探不到
 * （`supported === null`），于是卡片既不报「没装」也不报「版本过低」——看着一切正常，压缩从不生效。
 *
 * `platform` 可注入只为可测：win32 的三档后缀在 POSIX 机器上永远走不到，若把平台判定
 * 焊死在 `process.platform` 上，那一条分支在本仓覆盖率统计里永远是半条，只能靠放宽阈值
 * 或 ignore 注释糊过去——两样这个工作区都不做。
 */
export function findOnPath(
  bin: string,
  platform: NodeJS.Platform = process.platform,
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
      try {
        accessSync(full, constants.X_OK);
        // 目录能过 X_OK：同名目录不算找到了二进制。
        if (statSync(full).isFile()) {
          found = full;
        }
      } catch {
        // 这一档不可执行：继续试下一个扩展名/目录。
      }
    }
  }
  return found;
}
