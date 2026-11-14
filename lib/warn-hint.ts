/**
 * `cargo test` 的编译警告补偿提示。
 *
 * 为什么需要这一层：`rtk cargo test` **仍会丢编译警告**（rtk 的 `run_test` 用
 * `CargoTestHandler`，warning 走 stderr、从不进 summary_lines；实测 `warning:` 行 0 条）。
 * 三条补偿里，`cargo build` / `cargo check` 已由拒绝层显式放行、`cargo clippy` 进拒绝表，
 * 剩下的第三条就是这里：cargo test 的输出里**既没有 warning 也没有 error** 时，在末尾
 * marker 之前追加一行常量提示，告诉模型「要看警告请跑 cargo build / cargo check」。
 *
 * 这不是修复 rtk（插件改不了它），是**如实告知信息损失**。所以提示只在「确实没有警告」时加
 * ——有警告还加就是噪音，模型会以为提示本身是内容。
 */
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

const CARGO_TEST = /^cargo\s+test(?:\s|$)/u;

/** 输出里已经出现警告或错误的判据。出现任意一条就不再加提示。 */
const HAS_WARN_OR_ERROR = /(?:^|\n)(?:warning:|warning\[|error\[|error:)/u;

/**
 * 结构化回执末尾的退出 marker（与 `lib/stdout-extract.ts` 同形，这里只用来定位插入点）。
 *
 * 复用 `lib/stdout-extract.ts` 的 `extractBody` 会更省事，但那一层的失败形态是「拆不出来
 * 就整条放行」——这里需要的是「拆不出来就追加到末尾」，两种降级方向相反，混用会让
 * 「没有 marker」那一格的行为取决于另一个模块的实现细节。
 */
const TRAILING_MARKER =
  /(?:^|\n)(?<marker>\[(?:exit code: -?\d+|killed by signal: [^\]\n]+|timed out after \d+ms|stopped: [^\]\n]+)\])\s*$/u;

/** 是否为 `cargo test`（只看首两词，带词边界；`cargo testing` / `cargotest` 都不算）。 */
export function isCargoTest(command: string): boolean {
  return CARGO_TEST.test(command.trimStart());
}

/**
 * 在 cargo test 的回执里补一行「警告未被保留」的常量提示。
 *
 * 三条约束：
 * - 只在**确实没有** warning / error 时加；
 * - 插在末尾 marker **之前**：marker 是客户端解析退出状态的锚点（正则锚 `$`），
 *   落在它后面等于没进结果；
 * - 不改 exitCode、不改 stderr、不改 truncated / spillPath：这一层只加一行文本。
 */
export function appendWarnHint(value: unknown, hint: string): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const { kind, stdout } = value;
  if (kind !== "foreground" || !isRecord(stdout)) {
    return value;
  }
  const { text } = stdout;
  if (typeof text !== "string") {
    return value;
  }
  if (HAS_WARN_OR_ERROR.test(text)) {
    return value;
  }
  // 命中 marker 时把提示插在它之前；没命中就追加到末尾。两种情况共用一个拼装式，
  // 免得「有 marker」那一支写成追加末尾（提示就落在锚点之后、等于没进结果）。
  const marker = TRAILING_MARKER.exec(text);
  const body = marker === null ? text : text.slice(0, marker.index);
  const trailer = marker === null ? "" : `\n${marker[1]}`;
  const head = body === "" || body.endsWith("\n") ? body : `${body}\n`;
  return { ...value, stdout: { ...stdout, text: `${head}${hint}${trailer}` } };
}
