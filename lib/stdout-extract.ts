/**
 * `tool-bash` / `tool-bash-persistent` 回执的拆解与回填。
 *
 * 这两类回执把「可压缩的 stdout 正文」「必须原样保留的 stderr 段」「退出状态 marker」
 * 拼在同一条字符串里，压缩只能动第一段：
 *
 * - **marker 不能动**：客户端用 `parseExitStatus` 锚 `$` 解析它（`[exit code: N]` /
 *   `[killed by signal: X]` / `[timed out after Nms]` / `[stopped: …]`），换了形状或挪了位置
 *   就等于改了这条命令的退出状态，而模型与 UI 都靠它判断成败。
 * - **stderr 段不能动**：它是 `\n[stderr]\n` 之后的部分，宿主与模型都按这个前缀分流。
 *
 * 拆不出来一律 `undefined`，调用方原样放行——这一层的失败形态必须是「不压」，不是「压坏」。
 *
 * `isRecord` 用 shared 的（非 null 对象且非数组）：本包原本两处各抄过一遍。
 */
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 一次拆解的结果。`value` 只在结构化形状里有。 */
export interface Extracted {
  readonly shape: "structured" | "string";
  readonly stdout: string;
  readonly stderr: string;
  readonly marker: string;
  readonly raw: string;
  readonly value?: Record<string, unknown>;
}

/** 前景 bash 回执的末尾 marker；四种形态与 `render.ts` 的 markers 一一对应。 */
export const TOOL_BASH_MARKER =
  /(?:^|\n)(?<marker>\[(?:exit code: -?\d+|killed by signal: [^\]\n]+|timed out after \d+ms|stopped: [^\]\n]+)\])\s*$/u;

/** 持久 shell 回执的末尾 marker（`appendStatusMarker` 拼的那一条）。 */
const PERSISTENT_MARKER = /(?:^|\n)(?<marker>\[Command finished with exit code -?\d+\])\s*$/u;

/** marker 命中串可能带一个前导换行（`(?:^|\n)` 的换行那一支），回填时要去掉。 */
const LEADING_NEWLINE = /^\n/u;

/** stdout 与 stderr 的分隔符，与 `render.ts` 的拼装格式逐字相同。 */
const STDERR_SEP = "\n[stderr]\n";

/** 按末尾 marker 把文本切成正文与 marker；没有 marker 时 marker 是空串。 */
function splitMarker(text: string, pattern: RegExp): { body: string; marker: string } {
  const match = pattern.exec(text);
  let split = { body: text, marker: "" };
  if (match !== null) {
    // 命中串可能带一个前导换行（`(?:^|\n)` 那一支），marker 本身从 `[` 起。
    split = {
      body: text.slice(0, match.index),
      marker: match[0].replace(LEADING_NEWLINE, "").trimEnd(),
    };
  }
  return split;
}

/** 持久 shell 的裸字符串回执。 */
function fromString(raw: string): Extracted {
  const { body, marker } = splitMarker(raw, PERSISTENT_MARKER);
  return { shape: "string", stdout: body, stderr: "", marker, raw };
}

/**
 * 结构化回执：先切 marker、再按 `\n[stderr]\n` 切正文与 stderr。
 * 顺序不能反——stderr 段夹在正文与 marker 之间，先切 stderr 会把 marker 留在 stderr 里。
 */
function fromStructured(value: Record<string, unknown>, text: string): Extracted {
  const { body, marker } = splitMarker(text, TOOL_BASH_MARKER);
  const sepAt = body.indexOf(STDERR_SEP);
  const hasStderr = sepAt !== -1;
  const stdout = hasStderr ? body.slice(0, sepAt) : body;
  const stderr = hasStderr ? body.slice(sepAt + STDERR_SEP.length) : "";
  return { shape: "structured", stdout, stderr, marker, raw: text, value };
}

/** 结构化回执里取 `stdout.text`；形状不对返回 undefined。 */
function structuredOf(value: Record<string, unknown>): Extracted | undefined {
  const stdoutRaw = value["stdout"];
  const text = isRecord(stdoutRaw) ? stdoutRaw["text"] : undefined;
  let extracted: Extracted | undefined;
  if (typeof text === "string") {
    extracted = fromStructured(value, text);
  }
  return extracted;
}

/** 拆出可压缩的 stdout、必须原样保留的 stderr 段与 marker。拆不出来就 `undefined`（调用方放行）。 */
export function extractBody(value: unknown): Extracted | undefined {
  let extracted: Extracted | undefined;
  if (typeof value === "string") {
    extracted = fromString(value);
  } else if (isRecord(value) && value["kind"] === "foreground") {
    extracted = structuredOf(value);
  }
  return extracted;
}

/** 把压缩后的正文拼回「正文 → stderr 段 → marker」的原格式。 */
function composeStructured(extracted: Extracted, compressedStdout: string): string {
  let text = compressedStdout;
  if (extracted.stderr !== "") {
    text += `${STDERR_SEP}${extracted.stderr}`;
  }
  if (extracted.marker !== "") {
    text += `\n${extracted.marker}`;
  }
  return text;
}

/** 把压缩后的 stdout 拼回原形状。stderr 段与 marker 按原样回填，退出码等字段整体不动。 */
export function reassemble(extracted: Extracted, compressedStdout: string): unknown {
  if (extracted.shape === "string") {
    const bare =
      extracted.marker === "" ? compressedStdout : `${compressedStdout}\n${extracted.marker}`;
    return bare;
  }
  const value = extracted.value ?? {};
  const stdoutRaw = value["stdout"];
  const stdoutObj = isRecord(stdoutRaw) ? stdoutRaw : {};
  const text = composeStructured(extracted, compressedStdout);
  return { ...value, stdout: { ...stdoutObj, text } };
}
