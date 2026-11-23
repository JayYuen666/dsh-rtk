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
  isEmptyWindow,
  kpiDeltaOf,
  kpiRowsOf,
  lastEventLineOf,
  rangeKeyOf,
  recentTitleKeyOf,
  requestOf,
  rtkSelfLinesOf,
  savingsValuesOf,
  suggestionLinesOf,
  withForm,
  withGranularity,
  withRange,
} from "../lib/insights-page-logic.ts";
import type { Granularity, KpiDelta, RangeDays, ViewState } from "../lib/insights-page-logic.ts";
import { zeroFillSeries } from "../lib/insights-view.ts";
import {
  Callout,
  EmptyState,
  KpiGrid,
  KpiTile,
  Segmented,
  SelectField,
} from "@jayyuen66/dsh-plugin-shared/client";

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
  labels: { readonly bar: string; readonly savings: string; readonly count: string },
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
    countAxisName: labels.count,
    // 柱子画**改写/压缩成功次数**，和 KPI 第一格同一个口径；设计稿标题就叫
    // 「改写次数与节省率」。取 savedTokens 会让 prefix 形态整天空白，取 attempts
    // 则柱子和 KPI 对不上（尝试次数不等于改写成次数）。
    bar: {
      name: labels.bar,
      values: series.map((point) => point.compressed),
    },
    ...(mode === "combo"
      ? { line: { name: labels.savings, values: savingsValuesOf(series) } }
      : {}),
    colors: ["", ""],
    textColor: "",
    gridColor: "",
    tooltipBg: "",
    tooltipText: "",
    // 洞察页主图按设计稿 D 用 220px 标准档（设置卡才是 162px 紧凑档）：
    // 折线、柱与三档以上的刻线都放得下。
    compact: false,
  };
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
  return createElement(SelectField, {
    bare: true,
    label: props.label,
    field: props.name,
    value: String(props.value),
    options: props.options.map((option) => ({
      value: String(option.value),
      label: option.label,
    })),
    onChange: (next: string) => {
      const picked = props.options.find((option) => String(option.value) === next);
      if (picked !== undefined) {
        props.onChange(picked.value);
      }
    },
  });
}

/**
 * 数字滚动只在本页**第一次**挂载时播一次。
 *
 * 每回一次请求都从头数一遍很吵：切页签、换窗口、点刷新都会重发请求，读者会以为数字在抖。
 * 模块级的这一位在整个页面生命周期里只翻一次；`useRef` 的初值保证同一次挂载内六格读到的是
 * 同一个答案，`useEffect` 在绘制之后才把它置位（不在渲染期写外部状态）。
 *
 * 这里刻意**不用 state**：一旦在 effect 里 `setAnimate(false)`，属性与 animation 会随那次
 * 重渲染一起消失，动画刚起就断在中间（真机实测 KPI 一格都没动过）。要的是「这一次挂载全程
 * 带这个属性」，播不播由 CSS 的 `animation` 自己决定——同一个元素上它只跑一次。
 */
let countupPlayed = false;

function useCountupOnce(): { readonly animate: boolean } {
  const firstMount = useRef(!countupPlayed);
  useEffect(() => {
    countupPlayed = true;
  }, []);
  return { animate: firstMount.current };
}

/** KPI 行：六格，窄屏由 CSS 折行。文案键由 `kpiRowsOf` 按形态选好，这里不再判形态。 */
function KpiRow(props: { readonly t: Translate; readonly response: InsightsResponse }): ReactNode {
  const { t, response } = props;
  const { animate } = useCountupOnce();
  const rows = kpiRowsOf(response.totals, response.form);
  // 涨跌标注：窗口内最后一桶对前一桶（口径见 kpiDeltaOf）。四种格各对到自己的序列字段，
  // 序列不足两桶/前置为 0/持平时 kpiDeltaOf 缺省，那几格不显示标注。
  // 胶囊里只放箭头与百分比（设计稿 `.k-delta` 的样表就是 `↑ 12%`）；「较前一日」这类
  // 基线说明会说满 78px 宽的一格并折成两行——那是布局事故，不是更清楚的说明。
  const DELTA_FIELD_OF: Record<string, "compressed" | "savedTokens"> = {
    rewrites: "compressed",
    saved: "savedTokens",
  };
  const deltaOf = (key: string): KpiDelta | undefined => {
    const field = DELTA_FIELD_OF[key];
    return field === undefined ? undefined : kpiDeltaOf(response.series, field);
  };
  const cells = createElement(
    KpiGrid,
    null,
    ...rows.map((row) =>
      createElement(KpiTile, {
        key: row.key,
        label: t(row.labelKey),
        value: row.value,
        unit: row.unit,
        sub: row.subKey === undefined ? undefined : t(row.subKey),
        count: animate && row.count !== undefined ? row.count : undefined,
        delta: deltaOf(row.key),
      }),
    ),
  );
  return createElement("section", { className: `${BLOCK} rtkc-card` }, cells);
}

/** 图 + 一句「为什么只有柱子」。数据为空时画画不出东西，直接给一句话。 */
function ChartBlock(props: {
  readonly t: Translate;
  readonly response: InsightsResponse;
  readonly state: ViewState;
}): ReactNode {
  const { t, response, state } = props;
  const spec = useMemo(
    () =>
      chartSpecOf(response, state, {
        bar: t(state.form === "prefix" ? "barRewrite" : "barCompressed"),
        savings: t("kpiSavings"),
        count: t("colCommands"),
      }),
    [response, state, t],
  );
  const { containerRef, failed } = useChart(spec);
  // 失败那一行先把内层翻译落成一个变量：`t("loadFailed", { reason: t(…) })` 写成一句会顶到
  // `unicorn(max-nested-calls)` 的上限（3 层），而拆开之后每一步都读得出来在翻什么。
  const failedText = t("loadFailed", { reason: t("loadFailedChart") });
  // 设计稿的图例在卡头一行。柱子那枚**始终**出现；折线那枚只在 combo 时补上——
  // 柱子单干时多一枚「节省率」色块会让读者去找一条并不存在的线。
  const legend = createElement(
    "div",
    { className: "rtkc-chart-legend" },
    createElement(
      "span",
      null,
      createElement("i", { style: { background: "var(--dsw-alias-state-business-primary)" } }),
      t(state.form === "prefix" ? "barRewrite" : "barCompressed"),
    ),
    ...(spec.kind === "combo"
      ? [
          createElement(
            "span",
            { key: "savings" },
            createElement("i", {
              style: { background: "var(--dsw-alias-state-warn-primary)" },
            }),
            t("kpiSavings"),
          ),
        ]
      : []),
  );
  const head = createElement(
    "div",
    { className: "rtkc-chart-head" },
    createElement(
      "h3",
      { className: SUBTITLE },
      t(state.form === "prefix" ? "chartTitlePrefix" : "chartTitlePipe"),
    ),
    legend,
  );
  // 空窗口由 `InsightsPage` 整页接管（它连图都不挂），所以这里不需要再判一次——原先那个
  // `empty` 分支永远走不到，`chartEmpty` 也就从来没有出现过。
  return createElement(
    "section",
    { className: `${BLOCK} rtkc-card` },
    head,
    createElement("div", {
      className: "rtkc-chart",
      ref: containerRef,
      role: "img",
      "aria-label": t(state.form === "prefix" ? "chartAriaPrefix" : "chartAriaPipe"),
    }),
    // 原因不写死英文：`loadFailed` 的模板在 `ui-messages` 里，`{reason}` 也翻译过。
    failed ? createElement("p", { className: NOTE }, failedText) : null,
    // 退成柱子时那句说明用页脚那种灰色小字：它回答的是「比率去哪了」，属于图的注释，
    // 不是一块需要先读的告警。设计稿 D 的卡片里图后没有警示块，卡片的节奏由 220px 图与
    // 卡头一行图例承担。
    spec.kind === "bars" ? createElement(Callout, { tone: "warn" }, t("chartSparseNote")) : null,
  );
}

/** 「今天 / 昨天 / 具体日期」；三支拆成早退，避免规则把嵌套三元判成不可读。 */
function whenTextOf(line: ReturnType<typeof lastEventLineOf>, t: Translate): string {
  if (line === undefined) {
    return "";
  }
  if (line.when === "date") {
    return line.dateText;
  }
  return t(line.when === "today" ? "whenToday" : "whenYesterday");
}

/** 「最近一次」：最近一条 + 一句说明，裸条形态（设计稿 .why：左边框染色 + 淡底，
 *  不再包一层带标题的卡片——标题缩成条内的语气标签，卡片少一层，节奏也少一拍）。
 *  标题与模板都按形态分（见 `recentTitleKeyOf`）。 */
function WhyBlock(props: {
  readonly t: Translate;
  readonly response: InsightsResponse;
}): ReactNode {
  const { t, response } = props;
  const line = lastEventLineOf(response.lastEvent);
  // 摘要参数先拼出来：直接内联会到四层调用（createElement → t → t → t），撞 lint 的层数上限。
  const when = whenTextOf(line, t);
  const summary =
    line === undefined
      ? undefined
      : {
          // `line.status` 的四个取值就是文案键本身（`lastCompressed` 等），不必再映射一次。
          time: `${when} ${line.clock}`,
          status: t(line.status),
          family: line.family === "unknown" ? t("commandFamilyUnknown") : line.family,
          reason: line.reason,
          ...(line.saved === undefined ? {} : { saved: line.saved }),
          ...(line.pct === undefined ? {} : { pct: line.pct }),
          ...(line.latency === undefined ? {} : { latency: line.latency }),
        };
  // 已改写/已压缩这两支的 reason 只是把 status 再说一遍（`rewritten` / `success`），
  // 走不带 reason 的短模板；跳过与失败才需要说明原因。模板键由 `line.templateKey` 给，
  // 这里只做「有没有这一条」的判断——两件事分开写，嵌套三元就自然没了。
  const text =
    line === undefined || summary === undefined ? t("whyNone") : t(line.templateKey, summary);
  // 设计稿 `.why` 只在左侧给一个小号语气标签，不用状态点：结局色由整条左边框与语气字承担，
  // 中间再放一枚圆点会把「时间 · 命令 · 结局」这一句读断。
  // 结局整行染色：色点太轻，一屏数字里看不出上一次是成功还是跳过。颜色只做加强，
  // 文字仍是「已跳过 · git status · too-small · 输入 tiny」——不靠颜色单独表意。
  // 语气标签先落成局部量：嵌套调用层数的上限挡住了内联写法。
  const tone = line === undefined ? undefined : line.tone;
  const toneLabel = createElement(
    "span",
    { className: "rtkc-whyTone" },
    t(recentTitleKeyOf(response.form)),
  );
  return createElement(
    "p",
    {
      className: `${NOTE} rtkc-recent`,
      ...(tone === undefined ? {} : { "data-tone": tone }),
    },
    toneLabel,
    text,
  );
}

/** 整页空窗口那一句：不摊六格 0 与三张空表。那堆 0 读起来像「插件坏了」，
 *  而它真正说的是「这段时间没有这一类活动」——换窗口或跑几条命令即可。 */
function EmptyWindow(props: { readonly t: Translate; readonly state: ViewState }): ReactNode {
  const { t, state } = props;
  const form = state.form === "prefix" ? t("tabPrefix") : t("tabPipe");
  const text = t("emptyWindow", { days: String(state.rangeDays), form });
  return createElement(
    "section",
    { className: "rtkc-emptyPage" },
    createElement(EmptyState, { title: t("emptyTitle"), plain: true }, text),
  );
}

/** 明细区：按形态给不同的表（prefix 没有 filter 这一层，也没有覆盖率列）。 */
function TablesBlock(props: {
  readonly t: Translate;
  readonly response: InsightsResponse;
}): ReactNode {
  const { t, response } = props;
  const groupTitle = t("compositionTitle");
  return createElement(
    "div",
    { className: "rtkc-tables" },
    response.form === "pipe" ? createElement(FilterTable, { t, rows: response.filters }) : null,
    createElement(CommandTable, { t, form: response.form, rows: response.commands }),
    // 设计稿 D 把「构成与排名」作为独立一组：图负责构成/排名，details 表负责精确值。
    createElement(
      "div",
      { className: "rtkc-groupHead" },
      createElement("h3", { className: "rtkc-subtitle" }, groupTitle),
    ),
    createElement(ReasonsTable, { t, rows: response.skipReasons }),
    createElement(WorkdirTable, { t, form: response.form, rows: response.workdirs }),
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
    // 设计稿 `.footnote` 的样句是「数据自 2026-10-28 起」；未知时只留「数据自 还没有数据」，
    // 不给未知值补一个「起」字。
    start === ""
      ? `${t("dataStartLabel")} ${t("dataStartUnknown")}`
      : `${t("dataStartLabel")} ${start} ${t("dataStartSuffix")}`,
    t("windowRange", { days: String(state.rangeDays) }),
    t(granularityKeyOf(state.granularity)),
  ];
  // 不可用的原因由 service 给**码**、这里按界面语言翻译（见 `AvailabilityReason`）。
  // 第一版 service 直接拼中文，en 界面就在页脚蹦一段中文，而页脚正是解释「为什么是 0」的
  // 那一行——读不懂它，读者只能把 0 当结论。
  for (const reason of response.availability.reasons) {
    parts.push(t(AVAILABILITY_KEYS[reason]));
  }
  const availability = availabilityKeyOf(response.availability);
  if (response.availability.reasons.length === 0 && availability === "unavailable") {
    parts.push(t("statsUnavailable"));
  } else if (response.availability.reasons.length === 0 && availability === "ok") {
    parts.push(t("availabilityOk"));
  }
  // 与 rtk 自己对账的那两句排在最后：它们解释的是「本页与 `rtk gain` 会不会对不上」，
  // 前提是先把「这一屏是什么窗口、数据从哪天开始」说清楚。判据全在 `rtkSelfLinesOf` 里
  // （只有改写形态、账本可读、且数不为 0 才出）。
  for (const line of rtkSelfLinesOf(response)) {
    parts.push(t(line.messageKey, line.values));
  }
  return createElement("p", { className: `${NOTE} rtkc-footnote` }, parts.join(" · "));
}

/** 页头：图标徽标 + 标题/副标题 + 刷新。抽出来是为了让 `InsightsPage` 留在行数上限内。 */
function PageHeader(props: {
  readonly t: Translate;
  readonly busy: boolean;
  readonly updatedAt: string | undefined;
  readonly onRefresh: () => void;
}): ReactNode {
  const { t, busy, updatedAt, onRefresh } = props;
  // 38px 徽标 + 两行标题（主标题/副标题）：整页唯一的标题区，数字页从这里建立层级。
  const badge = createElement(
    "span",
    { className: "rtkc-page-badge", "aria-hidden": true },
    createElement(RtkPanelIcon, { size: 20, active: true }),
  );
  const titles = createElement(
    "div",
    { className: "rtkc-page-titles" },
    createElement("h2", { className: "rtkc-page-title" }, t("panelPageTitle")),
    createElement("p", { className: "rtkc-page-sub" }, t("panelSub")),
  );
  const title = createElement("div", { className: "rtkc-page-titlewrap" }, badge, titles);
  // 最近一次成功读面的时间：数据不是实时的，读者要知道自己看的是几点的那一屏。
  const updated =
    updatedAt === undefined
      ? null
      : createElement(
          "span",
          { className: "rtkc-updated" },
          t("updatedAtLabel", { time: updatedAt }),
        );
  const button = createElement(
    "button",
    { type: "button", className: "rtkc-refresh", disabled: busy, onClick: onRefresh },
    busy ? t("loadingLabel") : t("refresh"),
  );
  const actions = createElement("div", { className: "rtkc-page-actions" }, updated, button);
  return createElement("header", { className: "rtkc-page-head" }, title, actions);
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
  // 最近一次成功读面的时刻（HH:mm）：只有成功才更新，失败的尝试不改这一位。
  const [updatedAt, setUpdatedAt] = useState<string | undefined>(undefined);

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
    if (next.error === undefined) {
      setUpdatedAt(
        new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      );
    }
    setBusy(false);
  }, [reader, state]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const { response, error } = loaded;
  const refresh = useCallback((): void => {
    void reload();
  }, [reload]);
  const header = createElement(PageHeader, { t, busy, updatedAt, onRefresh: refresh });

  // 形态页签与时间筛选分成两行：页签回答「看哪一种」，时间回答「看哪一段」。挤在一行时它们
  // 看起来像同一组分段控件，用户会以为切页签也会换时间。
  const controls = createElement(
    "div",
    { className: "rtkc-controls" },
    createElement(Segmented, {
      options: [
        { value: "prefix", label: t("tabPrefix") },
        { value: "pipe", label: t("tabPipe") },
      ],
      value: state.form,
      onChange: (form) => {
        const next = form === "pipe" ? "pipe" : "prefix";
        setState((prev) => withForm(prev, next));
      },
    }),
  );

  const timeFilter = createElement(
    "div",
    { className: "rtkc-timebar" },
    createElement("label", { className: "rtkc-timebar-label" }, t("rangeLabel")),
    createElement(Picker<RangeDays>, {
      name: "rangeDays",
      label: t("rangeLabel"),
      value: state.rangeDays,
      options: RANGE_DAYS.map((days) => ({ value: days, label: t(rangeKeyOf(days)) })),
      onChange: (days) => {
        setState((prev) => withRange(prev, days));
      },
    }),
    createElement("label", { className: "rtkc-timebar-label" }, t("granularityLabel")),
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
      // 内容列限宽居中（设计稿 860px）：滚动容器仍然吃满面板宽（滚动条贴面板右缘），
      // 列宽与节奏都由这一层管。
      createElement(
        "div",
        { className: "rtkc-column" },
        header,
        createElement("div", { className: "rtkc-page-controls" }, controls, timeFilter),
        ...children,
      ),
    );

  if (error !== undefined) {
    const failedText = t("loadFailed", { reason: error });
    return shell(
      createElement(
        "section",
        { className: `${BLOCK} rtkc-card` },
        createElement(Callout, { tone: "err" }, failedText),
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
