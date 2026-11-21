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

/** 挂上去之后的把手：更新数据 / 拆掉。 */
export interface ChartHandle {
  readonly update: (spec: ChartSpec) => void;
  readonly dispose: () => void;
  /** 容器尺寸变化后重算画布（观察器在入口侧，chunk 只认这把钥匙）。 */
  readonly resize: () => void;
}

/** 图表块的导出面（chunk 侧实现，入口侧按这个形状用）。 */
export interface ChartModule {
  readonly mountChart: (container: HTMLElement, spec: ChartSpec) => ChartHandle;
}
