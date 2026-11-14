/**
 * 从 `tool-bash` 回执里按 `stdout.spillPath` 读回被截断掉的全文。
 *
 * 为什么需要它：`tool-bash` 的 `stdout.text` 在截断时是**尾部**（宿主明写
 * 「Long output is truncated to its tail; the full output is saved to a file」）。
 * 只压那一段等于压残片——前面被切掉的部分恰恰可能包含失败原因。所以
 * `stdout.truncated === true` 时先读回全文再压。
 *
 * 任何一步不成立都返回 `undefined`（调用方按「拿不到全文」原样放行）。
 *
 * `isRecord` 用 shared 的（非 null 对象且非数组），不自带一份：本包原本两处各抄过一遍，
 * 抄的那版还把数组算成记录。
 */
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 单条回执最多读回 10MiB：超过说明这段输出不该整个进上下文。 */
const MAX_SPILL_READ = 10 * 1024 * 1024;

/** 回执里 `stdout.spillPath` 的字符串值；形状不对返回 undefined。 */
function spillPathOf(value: Record<string, unknown>): string | undefined {
  const { stdout } = value;
  const path = isRecord(stdout) ? stdout["spillPath"] : undefined;
  let found: string | undefined;
  if (typeof path === "string") {
    found = path;
  }
  return found;
}

/** 从 tool-bash 回执里按 `stdout.spillPath` 读回全文；任何一步不成立都返回 `undefined`。 */
export async function readSpillFullText(
  value: unknown,
  fs: { readFile: (path: string) => Promise<string> },
): Promise<string | undefined> {
  let full: string | undefined;
  const path = isRecord(value) && value["kind"] === "foreground" ? spillPathOf(value) : undefined;
  if (path !== undefined) {
    try {
      const text = await fs.readFile(path);
      if (Buffer.byteLength(text, "utf8") <= MAX_SPILL_READ) {
        full = text;
      }
    } catch {
      // 读不出来就当作没有全文：压缩层会退到「不压」。
    }
  }
  return full;
}
