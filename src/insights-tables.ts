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
import { createElement, useMemo, useState } from "react";
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
import { formatPct } from "../lib/insights-view.ts";
import { Callout, DataTable, EmptyState, Meter } from "@jayyuen66/dsh-plugin-shared/client";
import type { Translate } from "./ui-messages.ts";
import type { PieSlice, PieSpec } from "./insights-chart-spec.ts";
import { useChart } from "./insights-chart-hook.ts";

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
  /** 命令/路径这类标识列用等宽字（设计稿 `mono-cell`）。 */
  readonly mono?: boolean;
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

/** 把列/行直接交给 shared DataTable。图 + 表的卡（原因构成、按目录、按过滤器）共用这一枚：
 *  图的职责是形状，这里的职责是精确值、读屏与全量行。 */
function dataTableOf(props: {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly Cell[])[];
  readonly rowKeys: readonly string[];
  readonly foot?: string;
  readonly caption?: string;
}): ReactNode {
  const columns = props.columns.map((column, index) => ({
    key: column.key,
    label: column.label,
    numeric: column.numeric,
    mono: column.mono === true,
    strong: !column.numeric,
    ellipsis: index === 0,
  }));
  const rows = props.rows.map((row, index) => ({
    key: `${props.rowKeys[index] ?? ""}#${index}`,
    cells: row.map((cell, cellIndex) =>
      props.columns[cellIndex]?.meter === true ? meterOf(cell.text, cell.ratio ?? 0) : cell.text,
    ),
  }));
  return createElement(DataTable, {
    columns,
    rows,
    stickyFirst: true,
    caption: props.caption,
    foot: props.foot,
  });
}

/** 一行「图 + 全量表」卡：条形负责排名形状，details 表负责精确值与全量行。
 *  设计稿 D 规定按目录与按过滤器都走这一形，列表全量降序、限高 420px 内部滚动。 */
function hbarCard(props: {
  readonly t: Translate;
  readonly title: string;
  readonly legend: string;
  readonly empty: string;
  readonly summary: string;
  readonly bars: readonly { readonly name: string; readonly value: number }[];
  readonly detailColumns: readonly Column[];
  readonly detailRows: readonly (readonly Cell[])[];
  readonly detailKeys: readonly string[];
  readonly detailFoot?: string;
  readonly detailCaption?: string;
}): ReactNode {
  if (props.bars.length === 0) {
    return createElement(
      "section",
      { className: `${BLOCK} rtkc-card` },
      createElement("h3", { className: SECTION_TITLE }, props.title),
      createElement(EmptyState, { title: props.t("emptyTitle"), plain: true }, props.empty),
    );
  }
  const legendMark = createElement("i", { className: "rtkc-hbLegend" });
  const legendSpan = createElement("span", null, legendMark, props.legend);
  const title = createElement(
    "div",
    { className: "rtkc-chart-head" },
    createElement("h3", { className: SECTION_TITLE }, props.title),
    createElement("div", { className: "rtkc-chart-legend" }, legendSpan),
  );
  const peak = peakOf(props.bars.map((bar) => bar.value));
  const bars = props.bars.map((bar) => {
    const width = `${String(ratioOf(bar.value, peak) * 100)}%`;
    return createElement(
      "div",
      { key: bar.name, className: "rtkc-hbar" },
      createElement("span", { className: "rtkc-hbName" }, bar.name),
      createElement(
        "span",
        { className: "rtkc-hbTrack", "aria-hidden": true },
        createElement("span", { className: "rtkc-hbFill", style: { width } }),
      ),
      createElement("span", { className: "rtkc-hbVal" }, String(bar.value)),
    );
  });
  const details = createElement(
    "details",
    { className: "rtkc-details" },
    createElement("summary", null, props.summary),
    dataTableOf({
      columns: props.detailColumns,
      rows: props.detailRows,
      rowKeys: props.detailKeys,
      ...(props.detailFoot === undefined ? {} : { foot: props.detailFoot }),
      ...(props.detailCaption === undefined ? {} : { caption: props.detailCaption }),
    }),
  );
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card` },
    title,
    createElement("div", { className: "rtkc-hbars" }, ...bars),
    details,
  );
}

/** 表头 + 行的外壳。`empty` 是这张表没有数据时那一句话，不是空字符串。 */
function TableBlock(props: {
  readonly t: Translate;
  readonly title: string;
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly Cell[])[];
  readonly rowKeys: readonly string[];
  readonly empty: string;
  /** 首屏行数；不传按 12。`expandable` 时超过上限的行由「展开全部」接管。 */
  readonly limit?: number;
  readonly expandable?: boolean;
  /** 表格上方的图或说明（跳过原因的环图走这一位）。 */
  readonly leading?: ReactNode;
  /** 表底注：只在有负数这类「数值本身需要解释」的表上出现。 */
  readonly note?: string;
}): ReactNode {
  const title = createElement("h3", { className: SECTION_TITLE }, props.title);
  const [expanded, setExpanded] = useState(false);
  if (props.rows.length === 0) {
    // 空表不画空壳：只有表头的表格读起来像渲染坏了。
    return createElement(
      "section",
      { className: `${BLOCK} rtkc-card` },
      title,
      createElement(EmptyState, { title: props.t("emptyTitle"), plain: true }, props.empty),
    );
  }
  // 列与行交给 shared DataTable：身份列加粗并冻结在左（横向滚动时「这是哪一行」
  // 不跟着数字滚走），数值列右对齐，量条列的格子是 shared Meter 元素。
  // 身份列（第一列）单行省略：workdir 路径可能很长，悬停 title 看全文。
  const columns = props.columns.map((column, index) => ({
    key: column.key,
    label: column.label,
    numeric: column.numeric,
    mono: column.mono === true,
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
  const limit = props.limit ?? TABLE_ROW_LIMIT;
  const collapseLabel = props.t("tableCollapse", { limit: String(limit) });
  const truncated = allRows.length > limit;
  const rows = truncated && !expanded ? allRows.slice(0, limit) : allRows;
  let foot: ReactNode;
  if (props.expandable === true) {
    // 图与表同源：展开只改可见行数，不改服务层排序与总数。表脚始终报
    // 「已展示 x / 共 M」——行数正好等于首屏时也不能静默，否则读不出总量。
    const count = props.t("tableShown", {
      shown: String(rows.length),
      total: String(allRows.length),
    });
    foot = createElement(
      "div",
      { className: "rtkc-tableFoot" },
      count,
      truncated
        ? createElement(
            "button",
            {
              type: "button",
              className: "rtkc-expand",
              onClick: () => {
                setExpanded((prev) => !prev);
              },
            },
            expanded ? collapseLabel : props.t("tableExpand"),
          )
        : null,
    );
  } else {
    foot = truncated
      ? props.t("tableTruncated", { total: String(allRows.length), limit: String(limit) })
      : undefined;
  }
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card` },
    title,
    ...(props.leading === undefined ? [] : [props.leading]),
    createElement(DataTable, { columns, rows, stickyFirst: true, foot }),
    ...(props.note === undefined
      ? []
      : [createElement("p", { className: `${NOTE} rtkc-tableNote` }, props.note)]),
  );
}

/**
 * 三张明细表共用的「数值列」。
 *
 * 覆盖率列**只在压缩形态存在**：改写形态的 `coveragePct` 恒 0（分母只有日表知道），画出来
 * 会被读成「这条命令一次都没成功」。
 */
function metricColumnsOf(
  t: Translate,
  form: InsightsForm,
  savingsMeter = false,
): readonly Column[] {
  const columns: Column[] = [
    { key: "commands", label: t("colCommands"), numeric: true },
    { key: "saved", label: t("colSaved"), numeric: true },
    { key: "savings", label: t("colSavings"), numeric: true, meter: savingsMeter },
  ];
  if (form === "pipe") {
    columns.push({ key: "coverage", label: t("colCoverage"), numeric: true });
  }
  return columns;
}

/**
 * 一行 → 三（或四）个数值格。
 *
 * 量条只在命令族表的「节省率」列出现（设计稿 D 的样表如此）：它比的是 0–100% 的份额，
 * 按百分比本身归一；次数与 token 是可加绝对量，给它们画条会把「62%」与「392.0k」摆到同
 * 一把尺子上，读起来没有意义。
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
    { text: cells.savings, ratio: ratioOf(row.savingsPct, 100) },
  ];
  if (cells.coverage !== undefined) {
    rowCells.push({ text: cells.coverage });
  }
  return rowCells;
}

/** 按 filter 的明细。只有压缩形态有这一层。图按次数排名，表给全量精确值。 */
export function FilterTable(props: {
  readonly t: Translate;
  readonly rows: readonly FilterRow[];
}): ReactNode {
  const { t, rows } = props;
  const peaks = {
    commands: peakOf(rows.map((row) => row.commands)),
    saved: peakOf(rows.map((row) => row.savedTokens)),
  };
  return hbarCard({
    t,
    title: t("tableFilters"),
    legend: t("barCompressed"),
    empty: t("tableEmpty"),
    summary: t("filterDetails", { total: String(rows.length) }),
    bars: rows.map((row) => ({ name: row.name, value: row.commands })),
    detailColumns: [
      { key: "name", label: t("colName"), numeric: false, mono: true },
      ...metricColumnsOf(t, "pipe"),
    ],
    detailRows: rows.map((row) => [{ text: row.name }, ...cellsRow(row, "pipe", peaks)]),
    detailKeys: rows.map((row) => row.name),
    detailFoot: t("workdirTableFoot"),
    detailCaption: t("filterTableCaption"),
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
  const hasNegative = rows.some((row) => row.savedTokens < 0 || row.savingsPct < 0);
  return createElement(TableBlock, {
    t,
    title: t("tableCommands"),
    columns: [
      { key: "family", label: t("colFamily"), numeric: false, mono: true },
      ...metricColumnsOf(t, form, true),
    ],
    rows: rows.map((row) => [{ text: row.family }, ...cellsRow(row, form, peaks)]),
    rowKeys: rows.map((row) => row.family),
    empty: t("tableEmpty"),
    limit: 12,
    expandable: true,
    ...(hasNegative ? { note: t("commandNegativeNote") } : {}),
  });
}

/** 按工作目录的明细：条形只画次数（设计稿 D 的「按目录 · 次数」），表给全量精确值。 */
export function WorkdirTable(props: {
  readonly t: Translate;
  readonly form: InsightsForm;
  readonly rows: readonly WorkdirRow[];
}): ReactNode {
  const { t, form, rows } = props;
  const peak = peakOf(rows.map((row) => row.commands));
  return hbarCard({
    t,
    title: t("tableWorkdirs"),
    legend: t(form === "prefix" ? "barRewrite" : "barCompressed"),
    empty: t("tableEmpty"),
    summary: t("workdirDetails", { total: String(rows.length) }),
    bars: rows.map((row) => ({ name: row.path, value: row.commands })),
    detailColumns: [
      // 次数按个位写；表只给精确值与占最大目录的份额。
      { key: "path", label: t("colWorkdir"), numeric: false, mono: true },
      { key: "commands", label: t("colCommands"), numeric: true },
      { key: "share", label: t("colShare"), numeric: true },
    ],
    detailRows: rows.map((row) => [
      { text: row.path },
      { text: String(row.commands) },
      { text: formatPct(ratioOf(row.commands, peak) * 100) },
    ]),
    detailKeys: rows.map((row) => row.path),
    detailFoot: t("workdirTableFoot"),
    detailCaption: t("workdirTableCaption"),
  });
}

/**
 * 跳过原因 Top。
 *
 * 这张表是「0 次压缩」的可解释性来源：没有它，读者分不清「没命中 filter」与「命中了但收益
 * 太低」，而这两种结论指向完全不同的设置项。
 */
/** 原因码是开放字符串：设计稿规定上限 40，超出按次数聚合为「其他（剩余 N 类）」弱色收尾。 */
const MAX_PIE_REASONS = 40;

function pieSlicesOf(rows: readonly SkipReasonRow[], t: Translate): PieSlice[] {
  if (rows.length <= MAX_PIE_REASONS) {
    return rows.map((row) => ({ name: row.reason, value: row.count }));
  }
  const head = rows
    .slice(0, MAX_PIE_REASONS)
    .map((row) => ({ name: row.reason, value: row.count }));
  const tail = rows.slice(MAX_PIE_REASONS);
  return [
    ...head,
    {
      name: t("reasonsOtherCount", { count: String(tail.length) }),
      value: tail.reduce((sum, row) => sum + row.count, 0),
      muted: true,
    },
  ];
}

/** 跳过原因构成：ECharts 实心饼（`renderPie()` 的等价实现），不是 SVG、也不是 CSS 锥形渐变。
 *
 * 设计稿 D 的五个硬要求都落在这里：`type:'pie'` 实心、`center:['40%','50%']` 右移图例、
 * 只有前 6 大片外置标签、`labelLayout` 防叠、右侧 `type:'scroll'` 图例带次数且可点击切换。
 * 图例与扇区同源，18 类不再聚合成「其余」；精确值仍在下方 details。
 */
function ReasonsPie(props: {
  readonly t: Translate;
  readonly rows: readonly SkipReasonRow[];
}): ReactNode {
  const { t, rows } = props;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const spec = useMemo<PieSpec>(
    () => ({
      kind: "pie",
      slices: pieSlicesOf(rows, t),
      // 主题色在 hook 里从容器计算样式补齐；这里给空数组只表示「顺序由入口决定」。
      colors: [],
      textColor: "",
      labelColor: "",
      tooltipBg: "",
      tooltipText: "",
      gridColor: "",
      lineColor: "",
      cardColor: "",
      pageColor: "",
      pageInactiveColor: "",
      mutedColor: "",
      formatTooltip: ({ name, value, percent }) =>
        t("pieTooltip", {
          name,
          value: String(value),
          percent: String(percent),
        }),
      formatLegend: (slice) => `${slice.name}　${String(slice.value)}`,
    }),
    [rows, t],
  );
  const { containerRef, failed } = useChart(spec);
  if (total <= 0) {
    return null;
  }
  const totalLabel = t("pieTotal", { total: String(total) });
  const pieAria = `${t("tableReasons")} · ${totalLabel} · ${String(rows.length)} 类`;
  return createElement(
    "div",
    { className: "rtkc-pieEchartWrap" },
    createElement("div", {
      ref: containerRef,
      className: "rtkc-pieEchart",
      role: "img",
      "aria-label": pieAria,
    }),
    failed ? createElement("p", { className: NOTE }, t("pieFailed")) : null,
  );
}

/** 跳过原因：卡片头（总数）＋ 实心饼 ＋ 折叠的全量表。
 *  表不再常驻展开：设计稿 D 把精确值收进 details，卡内首屏只留构成图，图与表同源。 */
export function ReasonsTable(props: {
  readonly t: Translate;
  readonly rows: readonly SkipReasonRow[];
}): ReactNode {
  const { t, rows } = props;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const title = createElement("h3", { className: SECTION_TITLE }, t("tableReasons"));
  if (rows.length === 0) {
    return createElement(
      "section",
      { className: `${BLOCK} rtkc-card` },
      title,
      createElement(EmptyState, { title: t("emptyTitle"), plain: true }, t("reasonsEmpty")),
    );
  }
  const totalLabel = t("pieTotal", { total: String(total) });
  const detailsLabel = t("reasonsDetails", { total: String(rows.length) });
  const footLabel = t("reasonsTableFoot", { total: String(rows.length) });
  const head = createElement(
    "div",
    { className: "rtkc-card-head" },
    title,
    createElement("span", { className: "rtkc-total" }, totalLabel),
  );
  const details = createElement(
    "details",
    { className: "rtkc-details" },
    createElement("summary", null, detailsLabel),
    dataTableOf({
      columns: [
        { key: "reason", label: t("colReason"), numeric: false },
        { key: "count", label: t("colCount"), numeric: true },
        { key: "share", label: t("colShareTotal"), numeric: true },
      ],
      rows: rows.map((row) => [
        { text: row.reason },
        { text: String(row.count) },
        { text: formatPct((row.count / total) * 100) },
      ]),
      rowKeys: rows.map((row) => row.reason),
      foot: footLabel,
      caption: t("reasonsTableCaption"),
    }),
  );
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card` },
    head,
    createElement(ReasonsPie, { t, rows }),
    details,
  );
}

/** 建议区：一条一段，语气只落在左边线与图标上，不铺整块底色。
 *  `warn` 用跳过黄、`info` 用业务蓝、`muted` 用三级文字灰——后者是「没有代价」的观察，
 *  不该和需要动手的条目抢同一层注意力。 */
export function Suggestions(props: {
  readonly t: Translate;
  readonly lines: readonly SuggestionLine[];
}): ReactNode {
  const { t, lines } = props;
  if (lines.length === 0) {
    return createElement(
      "section",
      { className: `${BLOCK} rtkc-suggest` },
      createElement("h3", { className: SECTION_TITLE }, t("suggestionsTitle")),
      createElement("p", { className: NOTE }, t("suggestionsEmpty")),
    );
  }
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-suggest` },
    createElement("h3", { className: SECTION_TITLE }, t("suggestionsTitle")),
    // 一句话就是一整句模板（`{filter}` 之类在客户端翻译时才替换）：拆成「粗体标题 + 说明」
    // 会让同一句在两种语言里断在不同的位置，而模板本身已经是通顺的一句。
    // 语气由外层的 `data-tone` 传给样式表；Callout 只保留固定图标，避免每种语气再抄一份 SVG。
    ...lines.map((line) =>
      createElement(
        "div",
        {
          key: line.key,
          className: "rtkc-suggestItem",
          "data-tone": line.tone,
        },
        createElement(
          Callout,
          { tone: line.tone === "warn" ? "warn" : "info" },
          t(line.messageKey, line.values),
        ),
      ),
    ),
  );
}
