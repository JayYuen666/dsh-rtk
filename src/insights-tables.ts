// Insights 页里的明细表、跳过原因表与建议区。
//
// 表格只做「渲染已经算好的值」：格式化在 `lib/insights-page-logic.ts` 的 `cellsOf`，排序与
// 阈值在 `lib/insights-service.ts`。这里自己决定两件事：
//
//   1. **哪几列该出现**——覆盖率是压缩形态独有的列（改写形态没有这个分子分母），整列不画，
//      而不是画一列 0%。「没有」与「是 0」在界面上必须是两件事。
//   2. **空表怎么说**——空表最容易写成一张只有表头的空壳，读它的人会以为是渲染坏了。
//
// 数值列带一条细量条：一屏十几行数字里，横着比长度比竖着比大小快得多。量条只表示**同一列
// 内部的相对大小**（对列内最大值归一），不是绝对刻度——所以它是装饰，不是图表。
import { createElement } from "react";
import type { ReactNode } from "react";

import type {
  CommandRow,
  FilterRow,
  InsightsForm,
  SkipReasonRow,
  WorkdirRow,
} from "../lib/insights-shape.ts";
import { cellsOf } from "../lib/insights-page-logic.ts";
import type { SuggestionLine } from "../lib/insights-page-logic.ts";
import { formatPct, formatTokens } from "../lib/insights-view.ts";
import { Callout, DataTable, Meter } from "@jayyuen66/dsh-plugin-shared/client";
import type { Translate } from "./ui-messages.ts";

/** 三个反复出现的类名：`sonarjs(no-duplicate-string)` 数的是字面量，不是语义。 */
const BLOCK = "rtkc-block";
const NOTE = "rtkc-note";
const SECTION_TITLE = "rtkc-subtitle";
/**
 * 单表展示行数上限。行数组在服务层只排序不截断（窗口内有多少个不同身份就多少行），
 * 30 天窗口的 workdir 可能上百行——明细表是给人扫 Top 的，不是全量导出。
 * 截断发生在渲染层：服务层的行数与 `rtk gain` 对账口径不变，被截掉的行只是不画。
 */
const TABLE_ROW_LIMIT = 12;

/**
 * 一个单元格。
 *
 * `ratio` 是这条数值在同一列里的相对大小（0~1），有它才画量条。不是每条都有：比率类的格子
 * 没有可比的量，给了会让「80%」比「800 token」还长，那是在比两种东西。
 */
interface Cell {
  readonly text: string;
  readonly ratio?: number;
}

/** 表格的一列：数值列右对齐并带量条（读一列数字时对不齐是最费力的事）。 */
interface Column {
  readonly key: string;
  readonly label: string;
  readonly numeric: boolean;
  /** 这一列是否画量条；比率列与身份列置 false。 */
  readonly meter?: boolean;
}

/** 列内最大值；没有行时返回 0，量条宽度按 0 处理（不画）。 */
function peakOf(values: readonly number[]): number {
  let peak = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
  }
  return peak;
}

/**
 * 相对量，夹在 `[0, 1]`。
 *
 * 分母为 0 给 0（「全是 0」不该画出半根量条）；负值同样给 0——`rtk commands` 的
 * `saved_tokens` 可以是负数（输出比输入还大），而 `width: -25%` 会被浏览器静默丢弃，
 * 量条看起来「没画」而旁边的数字是负的，读者只能猜。
 */
function ratioOf(value: number, peak: number): number {
  if (peak <= 0 || value <= 0) {
    return 0;
  }
  return Math.min(value / peak, 1);
}

/** 数值格的量条 + 数值本身（shared Meter：track + 右对齐数值）。`ratio` 为 0 时只剩数值。 */
function meterOf(text: string, ratio: number): ReactNode {
  return createElement(Meter, { ratio, label: text });
}

/** 表头 + 行的外壳。`empty` 是这张表没有数据时那一句话，不是空字符串。 */
function tableOf(props: {
  readonly t: Translate;
  readonly title: string;
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly Cell[])[];
  readonly rowKeys: readonly string[];
  readonly empty: string;
}): ReactNode {
  const title = createElement("h3", { className: SECTION_TITLE }, props.title);
  if (props.rows.length === 0) {
    // 空表不画空壳：只有表头的表格读起来像渲染坏了。
    return createElement(
      "section",
      { className: `${BLOCK} rtkc-card` },
      title,
      createElement("p", { className: NOTE }, props.empty),
    );
  }
  // 列与行交给 shared DataTable：身份列加粗并冻结在左（横向滚动时「这是哪一行」
  // 不跟着数字滚走），数值列右对齐，量条列的格子是 shared Meter 元素。
  // 身份列（第一列）单行省略：workdir 路径可能很长，悬停 title 看全文。
  const columns = props.columns.map((column, index) => ({
    key: column.key,
    label: column.label,
    numeric: column.numeric,
    strong: !column.numeric,
    ellipsis: index === 0,
  }));
  const allRows = props.rows.map((row, index) => ({
    // 行键用「第一格的值 + 序号」：同一张表里第一列就是身份，但它可能重复
    // （两个 path 只差尾斜杠），序号兜住重复。
    key: `${props.rowKeys[index] ?? ""}#${index}`,
    cells: row.map((cell, cellIndex) =>
      props.columns[cellIndex]?.meter === true ? meterOf(cell.text, cell.ratio ?? 0) : cell.text,
    ),
  }));
  const truncated = allRows.length > TABLE_ROW_LIMIT;
  const rows = truncated ? allRows.slice(0, TABLE_ROW_LIMIT) : allRows;
  // 表脚只在真被截断时出现：行数组按节省量/次数降序排好（见服务层），「前 N 行」就是 Top N。
  const foot = truncated
    ? props.t("tableTruncated", { total: String(allRows.length), limit: String(TABLE_ROW_LIMIT) })
    : undefined;
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card` },
    title,
    createElement(DataTable, { columns, rows, stickyFirst: true, foot }),
  );
}

/**
 * 三张明细表共用的「数值列」。
 *
 * 覆盖率列**只在压缩形态存在**：改写形态的 `coveragePct` 恒 0（分母只有日表知道），画出来
 * 会被读成「这条命令一次都没成功」。
 */
function metricColumnsOf(t: Translate, form: InsightsForm): readonly Column[] {
  const columns: Column[] = [
    { key: "commands", label: t("colCommands"), numeric: true, meter: true },
    { key: "saved", label: t("colSaved"), numeric: true, meter: true },
    { key: "savings", label: t("colSavings"), numeric: true, meter: false },
  ];
  if (form === "pipe") {
    columns.push({ key: "coverage", label: t("colCoverage"), numeric: true, meter: false });
  }
  return columns;
}

/**
 * 一行 → 三（或四）个数值格。
 *
 * 量条只挂在「次数」与「节省 token」上：它们是可加的绝对量，横着比有意义。节省率与覆盖率是
 * 比率，它们的量条会把「80%」画得比「800 token」长，那是在比两种东西。
 */
function cellsRow(
  row: {
    readonly commands: number;
    readonly savedTokens: number;
    readonly savingsPct: number;
    readonly coveragePct: number;
  },
  form: InsightsForm,
  peaks: { readonly commands: number; readonly saved: number },
): readonly Cell[] {
  const cells = cellsOf(row, form);
  const rowCells: Cell[] = [
    { text: cells.commands, ratio: ratioOf(row.commands, peaks.commands) },
    { text: cells.saved, ratio: ratioOf(row.savedTokens, peaks.saved) },
    { text: cells.savings },
  ];
  if (cells.coverage !== undefined) {
    rowCells.push({ text: cells.coverage });
  }
  return rowCells;
}

/** 按 filter 的明细。只有压缩形态有这一层。 */
export function FilterTable(props: {
  readonly t: Translate;
  readonly rows: readonly FilterRow[];
}): ReactNode {
  const { t, rows } = props;
  const peaks = {
    commands: peakOf(rows.map((row) => row.commands)),
    saved: peakOf(rows.map((row) => row.savedTokens)),
  };
  return tableOf({
    t,
    title: t("tableFilters"),
    columns: [{ key: "name", label: t("colName"), numeric: false }, ...metricColumnsOf(t, "pipe")],
    rows: rows.map((row) => [{ text: row.name }, ...cellsRow(row, "pipe", peaks)]),
    rowKeys: rows.map((row) => row.name),
    empty: t("tableEmpty"),
  });
}

/** 按命令家族的明细。 */
export function CommandTable(props: {
  readonly t: Translate;
  readonly form: InsightsForm;
  readonly rows: readonly CommandRow[];
}): ReactNode {
  const { t, form, rows } = props;
  const peaks = {
    commands: peakOf(rows.map((row) => row.commands)),
    saved: peakOf(rows.map((row) => row.savedTokens)),
  };
  return tableOf({
    t,
    title: t("tableCommands"),
    columns: [
      { key: "family", label: t("colFamily"), numeric: false },
      ...metricColumnsOf(t, form),
    ],
    rows: rows.map((row) => [{ text: row.family }, ...cellsRow(row, form, peaks)]),
    rowKeys: rows.map((row) => row.family),
    empty: t("tableEmpty"),
  });
}

/** 按工作目录的明细。只三列：再细就是原始数据了（spec §7.2）。 */
export function WorkdirTable(props: {
  readonly t: Translate;
  readonly rows: readonly WorkdirRow[];
}): ReactNode {
  const { t, rows } = props;
  const peaks = {
    commands: peakOf(rows.map((row) => row.commands)),
    saved: peakOf(rows.map((row) => row.savedTokens)),
  };
  return tableOf({
    t,
    title: t("tableWorkdirs"),
    columns: [
      { key: "path", label: t("colWorkdir"), numeric: false },
      { key: "commands", label: t("colCommands"), numeric: true, meter: true },
      { key: "saved", label: t("colSaved"), numeric: true, meter: true },
      { key: "savings", label: t("colSavings"), numeric: true, meter: false },
    ],
    rows: rows.map((row) => [
      { text: row.path },
      // 次数按个位写：`formatTokens` 会把它折成 `1.5k`，而次数是精确可数的。
      { text: String(row.commands), ratio: ratioOf(row.commands, peaks.commands) },
      { text: formatTokens(row.savedTokens), ratio: ratioOf(row.savedTokens, peaks.saved) },
      { text: formatPct(row.savingsPct) },
    ]),
    rowKeys: rows.map((row) => row.path),
    empty: t("tableEmpty"),
  });
}

/**
 * 跳过原因 Top。
 *
 * 这张表是「0 次压缩」的可解释性来源：没有它，读者分不清「没命中 filter」与「命中了但收益
 * 太低」，而这两种结论指向完全不同的设置项。
 */
export function ReasonsTable(props: {
  readonly t: Translate;
  readonly rows: readonly SkipReasonRow[];
}): ReactNode {
  const { t, rows } = props;
  const peak = peakOf(rows.map((row) => row.count));
  return tableOf({
    t,
    title: t("tableReasons"),
    columns: [
      { key: "reason", label: t("colReason"), numeric: false },
      { key: "count", label: t("colCount"), numeric: true, meter: true },
    ],
    rows: rows.map((row) => [
      { text: row.reason },
      { text: String(row.count), ratio: ratioOf(row.count, peak) },
    ]),
    rowKeys: rows.map((row) => row.reason),
    empty: t("reasonsEmpty"),
  });
}

/** 建议区：一条一段，`warn` 用左边框标出来（不用图标，图标要额外下载）。 */
export function Suggestions(props: {
  readonly t: Translate;
  readonly lines: readonly SuggestionLine[];
}): ReactNode {
  const { t, lines } = props;
  if (lines.length === 0) {
    return createElement(
      "section",
      { className: `${BLOCK} rtkc-card rtkc-suggest` },
      createElement("h3", { className: SECTION_TITLE }, t("suggestionsTitle")),
      createElement("p", { className: NOTE }, t("suggestionsEmpty")),
    );
  }
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card rtkc-suggest` },
    createElement("h3", { className: SECTION_TITLE }, t("suggestionsTitle")),
    // 一句话就是一整句模板（`{filter}` 之类在客户端翻译时才替换）：拆成「粗体标题 + 说明」
    // 会让同一句在两种语言里断在不同的位置，而模板本身已经是通顺的一句。
    // 一句话就是一整条警示（`{filter}` 之类在客户端翻译时才替换）：warn 档琥珀色、
    // 其余信息蓝，颜色语义交给 shared 的色调映射。
    ...lines.map((line) =>
      createElement(
        Callout,
        { key: line.key, tone: line.warn ? "warn" : "info" },
        t(line.messageKey, line.values),
      ),
    ),
  );
}
