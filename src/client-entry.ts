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
  CardForm,
  ListField,
  NumberField,
  SaveBar,
  Section,
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
  enabledHintKeyOf,
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
import { PANEL_ID, PANEL_ORDER, cardKpiRowsOf } from "../lib/insights-page-logic.ts";
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
  ".rtkc-hint{font-size:12px;line-height:1.7;margin:6px 0;padding:6px 8px;border-radius:6px;background:rgba(224,166,58,.12);box-shadow:inset 0 0 0 1px rgba(224,166,58,.28);color:var(--dsw-alias-label-primary,inherit)}",
  ".rtkc-ready{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,inherit);margin:6px 0}",
  ".rtkc-actions{margin-top:8px}",
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
  ":root{--rtkc-chart-bar:#3b6ef6;--rtkc-chart-line:#e08a2e;--rtkc-chart-text:#667085;--rtkc-chart-grid:#e4e7ec;--rtkc-ok:#3ec98a;--rtkc-skip:#e0a63a;--rtkc-fail:#e5645a;--rtkc-gap:12px}",
  // 四个表面变量必须挂在 **body** 上而不是 :root：宿主把 `--dsw-alias-*` 全定义在 body
  // （真机 `getComputedStyle(document.body).getPropertyValue("--dsw-alias-card-fill")` 有值，
  // `document.documentElement` 上是空串）。挂在 :root 时 `var()` 在 html 上求值就落到 fallback，
  // 于是主题换了、卡片底纹却一直是写死的那个 #1c1d20。
  "body{--rtkc-surface:var(--dsw-alias-card-fill,#1c1d20);--rtkc-tile:var(--dsw-alias-card-tile-fill,rgba(255,255,255,.06));--rtkc-line:var(--dsw-alias-border-l2,rgba(127,127,127,.22));--rtkc-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));--rtkc-raised:var(--dsw-alias-bg-layer-2,#2c2c2e)}",
  // 图表配色走 CSS 变量：ECharts 在 chunk 里，读不到本包的样式表，只能由入口在挂载时
  // 用 getComputedStyle 从这里取（见 `./insights-chart.ts` 的 paletteOf）。
  //
  // 轴文字与网格线**必须分主题**：上面 `:root` 那两个是浅色主题的取值（深灰字 + 浅灰线），
  // 直接用在深色卡片上就是「深灰字压在 #212123 上」，对比度不足 4.5:1，真机上看不清刻度。
  // 这样写在 body 上而不是只在 :root 改一次，是因为宿主的主题切换只改 body 的属性、不重渲染
  // 本组件——`useChart` 里那条 MutationObserver 观察到属性变化后，会重新读这里取色再 update。
  "body[data-ds-dark-theme]{--rtkc-chart-text:#9aa3b2;--rtkc-chart-grid:#ffffff1f}",
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
  ".rtkc-page[data-panel]{flex:1 1 auto;min-height:0;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
  ".rtkc-page-head{display:flex;align-items:center;justify-content:space-between;gap:12px}",
  ".rtkc-page-title{display:flex;align-items:center;gap:8px;font-size:1.05em;font-weight:600;margin:0}",
  // 刷新按钮：hover 才显出边框与底色。常驻边框会让页头看起来比页身还重。
  ".rtkc-refresh{font:inherit;font-size:12px;padding:4px 12px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;transition:background .12s,border-color .12s,color .12s}",
  ".rtkc-refresh:hover:not(:disabled){background:var(--rtkc-hover);border-color:var(--rtkc-line);color:var(--dsw-alias-label-primary,inherit)}",
  ".rtkc-refresh:disabled{opacity:.55;cursor:default}",
  // 控件区：上行形态（换页签换的是**整种数据**）、下行时间（换的是同一种数据的一段）。
  // 两行之间留 12px、组内 8px：页签与时间栏不是同一级控件，挤成一行时用户会以为切页签
  // 也会换时间范围（真机反馈原话就是「时间作为筛选条件需单独设计位置」）。
  ".rtkc-page-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px}",
  ".rtkc-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
  ".rtkc-tabs{display:inline-flex;gap:2px;padding:3px;border-radius:9px;background:var(--rtkc-hover);border:1px solid var(--rtkc-line)}",
  ".rtkc-tab{font:inherit;font-size:12px;line-height:1.5;padding:5px 18px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;transition:background .12s,color .12s}",
  ".rtkc-tab:hover{color:var(--dsw-alias-label-primary,inherit);background:rgba(127,127,127,.12)}",
  '.rtkc-tab[data-active="true"]{background:var(--rtkc-raised);color:var(--dsw-alias-label-primary,inherit);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.28)}',
  '.rtkc-tab[data-active="true"]:hover{background:var(--rtkc-raised)}',
  ".rtkc-tab:focus-visible{outline:2px solid var(--rtkc-chart-bar);outline-offset:1px}",
  // 时间栏：一组「标签 + 两个下拉」，自己一块浅底，与页签在视觉上分成两件不同的事。
  // 标签与下拉之间 8px、下拉之间 8px，两侧内边距不对称（左 10 右 6）——右边紧贴下拉的
  // 圆角，留同样的 10px 会让整块看起来右侧空了一块。
  ".rtkc-timebar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 6px 5px 10px;border-radius:9px;background:var(--rtkc-tile);border:1px solid var(--rtkc-line)}",
  ".rtkc-timebar-label{font-size:11px;line-height:1.5;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,inherit);opacity:.75;white-space:nowrap}",
  ".rtkc-select{font:inherit;font-size:12px;line-height:1.5;min-height:28px;padding:4px 8px;border-radius:6px;border:1px solid var(--rtkc-line);background:var(--rtkc-surface);color:var(--dsw-alias-label-primary,inherit);cursor:pointer;transition:border-color .12s,background .12s}",
  ".rtkc-select:hover{border-color:var(--rtkc-chart-bar);background:var(--rtkc-hover)}",
  ".rtkc-select:focus-visible{outline:2px solid var(--rtkc-chart-bar);outline-offset:1px}",
  // 每一块都是卡片：深色主题下只靠间距分块，信息一多就糊成一片。
  ".rtkc-card{padding:14px 16px;border-radius:12px;border:1px solid var(--rtkc-line);background:var(--rtkc-surface)}",
  ".rtkc-block{margin:0}",
  ".rtkc-subtitle{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit);margin:0 0 12px}",
  // KPI：数字大、标签小，卡片之间 10px。hover 时描边亮一档，让人知道这块是可以停下来看的。
  ".rtkc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px}",
  ".rtkc-kpi{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:9px;background:var(--rtkc-tile);border:1px solid var(--rtkc-line);transition:border-color .12s,transform .12s}",
  ".rtkc-kpi:hover{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.42))}",
  ".rtkc-kpi-label{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}",
  ".rtkc-kpi-value{font-size:17px;line-height:1.25;font-weight:600;font-variant-numeric:tabular-nums}",
  // ---- 数字滚动（只在前三格次数上播一次）----
  // 纯 CSS：注册一个整数型自定义属性让浏览器能对它插值，再用 `counter()` 把它画成文本。
  // 没有 JS 定时器、没有逐帧 setState —— 动画不占主线程。
  '@property --rtkc-count-target{syntax:"<integer>";initial-value:0;inherits:false}',
  // 三条一起才成立：
  // ① `font-size:0` 让元素自身文本不可见（否则浏览器画的是最终值，动画看起来没发生）；
  // ② `counter-reset` 把计数器绑到那个自定义属性上，`::after` 用 `counter()` 画出来；
  // ③ `content: counter(x) / ""` —— 斜杠后是替代文本，写空串表示「它是装饰、别再念一遍」，
  //    否则读屏会把同一个数字念两次。
  ".rtkc-kpi-value[data-count]{font-size:0;animation:rtkc-count-up 620ms cubic-bezier(.22,.61,.36,1) forwards;counter-reset:rtkc-count var(--rtkc-count-target)}",
  '.rtkc-kpi-value[data-count]::after{content:counter(rtkc-count) / "";font-size:17px;font-variant-numeric:tabular-nums}',
  "@keyframes rtkc-count-up{from{--rtkc-count-target:0}}",
  // 减少动效时**不能删掉动画**：起手的 0 是靠 keyframes 给的，删了动画就只剩
  // `initial-value:0`，数字会永远停在 0。把时长压到 1ms 等价于「直接给终值」。
  "@media (prefers-reduced-motion:reduce){.rtkc-kpi-value[data-count]{animation-duration:1ms}}",
  ".rtkc-chart{width:100%;height:220px}",
  // 「退成柱子」那句说明（`chartSparseNote`）：它原来是灰色小字 `rtkc-note`，和页脚、空窗
  // 提示同色同号，于是「比率去哪了」这个真问题被读成「没画出来」。这里给它一条独立的琥珀色
  // 提示条（复用 `.rtkc-hint` 的观感），左侧再借折线色点一下「本来这里会有一条线」。
  ".rtkc-sparse{font-size:12px;line-height:1.65;margin:8px 0 0;padding:7px 9px;border-radius:7px;border-left:3px solid var(--rtkc-chart-line);background:rgba(224,166,58,.1);color:var(--dsw-alias-label-primary,inherit)}",
  // 卡片小图：**不能矮于 120px**。ECharts 的 `grid` 上下各留 28/24px 给刻度与轴标签，
  // 64px 高时绘图区只剩约 10px——真机上表现为「一条横线 + 两个看不见的柱」，
  // 看着像图坏了。162px 给柱子留出约 80px，两根柱子的高度差才读得出来。
  ".rtkc-card-chart{width:100%;height:162px;margin:10px 0 2px}",
  // 语义色点：成功绿 / 跳过黄 / 失败红。语义色在浅色主题下压暗一档（见下方覆盖）。
  ".rtkc-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--dsw-alias-label-secondary,#8a8f98)}",
  '.rtkc-dot[data-tone="ok"]{background:var(--rtkc-ok)}',
  '.rtkc-dot[data-tone="skip"]{background:var(--rtkc-skip)}',
  '.rtkc-dot[data-tone="fail"]{background:var(--rtkc-fail)}',
  // 「最近一次」整行按结局染色：7px 的圆点在一屏数字里太轻，一眼扫过去分不出上一次是成功
  // 还是跳过。左边一条 2px 竖线 + 一层极淡底色，颜色与文字同时在场（不靠颜色单独表意——
  // 色弱用户读到的仍是那行「已跳过 · git status · too-small」）。
  ".rtkc-recent{display:flex;align-items:center;margin:0;padding:8px 10px;border-radius:8px;border-left:2px solid transparent;background:var(--rtkc-tile)}",
  '.rtkc-recent[data-tone="ok"]{border-left-color:var(--rtkc-ok);background:rgba(62,201,138,.09)}',
  '.rtkc-recent[data-tone="skip"]{border-left-color:var(--rtkc-skip);background:rgba(224,166,58,.09)}',
  '.rtkc-recent[data-tone="fail"]{border-left-color:var(--rtkc-fail);background:rgba(229,100,90,.1)}',
  // 表格：表头小一号大写、行 hover 提亮、首列吃余宽、数值列带量条。
  //
  // 表头**必须有实底**：它带 `position:sticky`，透明底时行会从字后面穿过去（深色主题下
  // 两行数字叠在一起）。底色用「半透明内层叠在不透明的卡片底上」——单用半透明层在浅色
  // 主题里几乎看不出，单用卡片底又和表体连成一片；叠出来的这一条在深浅两边都比表体深半档。
  // `overscroll-behavior:contain`：横向滚到底时不要把手势继续交给外层页面（否则表格滚完
  // 还在滚的同时页面也在滚，两件事叠在一起）。
  ".rtkc-tables{display:flex;flex-direction:column;gap:var(--rtkc-gap)}",
  ".rtkc-table-wrap{overflow:auto;margin:0 -10px;overscroll-behavior:contain}",
  ".rtkc-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}",
  ".rtkc-table thead th{position:sticky;top:0;z-index:2;padding:7px 10px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,inherit);text-align:left;border-bottom:1px solid var(--rtkc-line);background:linear-gradient(var(--rtkc-tile),var(--rtkc-tile)),var(--rtkc-surface);white-space:nowrap}",
  ".rtkc-table tbody td{padding:9px 10px;border-bottom:1px solid var(--rtkc-line);vertical-align:middle;transition:background .1s}",
  // 斑马纹只给偶数行且比 hover 更淡：它是扫行时的辅助，hover 才是「我指着这一行」的反馈。
  ".rtkc-table tbody tr:nth-child(even) td{background:rgba(127,127,127,.032)}",
  ".rtkc-table tbody tr:last-child td{border-bottom:0}",
  ".rtkc-table tbody tr:hover td{background:var(--rtkc-hover)}",
  // 首列是「身份列」（命令 / 目录 / 原因），比数字重一档。宽度用 `width:1px + nowrap` 的
  // 老办法「收到内容宽」：写在最后一列上吃余宽。**不能**给首列 `width:100%`——那会让它自己
  // 变成整表的定宽列，表格永远不产生横向溢出，sticky 首列于是永远没有可粘的位移（真机实测：
  // 内层宽度一旦绑死到 100%，`scrollWidth === clientWidth`，`position:sticky` 形同虚设）。
  ".rtkc-table thead th:first-child,.rtkc-table tbody td:first-child{width:1px;white-space:nowrap}",
  ".rtkc-table thead th:last-child,.rtkc-table tbody td:last-child{width:100%}",
  ".rtkc-table tbody td:first-child{color:var(--dsw-alias-label-primary,inherit);font-weight:500}",
  // 首列冻在左边：横滚时「这是哪一行」不该跟着数字一起滚走。
  // 必须**不透明底**（sticky 元素的半透明底会让后面的字透过来），所以这里同样用
  // 「半透明内层叠在不透明卡片底上」；右侧 1px 阴影是冻结面板的分界，粘住时才看得见。
  // 角格（表头 × 首列）的 z-index 要压过两者：它同时满足两个 sticky，落单的那个会被盖住。
  ".rtkc-table thead th:first-child,.rtkc-table tbody td:first-child{position:sticky;left:0;background:linear-gradient(var(--rtkc-tile),var(--rtkc-tile)),var(--rtkc-surface);box-shadow:inset -1px 0 0 var(--rtkc-line)}",
  ".rtkc-table thead th:first-child{z-index:3}",
  ".rtkc-table tbody td:first-child{z-index:1}",
  ".rtkc-num{text-align:right!important;white-space:nowrap}",
  ".rtkc-text{text-align:left}",
  // 数值格：细量条 + 数字**同一行**并排。量条压在数字上方时行高会被撑到 60px。
  ".rtkc-cell-metric{display:inline-flex;align-items:center;gap:7px;justify-content:flex-end;width:100%}",
  ".rtkc-meter{display:block;width:46px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.28));overflow:hidden;flex:none}",
  ".rtkc-meter-fill{display:block;height:100%;border-radius:2px;background:var(--rtkc-chart-bar);transition:width .2s ease-out}",
  ".rtkc-cell-value{font-variant-numeric:tabular-nums}",
  // 建议：卡片式，左边框按严重度换色（warn 用跳过黄，不用失败红——它是建议，不是错误）。
  ".rtkc-suggestion{font-size:12px;line-height:1.6;margin:6px 0;padding:10px 12px;border-radius:9px;border-left:3px solid var(--rtkc-chart-bar);background:var(--rtkc-tile);transition:background .12s}",
  ".rtkc-suggestion:hover{background:var(--rtkc-hover)}",
  ".rtkc-suggestion-detail{display:block;margin-top:3px;color:var(--dsw-alias-label-secondary,inherit);opacity:.85}",
  ".rtkc-warn{border-left-color:var(--rtkc-skip)!important}",
  ".rtkc-empty{text-align:center;padding:28px 16px;color:var(--dsw-alias-label-secondary,inherit)}",
  ".rtkc-footnote{margin:0;color:var(--dsw-alias-label-secondary,inherit);opacity:.75;font-size:11px}",
  // 浅色主题下的语义色：深色值在浅底上偏荧光，压暗一档才看得清又不刺眼。
  // 判据必须跟着宿主的 `body[data-ds-dark-theme]`（真机 body 上只有这一个属性，
  // 没有 `data-theme`），写成 `[data-theme="light"]` 会永不匹配、浅色下仍是深色那套。
  "body:not([data-ds-dark-theme]){--rtkc-ok:#12855a;--rtkc-skip:#a6701a;--rtkc-fail:#c0433a}",
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
function RtkHint(props: { t: Translate; status: StatsStatus | undefined }): ReactNode {
  const { t, status } = props;
  const hint = hintOf(status);
  if (hint === undefined) {
    return null;
  }
  // 三支各自一句话，且就绪支用中性样式：它要说的是「已装、版本够」，
  // 用警告底色会让正常状态看起来像出了问题（那是 missing/too-old 才该有的样子）。
  let node: ReactNode;
  if (hint.kind === "missing") {
    node = createElement("p", { className: "rtkc-hint" }, t("rtkMissingHint"));
  } else if (hint.kind === "too-old") {
    node = createElement(
      "p",
      { className: "rtkc-hint" },
      t("rtkTooOldHint", { version: hint.version, minimum: MIN_RTK_VERSION }),
    );
  } else {
    node = createElement(
      "p",
      { className: "rtkc-ready" },
      t("rtkReadyHint", { version: hint.version, path: hint.path }),
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
            bar: {
              name: t("kpiSaved"),
              values: [overview.today.prefix.savedTokens, overview.today.pipe.savedTokens],
            },
            colors: ["", ""],
            textColor: "",
            gridColor: "",
            // 这张图只有 132px 高（`.rtkc-card-chart`）：走紧凑档，刻线降到三条。
            compact: true,
          },
    [overview, t],
  );
  const { containerRef } = useChart(spec);
  // 两形态都还没省下任何东西时不画空图：两根零高度的柱子看起来像「画坏了」。
  const empty =
    overview === undefined ||
    (overview.today.prefix.savedTokens === 0 && overview.today.pipe.savedTokens === 0);
  return empty ? null : createElement("div", { className: "rtkc-card-chart", ref: containerRef });
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
            className: "rtkc-actions",
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
    { title: t("statusSection") },
    createElement(StatsSummaryLine, { t, overview }),
    // 两柱图只吃 overview 已经带回来的数：卡上多一条请求就是每次开设置都多付一次扫描。
    createElement(CardChart, { t, overview }),
    createElement("p", { className: "rtkc-note" }, t("statsNote")),
    reset,
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
    toggleField({
      label: t("enabledLabel"),
      hint: t(enabledHintKeyOf(view.forms)),
      field: "enabled",
      checked: view.enabled,
      editable: writable,
      onChange: (next) => {
        setField("enabled", next);
      },
    }),
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

/** 三个字节/比例阈值 + 提示开关 + 宿主环境变量。 */
function cardNumberFields(props: FieldSectionProps): ReactNode[] {
  const { t, view, writable, setField, resetToken, reportInvalid } = props;
  return [
    numberField({
      t,
      field: "minBytes",
      label: t("minBytesLabel"),
      hint: t("minBytesHint"),
      value: view.minBytes,
      min: 0,
      max: 1_048_576,
      step: 1,
      editable: writable,
      resetToken,
      onInvalidChange: (invalid) => {
        reportInvalid("minBytes", invalid);
      },
      onChange: (next) => {
        setField("minBytes", next);
      },
    }),
    numberField({
      t,
      field: "minGainRatio",
      label: t("minGainLabel"),
      hint: t("minGainHint"),
      value: view.minGainRatio,
      min: 0,
      max: 1,
      step: 0.01,
      editable: writable,
      resetToken,
      onInvalidChange: (invalid) => {
        reportInvalid("minGainRatio", invalid);
      },
      onChange: (next) => {
        setField("minGainRatio", next);
      },
    }),
    numberField({
      t,
      field: "stdoutCapBytes",
      label: t("stdoutCapLabel"),
      hint: t("stdoutCapHint"),
      value: view.stdoutCapBytes,
      min: 1,
      max: 10_485_760,
      step: 1,
      editable: writable,
      resetToken,
      onInvalidChange: (invalid) => {
        reportInvalid("stdoutCapBytes", invalid);
      },
      onChange: (next) => {
        setField("stdoutCapBytes", next);
      },
    }),
    // 窗口那两位排在一起（头 / 尾），与它们在上游 `cap` method 里的相邻关系一致：
    // 分开摆会让「这两个数是同一件事的两半」读不出来。
    numberField({
      t,
      field: "windowHeadLines",
      label: t("windowHeadLabel"),
      hint: t("windowHeadHint"),
      value: view.windowHeadLines,
      min: 0,
      max: 5000,
      step: 1,
      editable: writable,
      resetToken,
      onInvalidChange: (invalid) => {
        reportInvalid("windowHeadLines", invalid);
      },
      onChange: (next) => {
        setField("windowHeadLines", next);
      },
    }),
    numberField({
      t,
      field: "windowTailLines",
      label: t("windowTailLabel"),
      hint: t("windowTailHint"),
      value: view.windowTailLines,
      min: 0,
      max: 5000,
      step: 1,
      editable: writable,
      resetToken,
      onInvalidChange: (invalid) => {
        reportInvalid("windowTailLines", invalid);
      },
      onChange: (next) => {
        setField("windowTailLines", next);
      },
    }),
    toggleField({
      label: t("warnHintLabel"),
      hint: t("warnHintHint"),
      field: "warnHint",
      checked: view.warnHint,
      editable: writable,
      onChange: (next) => {
        setField("warnHint", next);
      },
    }),
    textField({
      label: t("hostEnvLabel"),
      hint: t("hostEnvHint"),
      field: "rewriteHostEnv",
      value: view.rewriteHostEnv,
      editable: writable,
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
  readonly resetStats: () => Promise<void>;
} {
  const [overview, setOverview] = useState<StatsOverview | undefined>(undefined);
  const [status, setStatus] = useState<StatsStatus | undefined>(undefined);
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
        setOverview(undefined);
      }
      // 状态与统计各读各的：一条失败不该把另一条也抹掉（统计读面缺席时压缩照常，
      // 而 rtk 装没装正是用户最需要看到的那一句）。
      try {
        setStatus(await reader.status());
      } catch {
        setStatus(undefined);
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

  return { overview, status, resetStats };
}

function RtkCard(props: CardSlotProps): ReactNode {
  const snap = props.useCard((state) => state);
  const writable = snap.status === "ready" && snap.writable;
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { statsRemote: reader, t } = props;
  const { overview, status, resetStats } = useStatsRefresh(reader);
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

  return createElement(
    CardForm,
    null,
    createElement("h2", null, t("cardTitle")),
    // 引导行在说明之前：rtk 不在 PATH 时下面所有开关都不会有效果，先说这件事。
    createElement(RtkHint, { t, status }),
    createElement("p", { className: "rtkc-note" }, t("saveHint")),
    // 直接把 resetStats 交下去：确认弹窗要等它真的清完才关，包一层 void 就丢了那个 promise。
    createElement(StatsSection, { t, reader, overview, onReset: resetStats }),
    createElement(
      Section,
      { title: t("switchSection") },
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

function apply(ctx: ClientCtx): void {
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
}

export { apply };
