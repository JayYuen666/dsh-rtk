/*!
 * Apache ECharts — https://echarts.apache.org/
 * Copyright 2017-2026 The Apache Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this
 * file except in compliance with the License. You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * This product includes software developed at The Apache Software Foundation
 * (https://www.apache.org/). The full license text and the upstream NOTICE file are
 * reproduced in THIRD_PARTY_NOTICES.md of this package.
 *
 * 这个 `/*!` 开头的块是承重的：rolldown 的 legal-comments 只保留带感叹号的那种块，
 * ECharts 自己 dist 顶部那段不带感叹号的许可注释在 minify 时会被抹掉。
 */
// 图表块：ECharts 的按需装配 + 挂载。
//
// **这个文件不进 client.js**：它被 `build-client.mjs` 声明成包内 chunk
// （`client.insights-echarts.js`），只有真的要把图画出来时，`src/insights-chart.ts`
// 才会 `require.async("./client.insights-echarts.js")` 把它拉下来。
//
// 按需加载在这里是两层：
//   1. **按需下载**——整块代码不在入口产物里，用户没打开 Insights 页就一个字节都不下载；
//   2. **按需装配**——只 `import` 要用的三个图（bar / line / pie）、四个组件（grid /
//      tooltip / legend）与 canvas 渲染器，`echarts/core` 之外的东西一概不进包。
//
// 关于写法：从 `echarts/core` 取 `use`/`init` 是官方 ESM 按需入口；`echarts/charts` 这类
// 再导出表必须**按名字**取（`import { BarChart } from "echarts/charts"`），写成
// `import * as charts` 会把全部图表实现都拖进产物——那样按需就白做了。
//
// 许可：ECharts 是 Apache-2.0。产物头部由 `build-client.mjs` 用 `/*!` banner 写一份许可
// 摘要（rolldown 的 `comments: { legal: true }` 会保留它），全文与 NOTICE 见
// `THIRD_PARTY_NOTICES.md`。
// 别名不是风格问题：`use` 这个名字会被 `react-hooks` 那条规则当成 React Hook，
// 在模块顶层调用就判「Hook 不能在组件外调用」。改名即绕过，语义一个字没变。
import { init as echartsInit, use as echartsUse } from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  LegendScrollComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

import type {
  ChartHandle,
  ChartInput,
  ChartModule,
  ChartSpec,
  PieSpec,
} from "./insights-chart-spec.ts";

echartsUse([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  LegendScrollComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/** 坐标轴文字与分割线：颜色全从 `spec` 来，chunk 不认识本包的 CSS 变量。 */
interface AxisStyle {
  readonly textColor: string;
  readonly gridColor: string;
}

/** 柱序列；`combo` 下它是左轴那根。 */
function barSeriesOf(spec: ChartSpec): Record<string, unknown> {
  return {
    name: spec.bar.name,
    type: "bar",
    data: [...spec.bar.values],
    itemStyle: { color: spec.colors[0], borderRadius: [4, 4, 0, 0] },
    barWidth: spec.compact === true ? 20 : 14,
    yAxisIndex: 0,
    emphasis: { focus: "series" },
  };
}

/** 折线序列；`combo` 下它走右轴的百分比刻度。 */
function lineSeriesOf(
  spec: ChartSpec,
  line: { readonly name: string; readonly values: readonly number[] },
): Record<string, unknown> {
  return {
    name: line.name,
    type: "line",
    data: [...line.values],
    lineStyle: { color: spec.colors[1], width: 2 },
    itemStyle: { color: spec.colors[1] },
    symbol: "circle",
    symbolSize: 6,
    smooth: false,
    // 恒为 1：`lineSeriesOf` 只从 `optionOf` 的 `combo` 分支调进来（右侧百分比轴），
    // 写一个 `kind === "combo" ? 1 : 0` 的条件在那里永远为真，而且它会让读者以为
    // 折线也能画在左轴上——真要那样得先解决「token 与百分比同一根轴」的问题。
    yAxisIndex: 1,
    // 轴上的 `%` 是 formatter 加的后缀，tooltip 不走那个 formatter —— 不单独写一次，
    // 悬停时同一列会显示成 `63.96` 而轴上是 `64%`，看着像两个不同的量。
    // 一位小数与表格里的 `61.3%` 对齐：图上轴值是整数刻度，悬停时给更多精度会让
    // 同一数据在喉咙（图）与表格两处显示成两个数。
    tooltip: {
      valueFormatter: (value: number): string => `${String(Math.round(value * 10) / 10)}%`,
    },
  };
}

/** 左轴：token 量。分割线画在这里，右轴不再画。紧凑档只留三条刻线。 */
function tokenAxisOf(style: AxisStyle, compact: boolean, name: string): Record<string, unknown> {
  return {
    type: "value",
    // 设计稿 D 的 renderMain 用 4 条刻线、左轴名「次数」；紧凑档不写轴名。
    ...(compact ? {} : { name }),
    splitNumber: 4,
    nameTextStyle: { color: style.textColor, fontSize: 10 },
    axisLabel: { color: style.textColor, fontSize: compact ? 9 : 10 },
    axisLine: { lineStyle: { color: style.gridColor } },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: style.gridColor } },
  };
}

/** 右轴：百分比。`formatter` 后缀是必需的，否则 0.4 与 40 在两条轴上分不清。 */
function pctAxisOf(style: AxisStyle, name: string): Record<string, unknown> {
  return {
    type: "value",
    name,
    splitNumber: 4,
    nameTextStyle: { color: style.textColor, fontSize: 10 },
    axisLabel: { color: style.textColor, fontSize: 10, formatter: "{value}%" },
    axisLine: { lineStyle: { color: style.gridColor } },
    axisTick: { show: false },
    splitLine: { show: false },
  };
}

/**
 * 拼 option。
 *
 * `animation: false` 不是省事，是取舍：这张图每 5 秒可能被 `update` 重画一次，动画会让
 * 数据更新看起来像「图表在跳」，而读它的人要的是「这一周哪天省得多」。
 */
function optionOf(spec: ChartSpec): Record<string, unknown> {
  const style: AxisStyle = { textColor: spec.textColor, gridColor: spec.gridColor };
  const compact = spec.compact === true;
  const series: Record<string, unknown>[] = [barSeriesOf(spec)];
  const yAxis: Record<string, unknown>[] = [tokenAxisOf(style, compact, spec.countAxisName)];
  if (spec.kind === "combo" && spec.line !== undefined) {
    series.push(lineSeriesOf(spec, spec.line));
    yAxis.push(pctAxisOf(style, "%"));
  }
  // 紧凑档：设置卡里那张 132px 高的两柱图。刻度降到三档、外框收紧——同一套 option 在
  // 220px 的洞察页上正好（六条刻线各占一行），在 132px 里六条标签会叠成一团墨。
  const grid = compact
    ? { top: 24, right: 8, bottom: 26, left: 26 }
    : { top: 26, right: 46, bottom: 28, left: 46 };
  const reduceMotion =
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    animation: !reduceMotion,
    animationDuration: reduceMotion ? 0 : 240,
    grid,
    tooltip: {
      trigger: "axis",
      confine: true,
      // tooltip 底色与文字色随主题（入口从 CSS 变量取好放进 spec）；浅色主题下不再是深底。
      backgroundColor: spec.tooltipBg,
      borderColor: spec.gridColor,
      textStyle: { color: spec.tooltipText, fontSize: 12 },
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,.12)" } },
    },
    // 图例由卡片头那一行承担（设计稿 `.chart-card .c-head .legend`）。ECharts 自己也画一份
    // 时同一个「压缩次数/节省率」会出现两次，而且画布内那份会把 grid 顶部吃掉 28px。
    xAxis: {
      type: "category",
      data: [...spec.labels],
      axisLabel: {
        color: spec.textColor,
        fontSize: 10,
        interval: 1,
        hideOverlap: true,
      },
      axisLine: { lineStyle: { color: spec.gridColor } },
      axisTick: { show: false },
    },
    yAxis,
    series,
  };
}

/**
 * 饼图 option：逐字对设计稿 `renderPie()`。
 *
 * 五个承重点：实心 `radius:'55%'`（不是环）、`center:['40%','50%']` 给右图例让位、
 * 只有前 6 大片显示外置标签、`labelLayout` 防叠、图例 `type:'scroll'` 竖排并带次数。
 * 扇区之间 1px 缝取卡片底色；强调阴影是设计稿写死的 10px。
 */
function optionOfPie(spec: PieSpec): Record<string, unknown> {
  const reduceMotion =
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    animation: !reduceMotion,
    animationDuration: reduceMotion ? 0 : 240,
    color: [...spec.colors],
    tooltip: {
      trigger: "item",
      confine: true,
      backgroundColor: spec.tooltipBg,
      borderColor: spec.gridColor,
      borderWidth: 0.5,
      textStyle: { color: spec.tooltipText, fontSize: 12 },
      formatter: (params: {
        readonly name?: string;
        readonly value?: number;
        readonly percent?: number;
      }): string =>
        spec.formatTooltip({
          name: params.name ?? "",
          value: params.value ?? 0,
          percent: params.percent ?? 0,
        }),
    },
    legend: {
      type: "scroll",
      orient: "vertical",
      right: 8,
      top: "middle",
      textStyle: { color: spec.textColor, fontSize: 12 },
      pageIconColor: spec.pageColor,
      pageIconInactiveColor: spec.pageInactiveColor,
      pageTextStyle: { color: spec.textColor, fontSize: 11 },
      formatter: (name: string): string => {
        const slice = spec.slices.find((item) => item.name === name);
        return slice === undefined ? name : spec.formatLegend(slice);
      },
    },
    series: [
      {
        type: "pie",
        radius: "55%",
        center: ["40%", "50%"],
        data: spec.slices.map((slice, index) => ({
          name: slice.name,
          value: slice.value,
          label: { show: index < 6 },
          itemStyle: slice.muted === true ? { color: spec.mutedColor } : {},
        })),
        label: { color: spec.labelColor, fontSize: 12 },
        labelLine: { lineStyle: { color: spec.lineColor } },
        labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
        itemStyle: { borderColor: spec.cardColor, borderWidth: 1 },
        emphasis: {
          itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: "rgba(0, 0, 0, 0.5)" },
        },
      },
    ],
  };
}

/**
 * 把图画进 `container`，返回更新与拆掉的把手。
 *
 * 一个容器只 `init` 一次：每次 `init` 都会往 DOM 里塞一张新 canvas，重复 init 的结果是
 * 画布叠罗汉。尺寸变化走 `resize`——重建会丢掉 tooltip 的开合状态。
 */
function mountChart(container: HTMLElement, spec: ChartSpec): ChartHandle {
  const chart = echartsInit(container, undefined, { renderer: "canvas" });
  chart.setOption(optionOf(spec), true);
  // 尺寸自适应走两条腿：window resize（真实窗口拉伸）+ 入口侧的容器 ResizeObserver
  // （侧栏收起、面板分栏这类不动窗口的布局变化）。两条腿对同一帧各调一次 resize 是
  // 幂等的，缺哪条哪类变化就没人接——实测嵌入环境里 ResizeObserver 回调可能不派发，
  // window 那条是兜底。
  const onResize = (): void => {
    chart.resize();
  };
  globalThis.addEventListener("resize", onResize);
  return {
    update: (next: ChartInput) => {
      if (next.kind !== "pie") {
        chart.setOption(optionOf(next), true);
      }
    },
    resize: () => {
      chart.resize();
    },
    dispose: () => {
      globalThis.removeEventListener("resize", onResize);
      chart.dispose();
    },
  };
}

/** 饼图挂载：与柱图共用 `init` 与 window resize 兜底；更新走 merge，保留图例点击后的选中态。 */
function mountPie(container: HTMLElement, spec: PieSpec): ChartHandle {
  const chart = echartsInit(container, undefined, { renderer: "canvas" });
  chart.setOption(optionOfPie(spec), true);
  const onResize = (): void => {
    chart.resize();
  };
  globalThis.addEventListener("resize", onResize);
  return {
    update: (next: ChartInput) => {
      if (next.kind === "pie") {
        chart.setOption(optionOfPie(next));
      }
    },
    resize: () => {
      chart.resize();
    },
    dispose: () => {
      globalThis.removeEventListener("resize", onResize);
      chart.dispose();
    },
  };
}

/** chunk 的导出面；`src/insights-chart.ts` 按 `ChartModule` 的形状核对它。 */
const chartModule: ChartModule = { mountChart, mountPie };

export { chartModule };
