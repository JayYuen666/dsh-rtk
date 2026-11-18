// Insights 页：左侧栏一级面板。
//
// 分工：本文件只管「挂载 + 事件」，数字怎么算在 `lib/insights-page-logic.ts`（纯逻辑，可脱离
// React 断言），图表怎么画在 `./insights-chart.ts`（ECharts 在选中本页之后才请求，见那里）。
//
// 只拉一次：切换页签/窗口/粒度各发一条 `insights` 请求。不做轮询——统计是给人看的，不是仪表盘，
// 每 5 秒重扫一遍事件表没有意义，反而会让「刚跑完一条命令想看结果」这件事变慢。
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { AvailabilityReason, InsightsResponse } from "../lib/insights-shape.ts";
import {
  GRANULARITIES,
  INITIAL_STATE,
  PANEL_ID,
  RANGE_DAYS,
  availabilityKeyOf,
  chartLabelsOf,
  chartModeOf,
  dataStartOf,
  granularityKeyOf,
  hasLatencyOf,
  isEmptyWindow,
  kpiRowsOf,
  lastEventLineOf,
  latencyLabelKeyOf,
  latencyLineOf,
  rangeKeyOf,
  recentTitleKeyOf,
  requestOf,
  savedValuesOf,
  savingsValuesOf,
  suggestionLinesOf,
  withForm,
  withGranularity,
  withRange,
} from "../lib/insights-page-logic.ts";
import type {
  Granularity,
  KpiRow as KpiRowSpec,
  RangeDays,
  ViewState,
} from "../lib/insights-page-logic.ts";
import { zeroFillSeries } from "../lib/insights-view.ts";

import type { ChartSpec } from "./insights-chart-spec.ts";
import { useChart } from "./insights-chart-hook.ts";
import { RtkPanelIcon } from "./insights-icon.ts";
import {
  CommandTable,
  FilterTable,
  ReasonsTable,
  Suggestions,
  WorkdirTable,
} from "./insights-tables.ts";
import type { StatsReader } from "./stats-reader.ts";
import type { Translate, UiMessages } from "./ui-messages.ts";

/** 三个反复出现的类名：`sonarjs(no-duplicate-string)` 数的是字面量，不是语义。 */
const BLOCK = "rtkc-block";
const SUBTITLE = "rtkc-subtitle";
const NOTE = "rtkc-note";

/** 一次读面的结局。`error` 与 `data` 互斥：读失败时不留半份旧图，那会让人以为是最新读数。 */
interface Loaded {
  readonly response: InsightsResponse | undefined;
  readonly error: string | undefined;
}

/** 读一次。`reader` 缺席（远程通道没装）时直接给一句「未连接」，不发请求。 */
async function loadOnce(reader: StatsReader | undefined, state: ViewState): Promise<Loaded> {
  if (reader === undefined) {
    return { response: undefined, error: "stats channel unavailable" };
  }
  try {
    return { response: await reader.insights(requestOf(state)), error: undefined };
  } catch (error) {
    return { response: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 把一次回执摊成图规格。峰值与归一在 chunk 里做——它才知道自己画多大。
 *
 * 配色字段留空：颜色要从**容器**的计算样式里读（chunk 不认识本包的 CSS 变量），而那要等
 * 容器挂上 DOM。这里填的不是配色决定，只是让 `ChartSpec` 的类型成立；挂载那一刻由
 * `useChart` 用 `paletteOf(node)` 覆盖掉。
 */
function chartSpecOf(
  response: InsightsResponse,
  state: ViewState,
  labels: { readonly saved: string; readonly savings: string },
): ChartSpec {
  const series = zeroFillSeries(
    response.series,
    state.rangeDays,
    state.granularity,
    Date.now(),
    // 数据起始日之前的桶不补：窗口比数据还长时，「那几天没有数据」不该画成 0 节省。
    dataStartOf(response),
  );
  const mode = chartModeOf(series);
  return {
    kind: mode,
    labels: chartLabelsOf(series, state.granularity),
    bar: { name: labels.saved, values: savedValuesOf(series) },
    ...(mode === "combo"
      ? { line: { name: labels.savings, values: savingsValuesOf(series) } }
      : {}),
    colors: ["", ""],
    textColor: "",
    gridColor: "",
  };
}

/** 一组页签：当前项加 `data-active`，样式与禁用态都交给 CSS。 */
function Tabs(props: {
  readonly value: ViewState["form"];
  readonly onChange: (form: ViewState["form"]) => void;
  readonly labels: readonly { readonly key: ViewState["form"]; readonly label: string }[];
}): ReactNode {
  return createElement(
    "div",
    { className: "rtkc-tabs", role: "tablist" },
    ...props.labels.map((entry) =>
      createElement(
        "button",
        {
          key: entry.key,
          type: "button",
          role: "tab",
          className: "rtkc-tab",
          "aria-selected": props.value === entry.key,
          "data-active": props.value === entry.key ? "true" : "false",
          onClick: () => {
            props.onChange(entry.key);
          },
        },
        entry.label,
      ),
    ),
  );
}

/** 一个下拉：选项值原样回传，调用方自己收窄（窗口与粒度各一套）。 */
function Picker<Value extends string | number>(props: {
  readonly name: string;
  /** 读屏名称：`data-field` 是给测试与样式用的，不构成无障碍名称。 */
  readonly label: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly onChange: (value: Value) => void;
}): ReactNode {
  return createElement(
    "select",
    {
      className: "rtkc-select",
      "data-field": props.name,
      "aria-label": props.label,
      value: String(props.value),
      onChange: (event: { readonly target: { readonly value: string } }) => {
        const picked = props.options.find((option) => String(option.value) === event.target.value);
        if (picked !== undefined) {
          props.onChange(picked.value);
        }
      },
    },
    ...props.options.map((option) =>
      createElement(
        "option",
        { key: String(option.value), value: String(option.value) },
        option.label,
      ),
    ),
  );
}

/** 一格 KPI：标签在上、数值在下。抽出来是为了不在 `KpiRow` 里叠四层 createElement。 */
function KpiCell(props: { readonly t: Translate; readonly row: KpiRowSpec }): ReactNode {
  const { t, row } = props;
  const label = createElement("span", { className: "rtkc-kpi-label" }, t(row.labelKey));
  const value = createElement("strong", { className: "rtkc-kpi-value" }, row.value);
  return createElement("div", { className: "rtkc-kpi", key: row.key }, label, value);
}

/** KPI 行：六格，窄屏由 CSS 折行。文案键由 `kpiRowsOf` 按形态选好，这里不再判形态。 */
function KpiRow(props: { readonly t: Translate; readonly response: InsightsResponse }): ReactNode {
  const { t, response } = props;
  const rows = kpiRowsOf(response.totals, response.form);
  const cells = createElement(
    "div",
    { className: "rtkc-kpis" },
    ...rows.map((row) => createElement(KpiCell, { t, row, key: row.key })),
  );
  // 改写形态只有平均（日表没留峰值），压缩形态才连最大值一起报。
  // 一次都没量到就不画这一句：`formatDuration(0)` 会渲染成「平均改写耗时: 0 ms」，那读起来
  // 像「这条链路很快」，而事实是「没量」——`hasLatencyOf` 的口径见它自己的注释。
  const latency = hasLatencyOf(response.totals)
    ? createElement(
        "p",
        { className: NOTE },
        `${t(latencyLabelKeyOf(response.form))}: ${latencyLineOf(response.totals, response.form)}`,
      )
    : null;
  return createElement("section", { className: `${BLOCK} rtkc-card` }, cells, latency);
}

/** 图 + 一句「为什么只有柱子」。数据为空时画画不出东西，直接给一句话。 */
function ChartBlock(props: {
  readonly t: Translate;
  readonly response: InsightsResponse;
  readonly state: ViewState;
}): ReactNode {
  const { t, response, state } = props;
  const spec = useMemo(
    () => chartSpecOf(response, state, { saved: t("kpiSaved"), savings: t("kpiSavings") }),
    [response, state, t],
  );
  const { containerRef, failed } = useChart(spec);
  // 失败那一行先把内层翻译落成一个变量：`t("loadFailed", { reason: t(…) })` 写成一句会顶到
  // `unicorn(max-nested-calls)` 的上限（3 层），而拆开之后每一步都读得出来在翻什么。
  const failedText = t("loadFailed", { reason: t("loadFailedChart") });
  // 空窗口由 `InsightsPage` 整页接管（它连图都不挂），所以这里不需要再判一次——原先那个
  // `empty` 分支永远走不到，`chartEmpty` 也就从来没有出现过。
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card` },
    createElement("h3", { className: SUBTITLE }, t("chartTitle")),
    createElement("div", { className: "rtkc-chart", ref: containerRef }),
    // 原因不写死英文：`loadFailed` 的模板在 `ui-messages` 里，`{reason}` 也翻译过。
    failed ? createElement("p", { className: NOTE }, failedText) : null,
    spec.kind === "bars" ? createElement("p", { className: NOTE }, t("chartSparseNote")) : null,
  );
}

/** 「最近一次」：最近一条 + 一句说明。标题与模板都按形态分（见 `recentTitleKeyOf`）。 */
function WhyBlock(props: {
  readonly t: Translate;
  readonly response: InsightsResponse;
}): ReactNode {
  const { t, response } = props;
  const line = lastEventLineOf(response.lastEvent);
  // 摘要参数先拼出来：直接内联会到四层调用（createElement → t → t → t），撞 lint 的层数上限。
  const summary =
    line === undefined
      ? undefined
      : {
          // `line.status` 的四个取值就是文案键本身（`lastCompressed` 等），不必再映射一次。
          status: t(line.status),
          family: line.family,
          reason: line.reason,
          size: line.size,
        };
  // 已改写/已压缩这两支的 reason 只是把 status 再说一遍（`rewritten` / `success`），
  // 走不带 reason 的短模板；跳过与失败才需要说明原因。模板键由 `line.templateKey` 给，
  // 这里只做「有没有这一条」的判断——两件事分开写，嵌套三元就自然没了。
  const text =
    line === undefined || summary === undefined ? t("whyNone") : t(line.templateKey, summary);
  const heading = createElement("h3", { className: SUBTITLE }, t(recentTitleKeyOf(response.form)));
  // 结局带一个色点：一屏数字里「上一次是成功还是跳过」要靠颜色一眼分开，读完那一长串
  // 「已跳过 · git status · too-small · 输入 tiny」才知道结论太慢。
  const dot =
    line === undefined
      ? null
      : createElement("span", {
          className: "rtkc-dot",
          "data-tone": line.tone,
          "aria-hidden": true,
        });
  // 结局整行染色：色点太轻，一屏数字里看不出上一次是成功还是跳过。颜色只做加强，
  // 文字仍是「已跳过 · git status · too-small · 输入 tiny」——不靠颜色单独表意。
  const body = createElement(
    "p",
    {
      className: `${NOTE} rtkc-recent`,
      ...(line === undefined ? {} : { "data-tone": line.tone }),
    },
    dot,
    text,
  );
  return createElement("section", { className: `${BLOCK} rtkc-card` }, heading, body);
}

/** 整页空窗口那一句：不摊六格 0 与三张空表。那堆 0 读起来像「插件坏了」，
 *  而它真正说的是「这段时间没有这一类活动」——换窗口或跑几条命令即可。 */
function EmptyWindow(props: { readonly t: Translate; readonly state: ViewState }): ReactNode {
  const { t, state } = props;
  const form = state.form === "prefix" ? t("tabPrefix") : t("tabPipe");
  const text = t("emptyWindow", { days: String(state.rangeDays), form });
  return createElement("p", { className: `${NOTE} rtkc-card rtkc-empty` }, text);
}

/** 明细区：按形态给不同的表（prefix 没有 filter 这一层，也没有覆盖率列）。 */
function TablesBlock(props: {
  readonly t: Translate;
  readonly response: InsightsResponse;
}): ReactNode {
  const { t, response } = props;
  return createElement(
    "div",
    { className: "rtkc-tables" },
    response.form === "pipe" ? createElement(FilterTable, { t, rows: response.filters }) : null,
    createElement(CommandTable, { t, form: response.form, rows: response.commands }),
    createElement(WorkdirTable, { t, rows: response.workdirs }),
    createElement(ReasonsTable, { t, rows: response.skipReasons }),
  );
}

/** 原因码 → 文案键。表在模块级：放进函数里每次渲染都会重建一份对象。 */
const AVAILABILITY_KEYS: Readonly<Record<AvailabilityReason, keyof UiMessages>> = {
  prefixReadonly: "availPrefixReadonly",
  prefixMissing: "availPrefixMissing",
  prefixUnreadable: "availPrefixUnreadable",
  prefixSchema: "availPrefixSchema",
  pipeUnavailable: "availPipeUnavailable",
};

/** 数据说明：起始日 + 窗口 + 不可用原因。这一行存在的理由是「0 不代表从来没有过」。 */
function Footnote(props: {
  readonly t: Translate;
  readonly response: InsightsResponse;
  readonly state: ViewState;
}): ReactNode {
  const { t, response, state } = props;
  const start = dataStartOf(response);
  const parts = [
    `${t("dataStartLabel")}: ${start === "" ? t("dataStartUnknown") : start}`,
    t(rangeKeyOf(state.rangeDays)),
    t(granularityKeyOf(state.granularity)),
  ];
  // 不可用的原因由 service 给**码**、这里按界面语言翻译（见 `AvailabilityReason`）。
  // 第一版 service 直接拼中文，en 界面就在页脚蹦一段中文，而页脚正是解释「为什么是 0」的
  // 那一行——读不懂它，读者只能把 0 当结论。
  for (const reason of response.availability.reasons) {
    parts.push(t(AVAILABILITY_KEYS[reason]));
  }
  if (
    response.availability.reasons.length === 0 &&
    availabilityKeyOf(response.availability) === "unavailable"
  ) {
    parts.push(t("statsUnavailable"));
  }
  return createElement("p", { className: `${NOTE} rtkc-footnote` }, parts.join(" · "));
}

/** 页头：图标 + 标题 + 刷新。抽出来是为了让 `InsightsPage` 留在行数上限内。 */
function PageHeader(props: {
  readonly t: Translate;
  readonly busy: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  const { t, busy, onRefresh } = props;
  const title = createElement(
    "h2",
    { className: "rtkc-page-title" },
    createElement(RtkPanelIcon, { size: 18, active: true }),
    t("panelLabel"),
  );
  const button = createElement(
    "button",
    { type: "button", className: "rtkc-refresh", disabled: busy, onClick: onRefresh },
    busy ? t("loadingLabel") : t("refresh"),
  );
  return createElement("header", { className: "rtkc-page-head" }, title, button);
}

/** 页面本体。`props.reader` 缺席时整页只显示一行「未连接」，不画空图。 */
export function InsightsPage(props: {
  readonly reader: StatsReader | undefined;
  readonly t: Translate;
}): ReactNode {
  const { reader, t } = props;
  const [state, setState] = useState<ViewState>(INITIAL_STATE);
  const [loaded, setLoaded] = useState<Loaded>({ response: undefined, error: undefined });
  const [busy, setBusy] = useState(true);

  // 请求代际号：切形态/窗口/粒度各发一条请求，而它们的回执可能**乱序**回来。没有代际号时
  // 慢的那条后到会把新的结果覆盖掉——用户切到「结果压缩」，屏幕上却是上一屏「命令改写」的
  // 数字，而页签已经变了。只让最后一次发出的请求落地。
  const generationRef = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setBusy(true);
    const next = await loadOnce(reader, state);
    if (generationRef.current !== generation) {
      return;
    }
    setLoaded(next);
    setBusy(false);
  }, [reader, state]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const { response, error } = loaded;
  const refresh = useCallback((): void => {
    void reload();
  }, [reload]);
  const header = createElement(PageHeader, { t, busy, onRefresh: refresh });

  // 形态页签与时间筛选分成两行：页签回答「看哪一种」，时间回答「看哪一段」。挤在一行时它们
  // 看起来像同一组分段控件，用户会以为切页签也会换时间。
  const controls = createElement(
    "div",
    { className: "rtkc-controls" },
    createElement(Tabs, {
      value: state.form,
      labels: [
        { key: "prefix", label: t("tabPrefix") },
        { key: "pipe", label: t("tabPipe") },
      ],
      onChange: (form) => {
        setState((prev) => withForm(prev, form));
      },
    }),
  );

  const timeFilter = createElement(
    "div",
    { className: "rtkc-timebar" },
    createElement("span", { className: "rtkc-timebar-label" }, t("timeFilterLabel")),
    createElement(Picker<RangeDays>, {
      name: "rangeDays",
      label: t("rangeLabel"),
      value: state.rangeDays,
      options: RANGE_DAYS.map((days) => ({ value: days, label: t(rangeKeyOf(days)) })),
      onChange: (days) => {
        setState((prev) => withRange(prev, days));
      },
    }),
    createElement(Picker<Granularity>, {
      name: "granularity",
      label: t("granularityLabel"),
      value: state.granularity,
      options: GRANULARITIES.map((granularity) => ({
        value: granularity,
        label: t(granularityKeyOf(granularity)),
      })),
      onChange: (granularity) => {
        setState((prev) => withGranularity(prev, granularity));
      },
    }),
  );

  const shell = (...children: readonly ReactNode[]): ReactNode =>
    createElement(
      "div",
      { className: "rtkc-page", "data-panel": PANEL_ID },
      header,
      createElement("div", { className: "rtkc-page-controls" }, controls, timeFilter),
      ...children,
    );

  if (error !== undefined) {
    return shell(
      createElement(
        "p",
        { className: `${NOTE} rtkc-warn rtkc-card` },
        t("loadFailed", { reason: error }),
      ),
    );
  }
  if (response === undefined) {
    return shell(createElement("p", { className: `${NOTE} rtkc-card` }, t("loadingLabel")));
  }
  // 整个窗口一次调用都没有：不摊六格 0 与三张空表。那堆 0 读起来像「插件坏了」，
  // 而它真正说的是「这段时间没有这一类活动」——换窗口或跑几条命令即可。
  if (isEmptyWindow(response.totals)) {
    return shell(
      createElement(EmptyWindow, { t, state }),
      createElement(Footnote, { t, response, state }),
    );
  }
  return shell(
    createElement(KpiRow, { t, response }),
    createElement(ChartBlock, { t, response, state }),
    createElement(WhyBlock, { t, response }),
    createElement(TablesBlock, { t, response }),
    createElement(Suggestions, { t, lines: suggestionLinesOf(response.suggestions) }),
    createElement(Footnote, { t, response, state }),
  );
}
