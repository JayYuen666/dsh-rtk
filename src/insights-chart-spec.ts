// 图表的数据契约：入口（`src/insights-chart.ts`，必进 client.js）与图表块
// （`src/insights-echarts.ts`，延迟加载）共用这一份。
//
// 这个文件**只有类型**：两侧各自独立构建（入口一趟、chunk 一趟），类型导入会被擦掉，
// 所以它既不进任何一个产物，也不会让入口被迫 import ECharts。
//
// 为什么要把「画什么」和「怎么画」拆开：ECharts 与我们无关的那部分体积（约 500 KB）
// 只在真的要画图时才该下载。于是入口只负责把数据摊成这三个数组，chunk 负责把它们
// 变成坐标系——两边靠这张契约对齐，而不是靠一个共享的运行时模块。

/** 图表的三种形态。`bars` 只有柱；`combo` 是柱 + 折线（双 Y 轴）。 */
export type ChartKind = "bars" | "combo";

/** 一条序列：名字（图例/提示里用）+ 与 `labels` 等长的数值。 */
export interface ChartSeries {
  readonly name: string;
  /** 与 `labels` 等长；缺的位按 0 画。 */
  readonly values: readonly number[];
}

/**
 * 一份可直接交给 ECharts 的图。
 *
 * 颜色由**入口**从计算样式里取好再传进来：chunk 在另一个构建单元里，它拿不到本包的
 * CSS 变量名，也不该知道主题怎么切换——它只画，不管配色从哪来。
 */
export interface ChartSpec {
  readonly kind: ChartKind;
  readonly labels: readonly string[];
  /** 柱序列；`combo` 下是第一根柱。 */
  readonly bar: ChartSeries;
  /** 左轴名（设计稿 renderMain 的「次数」）；由入口按界面语言给，chunk 不写死中文。 */
  readonly countAxisName: string;
  /** `combo` 的折线序列；`bars` 下不传。 */
  readonly line?: ChartSeries;
  /** `[柱, 折线]` 两个颜色（`bars` 只用第一个）。 */
  readonly colors: readonly [string, string];
  /** 轴文字与网格线的颜色（跟随主题）。 */
  readonly textColor: string;
  readonly gridColor: string;
  /** tooltip 底色与文字色（跟随主题；深浅两套，由入口从计算样式取）。 */
  readonly tooltipBg: string;
  readonly tooltipText: string;
  /**
   * 紧凑档：设置卡里那张 132px 高的两柱图用。
   *
   * 为什么需要这一位：同一套 option 在 220px 的洞察页上正好（六条刻线各占一行），
   * 在 132px 里六条标签会叠成一团墨。紧凑档把刻度降到三档、外框收紧，
   * 柱子的高度差还看得出来，而精确数值本来就在上面两格 KPI 里。
   */
  readonly compact?: boolean;
}

/** 饼图一片：名字就是原因原文，值是该原因的命中次数。 */
export interface PieSlice {
  readonly name: string;
  readonly value: number;
  /** 超过 40 类时聚合出来的「其他」用弱色收尾，不参与类别色循环。 */
  readonly muted?: boolean;
}

/** 设计稿 `renderPie()` 的饼图规格：不是环形，前 6 大片外置标签，右侧图例滚动分页。 */
export interface PieSpec {
  readonly kind: "pie";
  readonly slices: readonly PieSlice[];
  /** 类别色序列：业务 → chart-tools → chart-messages → warn → success-secondary → error-secondary。 */
  readonly colors: readonly string[];
  readonly textColor: string;
  /** 片外标签文字色（设计稿 `renderPie()` 取 `--t2`，与图例同一档）。 */
  readonly labelColor: string;
  readonly tooltipBg: string;
  readonly tooltipText: string;
  /** tooltip 描边（设计稿取 `--l2`）；标签引导线取 `--t3`。 */
  readonly gridColor: string;
  readonly lineColor: string;
  /** 扇区之间的 1px 缝取卡片底色，不能取页面底色。 */
  readonly cardColor: string;
  /** 图例翻页箭头（业务色）与非当前页箭头。 */
  readonly pageColor: string;
  readonly pageInactiveColor: string;
  readonly mutedColor: string;
  readonly formatTooltip: (slice: {
    readonly name: string;
    readonly value: number;
    readonly percent: number;
  }) => string;
  readonly formatLegend: (slice: PieSlice) => string;
}

/** 两种图的规格：主图（柱/组合）与饼图共用一条挂载管线。 */
export type ChartInput = ChartSpec | PieSpec;

/** 挂上去之后的把手：更新数据 / 拆掉。 */
export interface ChartHandle {
  readonly update: (spec: ChartInput) => void;
  readonly dispose: () => void;
  /** 容器尺寸变化后重算画布（观察器在入口侧，chunk 只认这把钥匙）。 */
  readonly resize: () => void;
}

/** 图表块的导出面（chunk 侧实现，入口侧按这个形状用）。 */
export interface ChartModule {
  readonly mountChart: (container: HTMLElement, spec: ChartSpec) => ChartHandle;
  /** 饼图与柱图同在一个延迟 chunk；两者都注册才能共用一趟下载。 */
  readonly mountPie: (container: HTMLElement, spec: PieSpec) => ChartHandle;
}
