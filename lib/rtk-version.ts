/**
 * rtk 二进制版本的三段解析与支持面判定。
 *
 * 本模块**不 spawn**：读取版本号的动作由调用方注入（`probeRtkVersion`），
 * 这样单测不必起子进程，装配层也能自己决定用 `ctx.subprocess` 还是别的通道。
 *
 * 版本门**是**运行期门禁，不只是设置卡的状态行：`supported === false` 时两层都停手
 * （前缀层在 `execute` 里、pipe 层在 `decide` 里各判一次，逐次现读），这与 README 的
 * 「below that it reports the version it found and does nothing」是同一句话。
 *
 * 早先这里写的是「版本门只用于设置卡，不是改写门禁」——那依赖「rtk 自己会对不认识的
 * 子命令回 rc=1，改写自然落空」，而实测不成立：rtk 0.9.x 收到 `rewrite` 时 rc=1 确实
 * 让遮蔽层放弃改写，但 `pipe` 通道仍会把输出喂给一个它不认识的 filter，于是「什么都不做」
 * 变成「做了一半」。停手必须在插件这一侧。
 */

/** 三段版本号。 */
export interface RtkVersion {
  major: number;
  minor: number;
  patch: number;
}

/** 给设置卡与日志看的规范形态。 */
export function formatRtkVersion(version: RtkVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

/**
 * 支持面的下限。rtk 1.0.0 是 `rewrite` / `pipe` 两个子命令成形的那一版。
 *
 * 三段拆开写、字符串由 {@link formatRtkVersion} 生成，两者**不可能不同源**：把下限
 * 写成字符串再由代码 parse 回来，那条 parse 失败的分支在真实运行中永远走不到
 * （字面量就是对的），只会逼出 ignore 注释或放宽阈值。
 */
const MIN_SUPPORTED: RtkVersion = { major: 1, minor: 0, patch: 0 };

/** 下限的字符串形态（设置卡与报错文案引用它）。 */
export const MIN_RTK_VERSION = formatRtkVersion(MIN_SUPPORTED);

// 只认三段数字：`rtk 1.2.0`、`1.2.0`、`rtk version 1.2.0 (abc123)` 都能解析出同一组数。
// 预发布后缀（`1.2.0-rc.1`）刻意不看——rtk 的 CLI 面在 rc 与正式版之间没有差异，
// 而把 rc 判成「不支持」会让开发机上唯一能用的那个二进制被拒。
const VERSION_RE = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u;

// 上界只防「把一串数字当版本」这种输入：超过安全整数会让 Number 失真，
// 而真实版本号的三段不可能接近这个量级。
const MAX_COMPONENT = 999_999;

/**
 * 把 `exec` 交回的可选捕获组折成三段数字；缺组或溢出时 undefined。
 *
 * 单出口写法（先算候选再判有效）不是为了短，而是 `consistent-return` 在这个工作区按
 * `treatUndefinedAsUnspecified: true` 生效：一旦函数里出现 `return undefined;`，整条函数
 * 就被判成「有的分支返回值、有的不返回」。兄弟仓同一个形状的纯函数（`sessionHeaderCwd`、
 * `problem` 那几处）也都是单出口。
 */
function componentsOf(raw: string): RtkVersion | undefined {
  const parts = VERSION_RE.exec(raw)?.groups;
  const candidate =
    parts === undefined
      ? undefined
      : {
          major: Number(parts["major"]),
          minor: Number(parts["minor"]),
          patch: Number(parts["patch"]),
        };
  const inRange =
    candidate !== undefined &&
    [candidate.major, candidate.minor, candidate.patch].every(
      (each) => Number.isSafeInteger(each) && each >= 0 && each <= MAX_COMPONENT,
    );
  return inRange ? candidate : undefined;
}

/** 从任意含版本号的文本里解析出三段版本；读不出或分量溢出时 undefined。 */
export function parseRtkVersion(raw: string): RtkVersion | undefined {
  return componentsOf(raw);
}

/** 三段比较：主版本不同比主版本，次版本不同比次版本，否则比补丁。 */
export function isRtkVersionSupported(version: RtkVersion): boolean {
  if (version.major !== MIN_SUPPORTED.major) {
    return version.major > MIN_SUPPORTED.major;
  }
  if (version.minor !== MIN_SUPPORTED.minor) {
    return version.minor > MIN_SUPPORTED.minor;
  }
  return version.patch >= MIN_SUPPORTED.patch;
}

/** 一次探测的结果：原始回执 + 解析 + 是否达下限。 */
export interface RtkProbe {
  raw: string;
  version: RtkVersion;
  supported: boolean;
}

/**
 * 装配期探测。三种失败一律 undefined，且**都不抛**：装配路径上一个探测失败不该
 * 让插件起不来。`supported: false` 与 `undefined` 的差别是「读到了但太旧」与
 * 「根本没读到」——设置卡要说清是哪一种。
 */
export async function probeRtkVersion(
  readVersion: () => Promise<string | undefined>,
): Promise<RtkProbe | undefined> {
  // 单出口：`let` + try/catch 里赋值，与兄弟仓 routing.ts 的 `let problem` 同一形状。
  // try 块内 `return` 会让 consistent-return 判成「有的分支返回值、有的不返回」。
  let raw: string | undefined;
  try {
    raw = await readVersion();
  } catch {
    // 探测失败的三种成因（二进制不在、超时、非零退出）在设置卡上是同一句话：没读到。
    // raw 保持 undefined，与「输出里没有版本号」同档处理。
  }
  const version = raw === undefined ? undefined : componentsOf(raw);
  return raw === undefined || version === undefined
    ? undefined
    : { raw, version, supported: isRtkVersionSupported(version) };
}
