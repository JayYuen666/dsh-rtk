import { statSync } from "node:fs";
import path from "node:path";

// 拆分器住在 node-free 的 `lib/command-segments.ts`（理由见那个文件开头）：本文件要判可执行位，
// 而客户端侧的 `lib/command-filter.ts` 也要拆段判表，若从这里取就会把 `node:fs` 拖进 client 产物。
// 各调用点（`output-window` / `command-family` / `rewrite-verify` / `rtk-paths` / `rewrite-gate` 与测试）
// 直接从那个模块取，不再从这里转出——转出会撞 `unicorn(prefer-export-from)`，而真正的判据是
// 「谁需要拆段就从 node-free 的那个模块取」。
import { splitCommand } from "./command-segments.ts";

/** 结构性拒绝的四种形态；`rewrite-gate` 把它们折进 `RewriteSkipReason`。 */
export type StructuralReject = "empty-command" | "compound" | "detail-flag" | "already-rtk";

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
