// src/client-entry.ts —— 设置卡入口：样式注入 + 配置表单绑定 + 插槽注册。
// 取值与判定全部落在 lib/card-logic.ts；本文件只做 React 渲染与副作用挂载。
//
// 槽位 key（BUNDLE_PKG）与宿主模块表键必须逐字相同——build-client.mjs 在构建期核对它，
// 因此这个字面量不能改成模板串。导出形态与兄弟仓一致：只有命名导出，没有 default——
// 两者混用会让 rolldown 报 MIXED_EXPORTS，且外壳那层取默认导出时拿到的是命名空间对象。
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiskConfirmation } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ReactNode } from "react";
import {
  Badge,
  Callout,
  CardForm,
  FieldTwoCol,
  ListField,
  NumberField,
  SaveBar,
  Section,
  SectionToggle,
  SelectField,
  TextField,
  ToggleField,
  diffTouched,
  ensureCardUiCss,
  errorText,
  splitHint,
  useInvalidFields,
} from "@jayyuen66/dsh-plugin-shared/client";
import type { SelectOption } from "@jayyuen66/dsh-plugin-shared/client";

import { RTK_LOGO_DATA_URI } from "./rtk-icon.ts";

import {
  FORM_MODES,
  cardStore,
  draftFields,
  formModeOf,
  formsOf,
  hintOf,
  numberOf,
  stringListOf,
} from "../lib/card-logic.ts";
import type { CardSnapshot, CardFields, SettingScope } from "../lib/card-logic.ts";
import { ALL_FILTERS } from "../lib/command-filter.ts";
import { MIN_RTK_VERSION } from "../lib/rtk-version.ts";
import type { AvailabilityReason, StatsOverview } from "../lib/insights-shape.ts";
import type { StatsStatus } from "../lib/stats-shape.ts";
import { createStatsReader } from "./stats-reader.ts";
import type { StatsReader } from "./stats-reader.ts";
import { RtkPanelIcon } from "./insights-icon.ts";
import { InsightsPage } from "./insights-page.ts";
import { useChart } from "./insights-chart-hook.ts";
import type { ChartSpec } from "./insights-chart-spec.ts";
import {
  PANEL_ID,
  PANEL_ORDER,
  cardKpiRowsOf,
  overviewHasData,
} from "../lib/insights-page-logic.ts";
import type { CardKpiRow } from "../lib/insights-page-logic.ts";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { Translate, UiMessages } from "./ui-messages.ts";

/** 卡片上那句不可用提示：原因码 → 文案键（与 Insights 页脚共用同一组键）。 */
const CARD_AVAILABILITY_KEYS: Readonly<Record<AvailabilityReason, keyof UiMessages>> = {
  prefixReadonly: "availPrefixReadonly",
  prefixMissing: "availPrefixMissing",
  prefixUnreadable: "availPrefixUnreadable",
  prefixSchema: "availPrefixSchema",
  pipeUnavailable: "availPipeUnavailable",
};

/** bundle 包名。槽位 key 必须用它（owner 派发 `entryKey: pkg.name`），用 `id: rtk` 卡片不渲染。
 *  必须是**字面量声明**：build-client.mjs 的 verifyName 用 `/(?:const|let|var)\s+BUNDLE_PKG\s*=\s*"…"/`
 *  读它并跟 package.json 的 name 逐字比对，写成 `= PACKAGE_NAME` 会让那条核对当场红。 */
export const BUNDLE_PKG = "@jayyuen66/dsh-rtk";
/** 设置命名空间 = cordis.patch.yml 的条目 id。 */
const NS = "rtk";
/** 设置页左侧一级分区的 id（`settings.section` 的 `id`，图标靠同一个值对上）。
 *  与 NS 分开写：分区 id 是**页面位置**的名字，命名空间是**配置与文案**的名字，两者
 *  哪天拆开（比如一个分区放两张卡）时不该互相牵连。 */
const SECTION_ID = "rtk";
/** 分区在导航里的位次：宿主已占 -10/0/10/15/20，本包三个分区排 30 起。 */
const SECTION_ORDER = 31;
/** 卡片样式表 id：同一页面挂两张同 id 的 <style> 会让后一张覆盖前一张。 */
const STYLE_ID = "rtk-card-css";
/** 统计轮询间隔：卡片挂在设置页/插件页期间每 5 秒拉一次概览与 status。 */
const STATS_REFRESH_MS = 5000;
/** 卡片自有样式；shared 的 CARD_UI_CSS 由 ensureCardUiCss 单独注入，本文件只放差异项。 */
const CARD_CSS = [
  ".rtkc-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,inherit);margin:6px 0}",
  // 提示条：宿主没有「警告底色」这一档别名（`--dsw-alias-state-warn-primary` 是实心琥珀色，
  // 铺成底会把正文压死），所以这里用同色系淡底写死——深浅主题各看得清，也不冒充宿主的语义色。
  // 今日摘要：卡片里的 KPI 格。**不复用洞察页那六格**：那是窗口总量、这是今日单形态，
  // 标签与量纲都不同；共用一套类名会让两处任何一次微调互相牵连。
  ".rtkc-today-block{margin:8px 0 4px}",
  ".rtkc-today-block .rtkc-subtitle{margin:0 0 10px}",
  // 卡片里的两格：比洞察页的六格高一点点（多一行量条），窄屏各占一半、再窄就整行。
  ".rtkc-today-block .rtkc-kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}",
  // 这里只补卡片特有的两点（竖排、给右上角留位）；`gap` 与 `padding` 交给 `.rtkc-kpi`
  // ——两处都写时后加载的那条赢，而「哪条赢」取决于样式注入顺序，不是我们能保证的事。
  ".rtkc-kpi-card{flex-direction:column;position:relative}",
  '.rtkc-kpi-card[data-idle="true"]{opacity:.72}',
  ".rtkc-kpi-body{display:flex;flex-direction:column;gap:6px;min-width:0}",
  ".rtkc-kpi-line{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;line-height:1.35}",
  ".rtkc-kpi-line .rtkc-kpi-value{font-size:16px}",
  // 量纲词比数字小两档、比标签淡：`67 次 · 81.3k token` 里读者先看数字，但不知道单位就
  // 得回头猜「67 是什么」。放在数字右侧而不是标签里，是因为两格的单位都不同。
  ".rtkc-kpi-unit{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,inherit)}",
  ".rtkc-kpi-sep{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);opacity:.6;margin:0 2px}",
  // 量条 + 百分比：条给「占比感」，数字给准值。条在前数字在后，读起来是「占这么多，61.3%」。
  // 条自己是独立元素而不是伪元素：宽度要跟着 `style.width` 走，伪元素塞不进去。
  ".rtkc-kpi-meter{display:flex;align-items:center;gap:8px}",
  ".rtkc-kpi-bar{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.28));overflow:hidden}",
  ".rtkc-kpi-bar-fill{display:block;height:100%;border-radius:2px;background:var(--rtkc-chart-bar);transition:width .2s ease-out}",
  ".rtkc-kpi-rate{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit);min-width:44px;text-align:right}",
  ".rtkc-kpi-idle{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}",
  // 一级分区里没有插件页那层卡片外壳，自己给一点上下留白，样式与插件页那张卡一致。
  // 导航图标：官方标记的 PNG 当 alpha 遮罩，颜色由 `background-color: currentColor` 给，
  // 于是深色主题是浅色标记、浅色主题是深色标记，跟宿主导航行同色。图形一个像素都不改。
  // data URI 来自 `./rtk-icon.ts` 的常量而不是在这里再抄一份字面量：两处字面量迟早会不同步。
  `.rtkc-icon{display:inline-block;background-color:currentColor;-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-image:url(${RTK_LOGO_DATA_URI});mask-image:url(${RTK_LOGO_DATA_URI})}`,
  // ---- Insights 页 ----
  //
  // 字号阶梯（页面只用这四档，别再临时插 13px / 14px）：11 元信息与表头、12 正文与表格、
  // 17 KPI 数字、1.05em 页标题。行高统一 1.5~1.65——这张页面数字多，行距紧了会挤成一团。
  //
  // 颜色只走三个来源：宿主别名变量（`--dsw-alias-*`，深浅主题自动跟）、本包四个图表变量、
  // 三个语义色（成功绿 / 跳过黄 / 失败红）。语义色在浅色主题下要另一套，所以按
  // `body:not([data-ds-dark-theme])` 覆盖一次，而不是把深色值写死。
  //
  // 宿主**没有** `bg-secondary` / `bg-primary` / `border-dim` / `bg-warning` 这四个别名（那是
  // 我们早期凭空写的，全会静默落到 fallback）。真实的对应物记在这里，别再靠猜：
  //   卡片底   `--dsw-alias-card-fill`（暗 #212123 / 亮 #fafafa）
  //   内层块   `--dsw-alias-card-tile-fill`（暗 5% 白 / 亮 50% 白，叠在卡片底上）
  //   边框     `--dsw-alias-border-l1/l2/l3`（暗 #ffffff0f/1f/29，亮 #0000000a/1a/1f）
  //   hover 底 `--dsw-alias-interactive-bg-hover`（暗 #ffffff14 / 亮 #2631480f）
  //   层底     `--dsw-alias-bg-layer-1/2/3`（暗 #232324/#2c2c2e/#353638，亮三档都是 #fff）
  // 下面四个本包变量把「表面 / 内层 / 描边 / 悬停」收成一层间接：改主题只改这四行。
  ":root{--rtkc-chart-bar:#3b6ef6;--rtkc-chart-line:#e08a2e;--rtkc-chart-text:#667085;--rtkc-chart-grid:#e4e7ec;--rtkc-chart-tooltip-bg:rgba(255,255,255,.96);--rtkc-chart-tooltip-text:#1c1d22;--rtkc-gap:12px}",
  // 四个表面变量必须挂在 **body** 上而不是 :root：宿主把 `--dsw-alias-*` 全定义在 body
  // （真机 `getComputedStyle(document.body).getPropertyValue("--dsw-alias-card-fill")` 有值，
  // `document.documentElement` 上是空串）。挂在 :root 时 `var()` 在 html 上求值就落到 fallback，
  // 于是主题换了、卡片底纹却一直是写死的那个 #1c1d20。
  "body{--rtkc-surface:var(--dsw-alias-card-fill,#1c1d20);--rtkc-tile:var(--dsw-alias-card-tile-fill,rgba(255,255,255,.06));--rtkc-line:var(--dsw-alias-border-l2,rgba(127,127,127,.22));--rtkc-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));--rtkc-raised:var(--dsw-alias-bg-layer-2,#2c2c2e);--rtkc-chart-bar:var(--dsw-alias-state-business-primary,#3b6ef6);--rtkc-chart-line:var(--dsw-alias-state-warn-primary,#e08a2e);--rtkc-chart-text:var(--dsw-alias-label-tertiary,#9aa3b2);--rtkc-chart-grid:var(--dsw-alias-border-l2,#ffffff1f);--rtkc-chart-tooltip-bg:var(--dsw-alias-tooltip-bg,rgba(24,26,32,.94));--rtkc-chart-tooltip-text:var(--dsw-alias-tooltip-label,#f2f4f7)}",
  // 图表配色走 CSS 变量：ECharts 在 chunk 里，读不到本包的样式表，只能由入口在挂载时
  // 用 getComputedStyle 从这里取（见 `./insights-chart.ts` 的 paletteOf）。
  //
  // 轴文字与网格线**必须分主题**：上面 `:root` 那两个是浅色主题的取值（深灰字 + 浅灰线），
  // 直接用在深色卡片上就是「深灰字压在 #212123 上」，对比度不足 4.5:1，真机上看不清刻度。
  // 这样写在 body 上而不是只在 :root 改一次，是因为宿主的主题切换只改 body 的属性、不重渲染
  // 本组件——`useChart` 里那条 MutationObserver 观察到属性变化后，会重新读这里取色再 update。
  // 主图轴与饼图的取色都走宿主语义令牌（设计稿 renderMain/renderPie 的同一组）：
  // 轴字是 label-tertiary，网格是 border-l2，类目色是 state/chart-*，切主题时宿主改
  // body 上的这几枚，`useChart` 的 MutationObserver 会重新读一遍。
  ".rtkc-page{display:flex;flex-direction:column;gap:var(--rtkc-gap);padding:4px 0 12px}",
  // 洞察页是主面板里的一整页，而宿主给它的容器**自己不滚**：ui-layout 的 `.centerCol`
  // 声明 `overflow:hidden`（AppFrame.module.css），中间也没有任何带滚动能力的包装层——
  // 官方两个一级页（插件页、任务页）都是页面自己开 `overflow-y:auto` 才滚得动。
  // 缺了这一条的症状是「数据一多，下半页连同表格直接看不见，也没有滚动条」。
  //
  // 用 `[data-panel]` 限定：设置卡外壳 `RtkSection` 也复用 `.rtkc-page`，而那一层的滚动
  // 由宿主设置页容器负责；在这里统一加 `flex:1` 会让卡片在设置页里被拉满整屏。
  // `scrollbar-gutter:stable` 是为了内容增长时不左右跳（官方任务页同款）。
  //
  // 那三个 `--dsh-scrollbar-*` 是宿主 ui-theme `styles/scrollbar.css` 读的几何量：默认 5px 宽、
  // 0px 边框，在深色卡片面上几乎看不出有滚动条。官方任务页（`TaskManagerPage.module.css` 的
  // `.pageScroll`）也是 9px + 2px 内缩，这里跟它对齐：拇指实际 5px、离边 2px，才看得出「还能往下滚」。
  // 配色用 l2 一对——本页的底色是卡片面，l1 那对是给基础面的。
  ".rtkc-page[data-panel]{flex:1 1 auto;min-height:0;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;padding:0;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
  // 内容列：设计稿 D 定 860px 内容宽（页头、工具栏、KPI、图与表同列）。列自身留 24px
  // 横向内边距，所以外层限宽按 860 + 48 算；否则卡片只剩 812px，比设计稿窄一档。
  ".rtkc-column{width:100%;max-width:908px;box-sizing:border-box;margin:0 auto;display:flex;flex-direction:column;gap:14px;padding:12px 24px;container-type:inline-size}",
  // 设计稿 D 的六格 KPI 下限是 118px（`.insights .kpi-grid`）：860 内容宽刚好六列。
  // 用容器查询而不是视口查询：侧栏收起后视口没变、内容列却从 730 变成 860，六格必须跟着变。
  ".rtkc-column .dsu-kpiGrid{grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px}",
  "@container (max-width:760px){.rtkc-column .dsu-kpiGrid{grid-template-columns:repeat(3,minmax(0,1fr))}}",
  "@container (max-width:520px){.rtkc-column .dsu-kpiGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}",
  // 页头与控件的节奏照设计稿：头部下 18px、工具栏下 16px（列 gap 14 补差值）。
  ".rtkc-page-head{display:flex;align-items:center;gap:14px;margin-bottom:4px}",
  ".rtkc-page-actions{margin-left:auto;display:flex;align-items:center;gap:10px}",
  ".rtkc-page-titlewrap{display:flex;align-items:center;gap:14px;min-width:0}",
  ".rtkc-page-badge{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;flex:none;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}",
  ".rtkc-cliRow{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}",
  ".rtkc-cliPath{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}",
  ".rtkc-page-titles{display:flex;flex-direction:column;min-width:0}",
  ".rtkc-page-title{font-size:18px;font-weight:650;margin:0;line-height:1.4}",
  ".rtkc-page-sub{margin:1px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".rtkc-updated{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}",
  // 刷新按钮照设计稿 D 的 `.btn btn-secondary btn-sm`：28px 高、常驻 0.5px 描边，
  // 页头右侧要能一眼看出这是可点的动作，而不是一行灰字。
  ".rtkc-refresh{font:inherit;font-size:12px;box-sizing:border-box;height:28px;line-height:1;padding:0 10px;border-radius:6px;border:.5px solid var(--rtkc-line);background:var(--rtkc-surface);color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;transition:background .12s,border-color .12s,color .12s}",
  ".rtkc-refresh:hover:not(:disabled){background:var(--rtkc-hover);border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.42));color:var(--dsw-alias-label-primary,inherit)}",
  ".rtkc-refresh:disabled{opacity:.55;cursor:default}",
  // 控件区：上行形态（换页签换的是**整种数据**）、下行时间（换的是同一种数据的一段）。
  // 两行之间留 12px、组内 8px：页签与时间栏不是同一级控件，挤成一行时用户会以为切页签
  // 也会换时间范围（真机反馈原话就是「时间作为筛选条件需单独设计位置」）。
  ".rtkc-page-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;margin-bottom:2px}",
  ".rtkc-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
  // 时间栏：一组「标签 + 两个下拉」，自己一块浅底，与页签在视觉上分成两件不同的事。
  // 标签与下拉之间 8px、下拉之间 8px，两侧内边距不对称（左 10 右 6）——右边紧贴下拉的
  // 圆角，留同样的 10px 会让整块看起来右侧空了一块。
  ".rtkc-timebar{display:flex;flex-wrap:wrap;align-items:center;flex:0 0 auto;gap:8px}",
  ".rtkc-timebar-label{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}",
  // 时间栏下拉：外观照设计稿 `.select .input`——appearance:none 去掉系统白箭头，
  // 自绘右侧 8px 折角；28px 高、14px 字、min-width 96px，底色取宿主输入框的 bg-layer-3。
  // 每一块都是卡片：深色主题下只靠间距分块，信息一多就糊成一片。
  // 内边距照设计稿 chart-card 的 16px 18px。
  ".rtkc-card{padding:16px 18px;border-radius:12px;border:.5px solid var(--rtkc-line);background:var(--rtkc-surface)}",
  ".rtkc-block{margin:0}",
  ".rtkc-subtitle{font-size:14px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary,inherit);margin:0 0 10px}",
  // KPI：数字大、标签小，卡片之间 10px。hover 时描边亮一档，让人知道这块是可以停下来看的。
  ".rtkc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px}",
  ".rtkc-kpi{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:9px;background:var(--rtkc-tile);border:1px solid var(--rtkc-line);transition:border-color .12s,transform .12s}",
  ".rtkc-kpi:hover{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.42))}",
  ".rtkc-kpi-label{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}",
  ".rtkc-kpi-value{font-size:17px;line-height:1.25;font-weight:600;font-variant-numeric:tabular-nums}",
  // ---- 数字滚动（只在前三格次数上播一次）----
  // 纯 CSS：注册一个整数型自定义属性让浏览器能对它插值，再用 `counter()` 把它画成文本。
  // 没有 JS 定时器、没有逐帧 setState —— 动画不占主线程。
  // 三条一起才成立：
  // ① `font-size:0` 让元素自身文本不可见（否则浏览器画的是最终值，动画看起来没发生）；
  // ② `counter-reset` 把计数器绑到那个自定义属性上，`::after` 用 `counter()` 画出来；
  // ③ `content: counter(x) / ""` —— 斜杠后是替代文本，写空串表示「它是装饰、别再念一遍」，
  //    否则读屏会把同一个数字念两次。
  // 减少动效时**不能删掉动画**：起手的 0 是靠 keyframes 给的，删了动画就只剩
  // `initial-value:0`，数字会永远停在 0。把时长压到 1ms 等价于「直接给终值」。
  // 洞察页主图 220px（设计稿 D 的标准档；设置卡是 `.rtkc-card-chart` 的 162px 紧凑档）。
  ".rtkc-chart{width:100%;height:220px}",
  // 图头与图例：标题左、图例右；色块 8px。柱子那枚始终在场，折线那枚只在 combo 时补上。
  ".rtkc-chart-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}",
  ".rtkc-chart-head .rtkc-subtitle{margin:0}",
  ".rtkc-chart-legend{margin-left:auto;display:flex;gap:14px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}",
  ".rtkc-chart-legend span{display:flex;align-items:center;gap:6px}",
  ".rtkc-chart-legend i{width:8px;height:8px;border-radius:2px;display:inline-block;background:var(--rtkc-chart-bar)}",
  // 设置卡里的那张小图（`.rtkc-card-chart`）是 162px 紧凑档：洞察页的 220px 到了卡片里
  // 会顶掉字段节奏。ECharts 的 `grid` 上下各留边给刻度与轴标签，64px 时绘图区只剩约 10px
  // ——真机上表现为「一条横线 + 两个看不见的柱」，看着像图坏了。
  ".rtkc-card-chart{width:100%;height:162px;margin:10px 0 2px}",
  // 语义色点：成功绿 / 跳过黄 / 失败红。语义色在浅色主题下压暗一档（见下方覆盖）。
  // 「最近一次」整行按结局染色：7px 的圆点在一屏数字里太轻，一眼扫过去分不出上一次是成功
  // 还是跳过。左边一条 2px 竖线 + 一层极淡底色，颜色与文字同时在场（不靠颜色单独表意——
  // 色弱用户读到的仍是那行「已跳过 · git status · too-small」）。
  ".rtkc-recent{display:flex;align-items:center;gap:10px;margin:0;padding:10px 14px;border-radius:8px;border-left:4px solid transparent;background:var(--rtkc-tile);font-size:14px;line-height:1.5}",
  '.rtkc-recent[data-tone="ok"]{border-left-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}',
  '.rtkc-recent[data-tone="skip"]{border-left-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent)}',
  '.rtkc-recent[data-tone="fail"]{border-left-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
  // 「最近一次」条内的语气标签：随结局染色（设计稿 .why 的 .w-tone）。
  ".rtkc-whyTone{flex:none;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}",
  '.rtkc-recent[data-tone="ok"] .rtkc-whyTone{color:var(--dsw-alias-state-success-primary)}',
  '.rtkc-recent[data-tone="skip"] .rtkc-whyTone{color:var(--dsw-alias-state-warn-primary)}',
  '.rtkc-recent[data-tone="fail"] .rtkc-whyTone{color:var(--dsw-alias-state-error-primary)}',
  // 明细区两张表卡之间的间距：rtkc-block 把 section 的 margin 清零后它们原本是贴死的。
  // 表区相对上一块的设计稿节奏是 26px（列 gap 14 补 12）。
  ".rtkc-tables{display:flex;flex-direction:column;gap:14px;margin-top:12px}",
  // 设计稿 D 的「构成与排名：图 + 全量表」是独立分组标题，位于命令族表之后。
  ".rtkc-groupHead{margin-top:10px}",
  ".rtkc-groupHead .rtkc-subtitle{margin:0}",
  ".rtkc-navCount{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums;white-space:nowrap}",
  ".rtkc-panelSection{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}",
  ".rtkc-panelSection strong{color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums;font-weight:600}",
  ".rtkc-tableFoot{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
  ".rtkc-expand{appearance:none;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;padding:0;cursor:pointer}",
  ".rtkc-expand:hover{text-decoration:underline}",
  ".rtkc-expand:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:2px}",
  // 跳过原因构成：实心饼 + 右侧图例（前 6 大 + 其余）。饼 240px，图例限高 240 内部滚动。
  ".rtkc-pieEchartWrap{position:relative;width:100%;min-width:0}",
  ".rtkc-pieEchart{width:100%;height:320px}",
  // 图 + 全量表：details 收起时卡内只留图形，展开后给精确值与全量行（表内 300px 滚动）。
  ".rtkc-card-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}",
  ".rtkc-card-head .rtkc-subtitle{margin:0}",
  ".rtkc-total{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums}",
  ".rtkc-details{border-top:1px solid var(--rtkc-line);margin-top:12px;padding-top:8px}",
  ".rtkc-details summary{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;padding:4px 0;border-radius:4px}",
  ".rtkc-details summary::-webkit-details-marker{display:none}",
  '.rtkc-details summary::before{content:"▸";color:var(--dsw-alias-label-tertiary,inherit);font-size:10px}',
  '.rtkc-details[open] summary::before{content:"▾"}',
  ".rtkc-details summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
  ".rtkc-details[open] summary{margin-bottom:8px}",
  ".rtkc-details .dsu-tblWrap{border:0;border-top:.5px solid var(--rtkc-line);border-radius:0;max-height:300px;overflow:auto}",
  // 排名比较：12px 圆角轨道、业务色填充、值右对齐；列表全量降序、限高 420px 内部滚动。
  ".rtkc-hbars{display:flex;flex-direction:column;gap:10px;max-height:420px;overflow-y:auto;margin:2px 0 0}",
  ".rtkc-hbar{display:grid;grid-template-columns:minmax(0,220px) 1fr 56px;gap:12px;align-items:center;font-size:12px}",
  ".rtkc-hbName{color:var(--dsw-alias-label-secondary,inherit);font-family:var(--dsw-font-mono,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".rtkc-hbTrack{height:12px;border-radius:999px;background:var(--rtkc-hover);overflow:hidden}",
  ".rtkc-hbFill{display:block;height:100%;border-radius:999px;background:var(--rtkc-chart-bar)}",
  ".rtkc-hbVal{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit)}",
  // 明细表照设计稿 .tbl：正文 14px、格 10px 12px、表头/表脚用卡片内层底 `--tile`。
  // shared 的 DataTable 默认 12px（设置卡那一档），洞察页是阅读面，字号大一档。
  ".rtkc-page[data-panel] .dsu-tbl{font-size:14px}",
  // 表头一律单行：命令族表五列里「次数」只有两字，允许折行会变成「次/数」两行，
  // 既抬高表头又打断对齐。设计稿的表头都是单行。
  // 背景必须是**不透底**的卡片色叠 tile：只写 `background:var(--rtkc-tile)`（5% 白）
  // 在 sticky 表头下会透出滚动到下面的行，看起来像两行字压在一起。
  ".rtkc-page[data-panel] .dsu-tbl th{white-space:nowrap;padding:8px 12px;background-color:var(--rtkc-surface);background-image:linear-gradient(var(--rtkc-tile),var(--rtkc-tile))}",
  ".rtkc-page[data-panel] .dsu-tbl td{padding:10px 12px}",
  ".rtkc-page[data-panel] .dsu-tblSticky td:first-child{background:var(--rtkc-surface)}",
  ".rtkc-page[data-panel] .dsu-tblSticky th:first-child{background-color:var(--rtkc-surface);background-image:linear-gradient(var(--rtkc-tile),var(--rtkc-tile))}",
  ".rtkc-page[data-panel] .dsu-tblFoot{font-size:12px;padding:8px 12px;background:var(--rtkc-tile);color:var(--dsw-alias-label-tertiary,inherit)}",

  // 建议区相对上一块的设计稿节奏是 22px（列 gap 14 补 8）；卡内条目纵向 8px 一档
  // （设计稿的建议列就是 gap:8px 的纵向排布），小标题的下距交给 gap 统一管。
  ".rtkc-suggest{margin-top:8px;display:flex;flex-direction:column;gap:8px;align-items:stretch}",
  ".rtkc-suggest .rtkc-subtitle{margin:0}",
  // 建议条目：一行一张安静的小卡，底色只比页面高半档；语气色只落在 3px 左边线和图标上。
  // 5 条建议若每条都铺整块 callout 底色，蓝/琥珀会变成五条「警报」，反而看不出哪条更急。
  ".rtkc-suggestItem{--rtkc-suggest-tone:var(--dsw-alias-state-business-primary);width:100%}",
  '.rtkc-suggestItem[data-tone="warn"]{--rtkc-suggest-tone:var(--dsw-alias-state-warn-primary)}',
  '.rtkc-suggestItem[data-tone="muted"]{--rtkc-suggest-tone:var(--dsw-alias-label-tertiary)}',
  ".rtkc-suggestItem .dsu-callout{width:100%;box-sizing:border-box;background:var(--rtkc-tile);border:.5px solid var(--rtkc-line);border-left:3px solid var(--rtkc-suggest-tone);border-radius:8px;padding:9px 12px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit)}",
  '.rtkc-suggestItem[data-tone="muted"] .dsu-callout{color:var(--dsw-alias-label-secondary,inherit)}',
  // 建议条目还有自己的 muted 档（启用但未命中），所以图标按 --rtkc-suggest-tone 收一次；
  // 普通 Callout（图表稀疏提示等）直接用 shared 的语义色，不再在本页叠一层兜底。
  ".rtkc-page[data-panel] .rtkc-suggestItem .dsu-calloutIcon{width:16px;height:16px;border-radius:999px;background:color-mix(in srgb,var(--rtkc-suggest-tone) 16%,transparent);color:var(--rtkc-suggest-tone);margin-top:2px}",
  // 页级空窗：设计稿 D 的页级接管用 36px 纵向内边距（与块级的 26px 区分开）。
  ".rtkc-emptyPage .dsu-empty{padding:36px 26px}",
  // 表格：表头小一号大写、行 hover 提亮、首列吃余宽、数值列带量条。
  //
  // 数值格：细量条 + 数字**同一行**并排。量条压在数字上方时行高会被撑到 60px。
  // 建议：卡片式，左边框按严重度换色（warn 用跳过黄，不用失败红——它是建议，不是错误）。
  ".rtkc-footnote{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:1.7}",
  // 浅色主题下的语义色：深色值在浅底上偏荧光，压暗一档才看得清又不刺眼。
  // 判据必须跟着宿主的 `body[data-ds-dark-theme]`（真机 body 上只有这一个属性，
  // 没有 `data-theme`），写成 `[data-theme="light"]` 会永不匹配、浅色下仍是深色那套。
].join("\n");

export const inject = ["slots", "configForms", "locale"];

interface CardSlotProps {
  readonly t: Translate;
  readonly useCard: <Type>(selector: (snap: CardSnapshot) => Type) => Type;
  readonly set: (field: string, value: unknown) => Promise<boolean>;
  readonly unset: (field: string) => Promise<boolean>;
  readonly statsRemote: StatsReader | undefined;
}

/** 数值输入：空串表示「清空 = 恢复默认」，不是 0。 */
function numberField(props: {
  t: Translate;
  field: string;
  label: string;
  hint: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  editable: boolean;
  resetToken: number;
  onInvalidChange: (invalid: boolean) => void;
  onChange: (next: number | undefined) => void;
}): ReactNode {
  return createElement(NumberField, {
    label: props.label,
    hint: props.hint,
    field: props.field,
    value: props.value,
    min: props.min,
    max: props.max,
    step: props.step,
    invalidHint: props.t("outOfRange"),
    resetToken: props.resetToken,
    onInvalidChange: props.onInvalidChange,
    disabled: !props.editable,
    onChange: props.onChange,
  });
}

/**
 * rtk 缺失 / 版本过低时卡片顶部那条引导行。
 *
 * 判定本身在 `lib/card-logic.ts` 的 `hintOf`（DOM-free，能在 node 里单测；本文件只做渲染，
 * 不参与覆盖率门禁）。两句话分别对应两种不同的失败，**不能合并**：`rtkPath === null` 是
 * 「这台机器上没装」，该给安装命令；`supported === false` 是「装了但太旧」，该说升到几。
 * `rtkVersion` 分不开它们——探测失败也交 `null`，所以判据取 `supported`。
 */
function RtkHint(props: {
  t: Translate;
  status: StatsStatus | undefined;
  detecting: boolean;
  onDetect: () => void;
}): ReactNode {
  const { t, status, detecting, onDetect } = props;
  const hint = hintOf(status);
  if (hint === undefined) {
    return null;
  }
  // 三支各自一句话：缺失与过旧是错误/警告，就绪支不再是裸 hint——设计稿 C 决定
  // 「徽章 + 检测」与 ocrReview 的状态件对齐，手动检测补足 5s 轮询；四态文案仍按现码口径。
  let node: ReactNode;
  if (hint.kind === "missing") {
    node = createElement(Callout, { tone: "err" }, t("rtkMissingHint"));
  } else if (hint.kind === "too-old") {
    const tooOld = t("rtkTooOldHint", { version: hint.version, minimum: MIN_RTK_VERSION });
    node = createElement(Callout, { tone: "warn" }, tooOld);
  } else {
    node = createElement(
      "div",
      { className: "rtkc-cliRow" },
      createElement(
        Badge,
        { tone: "ok", dot: "ok", field: "rtk-cli-badge" },
        t("rtkReadyBadge", { version: hint.version }),
      ),
      createElement(
        "span",
        {
          className: "rtkc-cliPath",
          title: t("rtkReadyHint", { version: hint.version, path: hint.path }),
        },
        hint.path,
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "dsu-btn dsu-btnSm",
          disabled: detecting,
          onClick: onDetect,
        },
        t("rtkDetect"),
      ),
    );
  }
  return node;
}

/** `67 次 · 81.3k token`：数字加粗、量纲词小一号且淡一档，换行时以「·」为界断开。 */
function kpiLineOf(t: Translate, row: CardKpiRow): ReactNode {
  return createElement(
    "div",
    { className: "rtkc-kpi-line" },
    createElement("strong", { className: "rtkc-kpi-value" }, row.commands),
    createElement("span", { className: "rtkc-kpi-unit" }, t("todayCommandsUnit")),
    createElement("span", { className: "rtkc-kpi-sep" }, "·"),
    createElement("strong", { className: "rtkc-kpi-value" }, row.saved),
    createElement("span", { className: "rtkc-kpi-unit" }, t("todaySavedUnit")),
  );
}

/** 节省率量条 + 百分比数字。条给占比感，数字给准值。 */
function kpiMeterOf(row: CardKpiRow): ReactNode {
  const fill = createElement("span", {
    className: "rtkc-kpi-bar-fill",
    style: { width: `${String(row.meterPct)}%` },
  });
  const bar = createElement("span", { className: "rtkc-kpi-bar" }, fill);
  return createElement(
    "div",
    { className: "rtkc-kpi-meter" },
    bar,
    createElement("span", { className: "rtkc-kpi-rate" }, row.savings),
  );
}

/** 非空态的那两行：数字行 + 量条行。 */
function cardKpiBodyOf(t: Translate, row: CardKpiRow): ReactNode {
  return createElement("div", { className: "rtkc-kpi-body" }, kpiLineOf(t, row), kpiMeterOf(row));
}

/** 一格形态摘要：标签 + 次数/省下/节省率 + 一条节省率量条。
 *
 * 为什么用卡片格而不是一行文字：卡片里有九格配置项，纯文字行在它们中间读起来像脚注；
 * 洞察页已经把「一格一个数」这套语言立起来了，两处同一套才不会像两个插件。
 *
 * `idle` 那一支渲染「还没有记录」而不是三个 0：0 会被读成「跑了命令但一分钱没省」，
 * 而事实是今天这条形态没被用过（真机反馈原话「没有的就不要显示避免误导」）。
 */
function CardKpi(props: { t: Translate; row: CardKpiRow }): ReactNode {
  const { t, row } = props;
  const head = createElement("span", { className: "rtkc-kpi-label" }, t(row.labelKey));
  const body = row.idle
    ? createElement("span", { className: "rtkc-kpi-idle" }, t("todayIdle"))
    : cardKpiBodyOf(t, row);
  return createElement(
    "div",
    { className: "rtkc-kpi rtkc-kpi-card", "data-idle": row.idle },
    head,
    body,
  );
}

/**
 * 设置卡里的今日摘要（`StatsOverview`）。
 *
 * 只报**今天**：一屏之内说清「今天省了多少」就够，要看历史去 Insights 页。
 * 两形态并排写而不是合并成一个节省率——spec §6 的口径是两档分开记账，
 * 合起来算会得到一个既不是改写收益也不是压缩收益的数。
 *
 * 读数缺席（remote 未连接 / 库打不开 / 首读还没回来）时给一行说明，不判错：
 * 压缩本身不依赖统计，卡片上没有数字不等于功能坏了。
 */
function StatsSummaryLine(props: { t: Translate; overview: StatsOverview | undefined }): ReactNode {
  const { t, overview } = props;
  if (overview === undefined) {
    return createElement("p", { className: "rtkc-note" }, t("statsUnavailable"));
  }
  const { availability } = overview;
  const rows = cardKpiRowsOf(overview.today);
  const cells = createElement(
    "div",
    { className: "rtkc-kpis" },
    ...rows.map((row) => createElement(CardKpi, { t, row, key: row.key })),
  );
  return createElement(
    "div",
    { className: "rtkc-today-block" },
    createElement("p", { className: "rtkc-subtitle" }, t("todayTitle")),
    cells,
    // 只有非 ok 才补一句：正常状态不该被一句提示占位。原因是**码**，句子在这里、按界面
    // 语言拼（service 拼中文的话，en 宿主这张卡上就是一段中文）。
    availability.reasons.length === 0
      ? null
      : createElement(
          "p",
          { className: "rtkc-note" },
          t(CARD_AVAILABILITY_KEYS[availability.reasons[0] ?? "pipeUnavailable"]),
        ),
  );
}

/**
 * 卡片里的两柱图：今日改写省下的 token 与结果压缩省下的 token。
 *
 * 为什么是两柱而不是一根：spec §6 的账是分形态记的，合成一根就得先回答「改写收益怎么和
 * 压缩收益相加」——它们量的不是同一件事（一个省的是命令输出，一个省的是被压缩的那段）。
 * 两根并排放在同一个纵轴上，读者看到的是真实比例，不需要先信一个换算。
 *
 * 数据全部来自已经取回的 `overview`：**不额外发请求**。ECharts 本体在 chunk 里，选中这一屏
 * 才会去要（`./insights-chart.ts` 负责那一步），所以卡片本身不会因此变重。
 */
function CardChart(props: { t: Translate; overview: StatsOverview | undefined }): ReactNode {
  const { t, overview } = props;
  // 三元而不是早退：`return undefined` 在 `consistent-return` 与 `no-useless-undefined`
  // 两条规则之间没有合法写法，表达式形态一次过。
  const spec = useMemo<ChartSpec | undefined>(
    () =>
      overview === undefined
        ? undefined
        : {
            kind: "bars",
            labels: [t("todayPrefix"), t("todayPipe")],
            countAxisName: t("kpiSaved"),
            bar: {
              name: t("kpiSaved"),
              values: [overview.today.prefix.savedTokens, overview.today.pipe.savedTokens],
            },
            colors: ["", ""],
            textColor: "",
            gridColor: "",
            tooltipBg: "",
            tooltipText: "",
            // 这张图只有 132px 高（`.rtkc-card-chart`）：走紧凑档，刻线降到三条。
            compact: true,
          },
    [overview, t],
  );
  const { containerRef, failed } = useChart(spec);
  // 两形态都还没跑过命令时不画空图：两根零高度的柱子看起来像「画坏了」。
  // 判据跟 KPI 的 idle 口径同源（commands），不看 savedTokens：命令跑过但收益为 0
  // 是「今天没有省下钱」，不是「今天没有数据」。
  const empty =
    overview === undefined ||
    (overview.today.prefix.commands === 0 && overview.today.pipe.commands === 0);
  if (empty) {
    return null;
  }
  // chunk 没加载起来时不能留一个空白图位：图位空着与「数据为 0」在视觉上同义，
  // 用户会以为统计已读而图坏了。这里落一句原因（与 Insights 页同一条文案）。
  return failed
    ? createElement(
        "p",
        { className: "rtkc-note" },
        t("loadFailed", { reason: t("loadFailedChart") }),
      )
    : createElement("div", { className: "rtkc-card-chart", ref: containerRef });
}

/**
 * 清零的二次确认弹窗。
 *
 * 用宿主的 `RiskConfirmation`（`@deepseek-ai/dsh-client-ui-primitives`，平台模块）：它自带
 * `role="dialog"` / `aria-modal` / Escape 与焦点回归，未勾选时确认键保持 disabled。自己拼一个
 * 弹窗要重做这一整套无障碍行为，而漏掉的那半在键盘用户那里就是「关不掉」或「直接执行」。
 *
 * 为什么值得一次确认：清零不是只清本插件的表——它连同一份库里的 rtk `commands` 一起删，
 * 删掉的行里带着每条改写命令的原始与改写后文本，误点一次找不回来。（清的是 dsh 自己的库，
 * 用户终端里的 `rtk gain` 历史不受影响——这一点写在弹窗正文里，免得用户以为全局数据被清。）
 */
function ResetConfirmation(props: {
  t: Translate;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const { t, busy, onCancel, onConfirm } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  return createElement(RiskConfirmation, {
    open: true,
    title: t("resetConfirmTitle"),
    description: t("resetConfirmDescription"),
    acknowledgeLabel: t("resetConfirmAcknowledge"),
    cancelLabel: t("resetCancel"),
    closeLabel: t("resetClose"),
    confirmLabel: t("resetConfirmAction"),
    acknowledged,
    disabled: busy,
    onAcknowledgedChange: setAcknowledged,
    onCancel,
    onConfirm,
  });
}

/**
 * 统计区：一行今日摘要 + 两柱图 + 清零按钮（历史窗口在 Insights 页）。
 */
function StatsSection(props: {
  t: Translate;
  reader: StatsReader | undefined;
  overview: StatsOverview | undefined;
  onReset: () => Promise<void>;
}): ReactNode {
  const { t, reader, overview, onReset } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirm = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await onReset();
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }, [onReset]);
  const cancel = useCallback((): void => {
    setConfirming(false);
  }, []);
  // 三元而不是早退：与 CardChart 同一条理由（`consistent-return` 与 `no-useless-undefined`
  // 之间没有合法的早退写法）。
  const reset =
    reader === undefined
      ? null
      : createElement(
          "button",
          {
            type: "button",
            className: "dsu-btn dsu-btnSm dsu-btnDanger",
            disabled: overview === undefined || !overviewHasData(overview),
            onClick: () => {
              setConfirming(true);
            },
          },
          t("resetStats"),
        );
  const dialog = confirming
    ? createElement(ResetConfirmation, {
        t,
        busy,
        onCancel: cancel,
        onConfirm: () => {
          void confirm();
        },
      })
    : null;
  return createElement(
    Section,
    { title: t("statusSection"), actions: reset },
    createElement(StatsSummaryLine, { t, overview }),
    // 两柱图只吃 overview 已经带回来的数：卡上多一条请求就是每次开设置都多付一次扫描。
    createElement(CardChart, { t, overview }),
    createElement("p", { className: "rtkc-note" }, t("statsNote")),
    dialog,
  );
}

/**
 * 十一个可写字段的写入分派。**字段名必须是字面量**：schema-coverage 门禁按 `set("字段名")`
 * 的字面量识别「这一格有绑定」，拼变量名会让它判成未绑定、整包门禁红。
 */
async function writeField(
  set: (field: string, value: unknown) => Promise<boolean>,
  key: string,
  draft: unknown,
): Promise<boolean> {
  if (key === "enabled") {
    return set("enabled", draft === true);
  }
  if (key === "enabledForms") {
    return set("enabledForms", formsOf(formModeOf(draft)));
  }
  if (key === "denyCommands") {
    return set("denyCommands", stringListOf(draft));
  }
  if (key === "enabledFilters") {
    return set("enabledFilters", stringListOf(draft));
  }
  if (key === "minBytes") {
    return set("minBytes", numberOf(draft));
  }
  if (key === "minGainRatio") {
    return set("minGainRatio", numberOf(draft));
  }
  if (key === "stdoutCapBytes") {
    return set("stdoutCapBytes", numberOf(draft));
  }
  if (key === "windowHeadLines") {
    return set("windowHeadLines", numberOf(draft));
  }
  if (key === "windowTailLines") {
    return set("windowTailLines", numberOf(draft));
  }
  if (key === "warnHint") {
    return set("warnHint", draft !== false);
  }
  return set("rewriteHostEnv", typeof draft === "string" ? draft : "");
}

/** 一个键的落盘动作：草稿不存在（= 用户清空）走 unset 恢复默认，否则写。 */
async function commitField(props: CardSlotProps, key: string, draft: unknown): Promise<boolean> {
  if (draft === undefined) {
    return props.unset(key);
  }
  return writeField(props.set, key, draft);
}

/** 草稿副本去掉一批键（保存成功后的清理；不就地改 state）。 */
function withoutKeys(
  touched: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  // 用重建而不是 `delete`：工作区的 no-dynamic-delete 判 error，而这里删的键本来就是
  // 一批动态键名，逐个 `delete` 既过不了 lint、也让「哪些键留下」这件事读起来要追副作用。
  return Object.fromEntries(Object.entries(touched).filter(([key]) => !keys.includes(key)));
}

/**
 * 开关控件：把「文案 → splitHint → props」这三跳收在一处。
 *
 * 不抽出来的写法必须在调用点写 `createElement(ToggleField, { …splitHint(t("…")) })`，
 * 那是三层嵌套调用，会触发 unicorn/max-nested-calls（上限 3）。
 */
function toggleField(props: {
  label: string;
  hint: string;
  field: string;
  checked: boolean;
  editable: boolean;
  onChange: (next: boolean) => void;
}): ReactNode {
  return createElement(ToggleField, {
    label: props.label,
    ...splitHint(props.hint),
    field: props.field,
    checked: props.checked,
    disabled: !props.editable,
    onChange: props.onChange,
  });
}

/** 逗号分隔的列表控件（同 `toggleField` 的理由）。 */
function listField(props: {
  label: string;
  hint: string;
  field: string;
  value: readonly string[];
  editable: boolean;
  onChange: (next: readonly string[]) => void;
}): ReactNode {
  return createElement(ListField, {
    label: props.label,
    ...splitHint(props.hint),
    field: props.field,
    value: props.value,
    separator: "comma",
    disabled: !props.editable,
    onChange: props.onChange,
  });
}

/** 单行文本控件（同 `toggleField` 的理由）。 */
function textField(props: {
  label: string;
  hint: string;
  field: string;
  value: string;
  editable: boolean;
  onChange: (next: string) => void;
}): ReactNode {
  return createElement(TextField, {
    label: props.label,
    ...splitHint(props.hint),
    field: props.field,
    value: props.value,
    placeholder: "",
    monospace: true,
    disabled: !props.editable,
    onChange: props.onChange,
  });
}

/** 三个分区共用的入参（拆分区只为压住单函数体量，不改变任何一格的语义）。 */
interface FieldSectionProps {
  readonly t: Translate;
  readonly view: CardFields;
  readonly writable: boolean;
  readonly setField: (name: string, draft: unknown) => void;
  readonly resetToken: number;
  readonly reportInvalid: (field: string, invalid: boolean) => void;
}

/** 形态区：总开关、形态选择，以及 B 形态未开时的一行说明。 */
function cardModeFields(props: FieldSectionProps): ReactNode[] {
  const { t, view, writable, setField } = props;
  // 三档顺序按「层级从少到多」排，而不是按 FORM_MODES（那是给表单取默认值用的顺序）。
  // 少一档都不行：`['pipe']` 若无处可选，卡片会把用户的存储值投影成别的档，
  // 用户只点一次保存就静默改了形态（见 lib/card-logic.ts 的 FORM_MODES 注释）。
  const modeOptions: SelectOption[] = [
    { value: FORM_MODES[0], label: t("formPrefix") },
    { value: FORM_MODES[1], label: t("formPrefixAndPipe") },
    { value: FORM_MODES[2], label: t("formPipeOnly") },
  ];
  return [
    createElement(SelectField, {
      label: t("formsLabel"),
      ...splitHint(t("formsHint")),
      field: "enabledForms",
      value: view.forms,
      options: modeOptions,
      disabled: !writable,
      onChange: (next: string) => {
        // 草稿里存**存储单位**（数组），不是档位字符串：`draftFields` 与 `writeField` 都按
        // 存储单位读，混一种单位就会「下拉点得动、值不跟着变」。
        setField("enabledForms", formsOf(formModeOf(next)));
      },
    }),
    view.forms === "prefix"
      ? createElement("p", { className: "rtkc-note" }, t("pipeDisabledHint"))
      : null,
  ];
}

/** 两张清单：拒绝前缀与 filter 白名单。 */
function cardFilterFields(props: FieldSectionProps): ReactNode[] {
  const { t, view, writable, setField } = props;
  return [
    listField({
      label: t("denyLabel"),
      hint: t("denyHint"),
      field: "denyCommands",
      value: view.denyCommands,
      editable: writable,
      onChange: (next) => {
        setField("denyCommands", next);
      },
    }),
    listField({
      label: t("filtersLabel"),
      hint: t("filtersHint", { filters: ALL_FILTERS.join(", ") }),
      field: "enabledFilters",
      value: view.enabledFilters,
      editable: writable,
      onChange: (next) => {
        setField("enabledFilters", next);
      },
    }),
  ];
}

/** 数字阈值一行的公共形状：cardNumberFields 的五行只差字段名/标签/提示/边界，
 *  越界上报与落态的接线逐字相同，抽一份避免抄五遍（其中两遍会漏接）。 */
function thresholdField(
  props: FieldSectionProps,
  spec: {
    readonly field: string;
    readonly label: string;
    readonly hint: string;
    readonly value: number | undefined;
    readonly min: number;
    readonly max: number;
    readonly step: number;
  },
): ReactNode {
  const { t, writable, setField, resetToken, reportInvalid } = props;
  return numberField({
    t,
    field: spec.field,
    label: spec.label,
    hint: spec.hint,
    value: spec.value,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    editable: writable,
    resetToken,
    onInvalidChange: (invalid) => {
      reportInvalid(spec.field, invalid);
    },
    onChange: (next) => {
      setField(spec.field, next);
    },
  });
}

/** 三个字节/比例阈值 + 提示开关 + 宿主环境变量。数字对按设计稿双列排布
 *  （字节阈值与收益比一对、窗口头/尾一对），单出的输出上限独占整行。 */
function cardNumberFields(props: FieldSectionProps): ReactNode[] {
  const { t, view, setField } = props;
  return [
    createElement(
      FieldTwoCol,
      null,
      thresholdField(props, {
        field: "minBytes",
        label: t("minBytesLabel"),
        hint: t("minBytesHint"),
        value: view.minBytes,
        min: 0,
        max: 1_048_576,
        step: 1,
      }),
      thresholdField(props, {
        field: "minGainRatio",
        label: t("minGainLabel"),
        hint: t("minGainHint"),
        value: view.minGainRatio,
        min: 0,
        max: 1,
        step: 0.01,
      }),
    ),
    thresholdField(props, {
      field: "stdoutCapBytes",
      label: t("stdoutCapLabel"),
      hint: t("stdoutCapHint"),
      value: view.stdoutCapBytes,
      min: 1,
      max: 10_485_760,
      step: 1,
    }),
    // 窗口那两位排在一起（头 / 尾），与它们在上游 `cap` method 里的相邻关系一致：
    // 分开摆会让「这两个数是同一件事的两半」读不出来。
    createElement(
      FieldTwoCol,
      null,
      thresholdField(props, {
        field: "windowHeadLines",
        label: t("windowHeadLabel"),
        hint: t("windowHeadHint"),
        value: view.windowHeadLines,
        min: 0,
        max: 5000,
        step: 1,
      }),
      thresholdField(props, {
        field: "windowTailLines",
        label: t("windowTailLabel"),
        hint: t("windowTailHint"),
        value: view.windowTailLines,
        min: 0,
        max: 5000,
        step: 1,
      }),
    ),
    toggleField({
      label: t("warnHintLabel"),
      hint: t("warnHintHint"),
      field: "warnHint",
      checked: view.warnHint,
      editable: props.writable,
      onChange: (next) => {
        setField("warnHint", next);
      },
    }),
    textField({
      label: t("hostEnvLabel"),
      hint: t("hostEnvHint"),
      field: "rewriteHostEnv",
      value: view.rewriteHostEnv,
      editable: props.writable,
      onChange: (next) => {
        setField("rewriteHostEnv", next);
      },
    }),
  ];
}

/**
 * 统计读面的状态与刷新。
 *
 * 卡片挂载期间每 `STATS_REFRESH_MS` 拉一次 overview/status；页面不可见时跳过，
 * 一次刷新还在路上时也跳过下一拍，避免慢请求叠出并发。
 *
 * 只拉概览、不拉明细：卡片上要的是今日几个数，按天/按 filter 的明细在 Insights 页里读
 * ——那一条请求比概览贵得多（要按窗口扫事件行），挂在设置卡上等于每次开设置都付一次。
 */
function useStatsRefresh(reader: StatsReader | undefined): {
  readonly overview: StatsOverview | undefined;
  readonly status: StatsStatus | undefined;
  readonly detecting: boolean;
  readonly detectStatus: () => Promise<void>;
  readonly resetStats: () => Promise<void>;
} {
  const [overview, setOverview] = useState<StatsOverview | undefined>(undefined);
  const [status, setStatus] = useState<StatsStatus | undefined>(undefined);
  const [detecting, setDetecting] = useState(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (reader === undefined || refreshing.current) {
      return;
    }
    refreshing.current = true;
    try {
      try {
        setOverview(await reader.overview());
      } catch {
        // 读面报错不清空已显示的数字：保留上一次成功的读数，比闪成「未连接」更少误导。
      }
      // 状态与统计各读各的：一条失败不该把另一条也抹掉（统计读面缺席时压缩照常，
      // 而 rtk 装没装正是用户最需要看到的那一句）。
      try {
        setStatus(await reader.status());
      } catch {
        // 同上：轮询失败不代表 rtk 被卸载，保留上一份状态直到下一次成功读到。
      }
    } finally {
      refreshing.current = false;
    }
  }, [reader]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }, STATS_REFRESH_MS);
    return () => {
      globalThis.clearInterval(timer);
    };
  }, [refresh]);

  /**
   * 手动检测只读 status（fs 探测，不起 rtk 进程），不捎带 overview：
   * 轮询失败时用户点「检测」要的是「到底装没装、版本够不够」，不该顺带再扫一遍统计表。
   */
  const detectStatus = useCallback(async (): Promise<void> => {
    if (reader === undefined) {
      return;
    }
    setDetecting(true);
    try {
      setStatus(await reader.status());
    } catch {
      // 探测失败保留上一份状态：按钮的可重复点击本身就是反馈，不把已显示的就绪行抹掉。
    } finally {
      setDetecting(false);
    }
  }, [reader]);

  const resetStats = useCallback(async (): Promise<void> => {
    if (reader === undefined) {
      return;
    }
    try {
      setOverview(await reader.reset());
    } catch {
      setOverview(undefined);
    }
  }, [reader]);

  return { overview, status, detecting, detectStatus, resetStats };
}

function RtkCard(props: CardSlotProps): ReactNode {
  const snap = props.useCard((state) => state);
  const writable = snap.status === "ready" && snap.writable;
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { statsRemote: reader, t } = props;
  const { overview, status, detecting, detectStatus, resetStats } = useStatsRefresh(reader);
  // 越界集与重置信号由 shared 的 `useInvalidFields()` 提供（多个消费仓共用同一套判定）。
  const invalid = useInvalidFields();
  const { blocked, fields: invalidFields, resetToken, reportInvalid } = invalid;

  const view = draftFields(touched, snap.value, status?.supported === true);
  const dirty = diffTouched(touched, snap.value);
  const pending = new Set([...dirty, ...invalidFields]);
  const setField = (name: string, draft: unknown): void => {
    setTouched((prev) => ({ ...prev, [name]: draft }));
  };

  const save = async (): Promise<void> => {
    if (dirty.length === 0 || blocked) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const results = await Promise.all(dirty.map((key) => commitField(props, key, touched[key])));
      if (results.some((accepted) => !accepted)) {
        setSaveError(t("saveRejected"));
        return;
      }
      setTouched((prev) => withoutKeys(prev, dirty));
      invalid.clear();
    } catch (error) {
      setSaveError(t("saveFailed", { reason: errorText(error) }));
    } finally {
      setBusy(false);
    }
  };

  const saveBar = createElement(SaveBar, {
    dirty: pending.size > 0,
    blocked,
    busy,
    writable,
    error: saveError ?? (blocked ? t("invalidFields") : null),
    saveLabel: t("save"),
    savingLabel: t("saving"),
    revertLabel: t("revert"),
    dirtyLabel: t("dirtyCount", { count: pending.size }),
    cleanLabel: t("statusClean"),
    readOnlyLabel: t("statusReadOnly"),
    onSave: () => {
      void save();
    },
    onDiscard: () => {
      setTouched({});
      setSaveError(null);
      invalid.clear();
    },
  });

  const enabledToggle = createElement(SectionToggle, {
    field: "enabled",
    label: t("enabledLabel"),
    checked: view.enabled,
    disabled: !writable,
    onChange: (next: boolean) => {
      setField("enabled", next);
    },
  });
  // 计数跟着 `CardFields` 的实际投影走：`draftFields` 每次返回完整的一枚对象，字段增减只改那一处。
  // 先算成局部量，避免 createElement 参数里的嵌套调用超过 lint 上限。
  const switchFieldCount = t("fieldCount", { count: String(Object.keys(view).length) });
  return createElement(
    CardForm,
    null,
    // 宿主 settings.section 的标题由左侧选中项承担；卡内不画 h1/h2 页头，只留 Section 小标题。
    // 引导行在说明之前：rtk 不在 PATH 时下面所有开关都不会有效果，先说这件事。
    createElement(RtkHint, {
      t,
      status,
      detecting,
      onDetect: () => {
        void detectStatus();
      },
    }),
    // 直接把 resetStats 交下去：确认弹窗要等它真的清完才关，包一层 void 就丢了那个 promise。
    createElement(StatsSection, { t, reader, overview, onReset: resetStats }),
    createElement(
      Section,
      {
        title: t("switchSection"),
        count: switchFieldCount,
        toggle: enabledToggle,
      },
      cardModeFields({ t, view, writable, setField, resetToken, reportInvalid }),
      cardFilterFields({ t, view, writable, setField, resetToken, reportInvalid }),
      cardNumberFields({ t, view, writable, setField, resetToken, reportInvalid }),
    ),
    saveBar,
  );
}

/**
 * 设置页导航图标（`settings.section.icon`）。
 *
 * 图形是 **rtk 官方标记**（`src/rtk-icon.ts` 里内联的那张 PNG，字节与 sha256 都记在那边）：
 * 用户明确要求「直接使用 rtk 官方的」，不要矢量化、不要剪影。这里只做一件事——把官方位图
 * 当 alpha 遮罩、用 `currentColor` 上色，于是深色主题是浅色标记、浅色主题是深色标记，
 * 与宿主导航行同色。**形状与 alpha 一个像素都不改**。
 *
 * 为什么用遮罩而不是直接 `<img src>`：官方标记是**白色**线稿，浅色主题下直接放进去就是
 * 白底白图看不见；而先改图再内联等于动官方像素（正是被否决的那条路）。遮罩只取 alpha。
 *
 * 样式写在 `CARD_CSS` 的 `.rtkc-icon` 里（data URI 那份长字符串只在样式表里出现一次）。
 *
 * @param props - `size` 是导航行要的方形边长，`active` 表示该分区当前被选中。
 * @returns 一个用遮罩上色的方块。
 */
function RtkSectionIcon(props: { readonly size: number; readonly active: boolean }): ReactNode {
  return createElement("span", {
    className: "rtkc-icon",
    style: { width: props.size, height: props.size },
    "aria-hidden": true,
    "data-rtk-section-icon": props.active ? "active" : "idle",
  });
}

/** 分区页面外壳：一级分区里没有插件页那层卡片外壳，这里补一点留白。 */
function RtkSection(props: CardSlotProps): ReactNode {
  return createElement("div", { className: "rtkc-page" }, createElement(RtkCard, props));
}

/**
 * 侧栏行的图标适配层（`sidebar.panellist` 的 owner props 是 `{size, active}`）。
 *
 * 只把两位透给 `RtkPanelIcon`，不直接把它挂上槽位：槽位组件的 props 由宿主按槽位类型注入，
 * 多一位少一位都只在运行期看出来，这里显式收窄一次，形状不对时编译期就红。
 */
function PanelIconSlot(props: { readonly size: number; readonly active: boolean }): ReactNode {
  return createElement(RtkPanelIcon, { size: props.size, active: props.active });
}

/** 侧栏读数压缩：百万给 M、千给 k，其余原样；三段早退，不用嵌套三元。 */
function shortTokensOf(saved: number): string {
  if (saved >= 1_000_000) {
    return `${(saved / 1_000_000).toFixed(1)}M`;
  }
  if (saved >= 1000) {
    return `${(saved / 1000).toFixed(1)}k`;
  }
  return String(saved);
}

/** 导航行尾的今日节省量：非交互，只在侧栏展开时显示。 */
function RtkTrailing(props: {
  readonly t: Translate;
  readonly reader: StatsReader | undefined;
  readonly wide: boolean;
}): ReactNode {
  const [saved, setSaved] = useState<number | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const read = async (): Promise<void> => {
      if (props.reader === undefined) {
        return;
      }
      try {
        const overview = await props.reader.overview();
        if (alive) {
          setSaved(overview.today.prefix.savedTokens + overview.today.pipe.savedTokens);
        }
      } catch {
        // 导航尾只是附加信息：读不到就保持上一次的读数或空着。
      }
    };
    void read();
    return () => {
      alive = false;
    };
  }, [props.reader]);
  if (!props.wide || saved === undefined || saved <= 0) {
    return null;
  }
  return createElement("span", { className: "rtkc-navCount" }, shortTokensOf(saved));
}

/** 会话侧栏的 rtk 小节：只读今日概览，不重复 Insights 页的明细。 */
function RtkPanelSection(props: {
  readonly reader: StatsReader | undefined;
  readonly t: Translate;
}): ReactNode {
  const [overview, setOverview] = useState<
    Awaited<ReturnType<StatsReader["overview"]>> | undefined
  >(undefined);
  useEffect(() => {
    let alive = true;
    const read = async (): Promise<void> => {
      if (props.reader === undefined) {
        return;
      }
      try {
        const value = await props.reader.overview();
        if (alive) {
          setOverview(value);
        }
      } catch {
        // 侧栏小节可缺席，读不到就不画。
      }
    };
    void read();
    return () => {
      alive = false;
    };
  }, [props.reader]);
  if (overview === undefined) {
    return null;
  }
  const saved = overview.today.prefix.savedTokens + overview.today.pipe.savedTokens;
  const attempts = overview.today.prefix.attempts + overview.today.pipe.attempts;
  const savedLine = createElement(
    "span",
    null,
    `${props.t("kpiSaved")} `,
    createElement("strong", null, String(saved)),
  );
  const attemptsLine = createElement(
    "span",
    null,
    `${props.t("kpiAttemptsPrefix")} `,
    createElement("strong", null, String(attempts)),
  );
  return createElement("div", { className: "rtkc-panelSection" }, savedLine, attemptsLine);
}

/** 客户端上下文里本模块用到的那几位（方法子集投影：官方的服务类带私有字段，替身满足不了）。 */
interface ClientCtx {
  effect: (run: () => () => void, label: string) => void;
  configForms: { get: (entryId: string) => SettingScope };
  locale: {
    register: (ns: typeof NS, dicts: typeof UI_MESSAGES) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
  slots: {
    inject: (name: string, run: () => () => void) => void;
    register: (slot: Record<string, unknown>, component: unknown) => () => void;
  };
  get?: (name: string, strict?: boolean) => unknown;
}

/** 样式只装一次；拆成独立函数是 apply 的行数上限（129 行里这一段就占十行）。 */
function installStyles(ctx: ClientCtx): void {
  ctx.effect(() => {
    const disposeShared = ensureCardUiCss();
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = CARD_CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
      disposeShared();
    };
  }, "rtk-card: styles");
}

function apply(ctx: ClientCtx): void {
  installStyles(ctx);

  // 本条目的共享表单：条目 id == cordis.patch.yml 里的裸 id `rtk`（settings 命名空间即条目 id），
  // 与 host 侧隐式注册的命名空间同源，故直接复用 NS。表单生命周期归 provider。
  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "rtk-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  const statsRemote = createStatsReader(ctx);

  // 写通道受理结果**原样透传**给卡片（消费在 save()：false → saveRejected 且保留 touched；
  // 这里只补字段级 console.error 供排查，rejection 照旧上抛、统一处理成 saveFailed 文案）。
  const writeFieldOf = async (field: string, value: unknown): Promise<boolean> => {
    try {
      return await scope.set(field, value);
    } catch (error) {
      console.error(`[rtk] set ${field} failed:`, error);
      throw error;
    }
  };
  const unsetField = async (field: string): Promise<boolean> => {
    try {
      return await scope.unset(field);
    } catch (error) {
      console.error(`[rtk] unset ${field} failed:`, error);
      throw error;
    }
  };

  // 卡片的两份 inject 完全同形：`plugins.bundle.config`（插件详情页）与 `settings.section`
  // （设置页一级分区）吃同一批位。写成一处工厂是为了「两处显示同一份配置」这件事没有第二
  // 种实现——注入面各写一份，迟早出现「详情页能改、设置页改不动」这种只差一位的故障。
  const cardInject = (): {
    readonly t: Translate;
    readonly hooks: { readonly card: typeof store };
    readonly set: (field: string, value: unknown) => Promise<boolean>;
    readonly unset: (field: string) => Promise<boolean>;
    readonly statsRemote: StatsReader | undefined;
  } => ({
    t,
    hooks: { card: store },
    set: writeFieldOf,
    unset: unsetField,
    statsRemote,
  });

  ctx.slots.inject("plugins.bundle.config", () =>
    ctx.slots.register(
      {
        name: "plugins.bundle.config",
        // 必须是 bundle 包名：owner 派发时给的是 `entryKey: pkg.name`，按裸条目 id 注册 = 卡片完全不渲染。
        key: BUNDLE_PKG,
        inject: cardInject,
      },
      RtkCard,
    ),
  );

  // 设置页左侧一级分区。`label` 给的是 thunk 而不是字符串：宿主每次读导航行都重新求值，
  // 于是切语言时这一行跟着变，而不需要本插件重新注册。
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => t("navLabel"),
        inject: cardInject,
      },
      RtkSection,
    ),
  );

  // 导航图标：id 必须与上面那条 `settings.section` 的 id 逐字相同，对不上时宿主
  // 一条都不渲染（`settings.section.icon` 的 doc 原文），症状是分区还在、图标一直是默认齿轮。
  ctx.slots.inject("settings.section.icon", () =>
    ctx.slots.register(
      {
        name: "settings.section.icon",
        id: SECTION_ID,
        order: SECTION_ORDER,
      },
      RtkSectionIcon,
    ),
  );

  // ---- 左侧栏一级面板：Insights ----
  //
  // `main` 是 keyed 槽，`key` 由我们定（宿主已占 conversation/plugins/schedule，`rtk` 不撞）；
  // `sidebar.panellist` 是 list 槽，`id` 与 `main` 的 key 必须是同一个值——点侧栏那一行时宿主
  // 拿这个 id 去 `main` 里找入口，两边不同源就是「点了没反应」。
  //
  // 用 `PANEL_ID`/`PANEL_ORDER` 而不是就地写字面量：`lib/insights-page-logic.ts` 是纯逻辑层，
  // 这两个值在那里被测试断言过，组件这边只消费。
  const panelInject = (): { readonly t: Translate; readonly reader: StatsReader | undefined } => ({
    t,
    reader: statsRemote,
  });

  ctx.slots.inject("main", () =>
    ctx.slots.register(
      {
        name: "main",
        key: PANEL_ID,
        locale: NS,
        inject: panelInject,
        // 面板本体与侧栏行共用同一份文案字典；`label` 写在这里会让宿主每次读导航都重新求值，
        // 切语言时跟着变。
      },
      InsightsPage,
    ),
  );

  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: PANEL_ORDER,
        locale: NS,
        label: () => t("panelLabel"),
      },
      PanelIconSlot,
    ),
  );

  ctx.slots.inject("sidebar.panellist.trailing", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist.trailing",
        id: PANEL_ID,
        order: PANEL_ORDER,
        inject: panelInject,
      },
      RtkTrailing,
    ),
  );

  ctx.slots.inject("conversation.session.panel.section", () =>
    ctx.slots.register(
      {
        name: "conversation.session.panel.section",
        id: "rtk-stats",
        order: 100,
        label: () => t("panelLabel"),
        inject: panelInject,
      },
      RtkPanelSection,
    ),
  );
}

export { apply };
