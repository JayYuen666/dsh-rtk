// Insights 页与侧栏入口的图标。
//
// 与设置分区那个图标是**同一份官方标记**（`./rtk-icon.ts` 的 data URI，字节不动），差别只在
// 尺寸与状态位：侧栏行给的是 `sidebar.panellist` 的 owner props（`size` + `active`），没有
// `className` 可言，所以这里单独包一层，而不是把设置分区那个组件借过来用。
//
// 不引官方图标基础库：client bundle 只外置 react / zod / shared，引一个组件库会把整套图标
// 打进包；而我们要的就是这一张位图。
import { createElement } from "react";
import type { ReactNode } from "react";

/** 侧栏行的 owner props（`PropsRuntime<'sidebar.panellist'>` 的两位）。 */
export interface PanelIconProps {
  readonly size: number;
  readonly active: boolean;
}

/**
 * 侧栏里的 rtk 标记。
 *
 * 上色靠 CSS `mask` + `currentColor`（见 client-entry 的 `.rtkc-icon`）：深色主题是浅标记、
 * 浅色主题是深标记，跟宿主导航行同色。颜色写死在组件里会在换主题时留在原地。
 *
 * 这里**没有 `active` 的样式差异**：侧栏行自己会给选中态加背景与字色，图标跟着
 * `currentColor` 一起变就够了。原先那个 `data-rtk-panel-icon` 位没有任何 CSS 消费它，
 * 留着会让下一个人以为选中态有专门的图标配色要维护。
 */
export function RtkPanelIcon(props: PanelIconProps): ReactNode {
  return createElement("span", {
    className: "rtkc-icon",
    style: { width: props.size, height: props.size },
    "aria-hidden": true,
  });
}
