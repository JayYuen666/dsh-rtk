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
import type { Translate } from "./ui-messages.ts";

/** 三个反复出现的类名：`sonarjs(no-duplicate-string)` 数的是字面量，不是语义。 */
const BLOCK = "rtkc-block";
const NOTE = "rtkc-note";
const SECTION_TITLE = "rtkc-subtitle";

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

/** 量条本身（纯装饰，读屏靠旁边的数字）。宽度是百分比。 */
function barOf(ratio: number): ReactNode {
  const width = `${String(Math.round(ratio * 100))}%`;
  const fill = createElement("span", { className: "rtkc-meter-fill", style: { width } });
  return createElement("span", { className: "rtkc-meter", "aria-hidden": true }, fill);
}

/** 数值格的量条 + 数值本身。量条宽度是百分比，`ratio` 为 0 时只剩数值。 */
function meterOf(text: string, ratio: number): ReactNode {
  const value = createElement("span", { className: "rtkc-cell-value" }, text);
  return createElement("span", { className: "rtkc-cell-metric" }, barOf(ratio), value);
}

/** `<table>` 本体：表头 + 全部行。单独一层是为了不让 `tableOf` 里叠四层调用。 */
function wrapOf(head: ReactNode, body: readonly ReactNode[]): ReactNode {
  const thead = createElement("thead", null, head);
  const tbody = createElement("tbody", null, ...body);
  return createElement("table", { className: "rtkc-table" }, thead, tbody);
}

/** 表头 + 行的外壳。`empty` 是这张表没有数据时那一句话，不是空字符串。 */
function tableOf(props: {
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
  const head = createElement(
    "tr",
    null,
    ...props.columns.map((column) =>
      createElement(
        "th",
        {
          key: column.key,
          className: column.numeric ? "rtkc-num" : "rtkc-text",
          scope: "col",
        },
        column.label,
      ),
    ),
  );
  const body = props.rows.map((row, index) =>
    // 行键用「第一格的值 + 序号」：同一张表里第一列就是身份，但它可能重复
    // （两个 path 只差尾斜杠），序号兜住重复。
    createElement(
      "tr",
      { key: `${props.rowKeys[index] ?? ""}#${index}` },
      ...row.map((cell, cellIndex) => {
        const column = props.columns[cellIndex];
        const numeric = column?.numeric === true;
        return createElement(
          "td",
          {
            key: `${column?.key ?? ""}#${cellIndex}`,
            className: numeric ? "rtkc-num" : "rtkc-text",
          },
          column?.meter === true ? meterOf(cell.text, cell.ratio ?? 0) : cell.text,
        );
      }),
    ),
  );
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card` },
    title,
    createElement("div", { className: "rtkc-table-wrap" }, wrapOf(head, body)),
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
      { className: `${BLOCK} rtkc-card` },
      createElement("h3", { className: SECTION_TITLE }, t("suggestionsTitle")),
      createElement("p", { className: NOTE }, t("suggestionsEmpty")),
    );
  }
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card` },
    createElement("h3", { className: SECTION_TITLE }, t("suggestionsTitle")),
    // 一句话就是一整句模板（`{filter}` 之类在客户端翻译时才替换）：拆成「粗体标题 + 说明」
    // 会让同一句在两种语言里断在不同的位置，而模板本身已经是通顺的一句。
    ...lines.map((line) =>
      createElement(
        "p",
        { key: line.key, className: line.warn ? "rtkc-suggestion rtkc-warn" : "rtkc-suggestion" },
        t(line.messageKey, line.values),
      ),
    ),
  );
}
