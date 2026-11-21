// 图表挂载器（入口侧）：负责「什么时候去要 ECharts」，不负责「怎么画」。
//
// 为什么要有这一层：`require.async("./client.insights-echarts.js")` 这句必须出现在**入口**
// 产物里——构建期有一道门核对「声明了 chunk 就必须有人引用它」，而宿主也按同一根字面量串
// 算 chunkId。把它藏进一个运行时拼出来的变量里，两道判据都会落空，所以串写死一次。
//
// `require` 不是全局：宿主的工厂函数把它作为参数传进来（`factory: (require) => {…}`）。
// 这里只声明用到的那一个成员，别的一概不碰。
//
// 这一段全是**结构核对**而不是类型断言：chunk 与入口分别构建、分别发布，版本错配时它可能
// 只导出了半个模块。用谓词逐层判形状，错配就退化成「没有图表」，而不是在渲染中途抛。
import type { ChartHandle, ChartSpec } from "./insights-chart-spec.ts";

/** 宿主工厂注入的模块加载器；本文件只用到 `async`。 */
declare const require: {
  readonly async: (specifier: string) => Promise<unknown>;
};

/** 任意函数：先确认可调用，再把它当「参数与返回值都未知」的东西调用。 */
type AnyFunction = (...args: readonly unknown[]) => unknown;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isFunction = (value: unknown): value is AnyFunction => typeof value === "function";

/**
 * chunk 的成品模块里那个 `mountChart`。
 *
 * **不要求它有某个签名**：入口与 chunk 各自独立构建，chunk 的参数类型对入口来说是别的构建
 * 里的类型。这里只确认「可调用」，结果形状由调用点核对——写一个跨产物的宽窄断言会假装
 * 我们知道得更多。返回 `undefined` 表示版本错配（chunk 在那、导出面不认识）。
 */
function mountOf(loaded: unknown): AnyFunction | undefined {
  const exported = isObject(loaded) ? loaded["chartModule"] : undefined;
  const mount = isObject(exported) ? exported["mountChart"] : undefined;
  return isFunction(mount) ? mount : undefined;
}

/**
 * 加载一次的缓存。
 *
 * **只缓存成功**。第一版连失败也缓存，于是一条 404 会让图表在整个会话里再也画不出来——而
 * 它可能只是那次请求抢在宿主模块表就绪之前，或者用户重载页面之后 chunk 已经在了。失败后
 * 清掉缓存，下一次挂载再试一趟；每趟失败都留一行诊断（否则「图一直不出来」没有任何线索）。
 */
let loading: Promise<AnyFunction | undefined> | undefined;
let loaded = false;

/**
 * 真去拉一次 chunk。
 *
 * 失败返回 `undefined` 而不是抛：图表是附加信息，缺了它页面照常可读。两种失败都走这条路——
 * `require.async` reject（宿主按 404 供，例如 package.json 的 `files` 漏了 chunk），以及
 * chunk 到了却没导出 `mountChart`（入口与 chunk 版本错配）。
 */
async function loadOnce(): Promise<AnyFunction | undefined> {
  let mount: AnyFunction | undefined;
  try {
    // 这串必须写成**字面量**：构建期与宿主比的都是字面量原文，模板串插值不算引用。
    const required: unknown = await require.async("./client.insights-echarts.js");
    mount = mountOf(required);
  } catch (error) {
    // 失败不缓存（见 `loading` 的注释），但要留一句：图表不出来时这是唯一能解释原因的记录。
    console.warn(
      `[rtk] chart chunk did not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (mount === undefined) {
    // chunk 到了、导出面却不认识：入口与 chunk 版本错配。这一条也该说出来，它和 404 的
    // 修法完全不同（一个是打包漏件，一个是重装）。
    console.warn("[rtk] chart chunk loaded but does not export mountChart (version mismatch?)");
  }
  return mount;
}

/** 取图表模块的挂载函数；成功之后只发一趟请求，失败则下次重试。 */
export async function loadChartModule(): Promise<AnyFunction | undefined> {
  loading ??= loadOnce();
  const mount = await loading;
  if (mount === undefined) {
    // 失败不留缓存：把这一趟清掉，下一次挂载重新试。
    loading = undefined;
  } else {
    loaded = true;
  }
  return mount;
}

/** 图表模块是否已经成功加载过（`false` 时下一次挂载还会再请求一趟）。 */
export const chartModuleLoaded = (): boolean => loaded;

/** 画好之后那个句柄的最小形状：`update`、`resize` 与 `dispose` 都得可调用。 */
const isChartHandle = (value: unknown): value is ChartHandle =>
  isObject(value) &&
  isFunction(value["update"]) &&
  isFunction(value["resize"]) &&
  isFunction(value["dispose"]);

/** 半张句柄：形状不对、但已经把 canvas 建出来的返回值。 */
const isDisposable = (value: unknown): value is { readonly dispose: AnyFunction } =>
  isObject(value) && isFunction(value["dispose"]);

/**
 * 收掉一个不合格的挂载结果。
 *
 * 只认 `dispose` 这一位：有它就能把已经建出来的东西还回去，缺 `update` 不影响回收。
 * 回收自己失败时保持安静——走到这里说明 chunk 的约定已经破了，页面该照常。
 * @param drawn - `mount` 的返回值（形状未核）
 */
function releaseHalfHandle(drawn: unknown): void {
  if (!isDisposable(drawn)) {
    return;
  }
  try {
    drawn.dispose();
  } catch {
    // 回收失败不该比泄漏更响。
  }
}

/**
 * 把一个容器变成图表。
 *
 * 返回 `undefined` 表示这次没画成，调用方应保留占位（表格与数字本身不依赖它）。
 * 画完一定要在卸载时 `dispose`：ECharts 会往容器里塞 canvas。
 *
 * **形状不对时也得收**：chunk 与入口各自构建，版本错配时 `mount` 可能返回一个没有 `update`
 * 的半个句柄。那种情况下 canvas **已经建出来了**，直接 `return undefined`
 * 会把它永远留在页面上（每切一次页签多一份）。所以先尽力调它的 `dispose`，再判定失败。
 * @param container - 图表容器
 * @param spec - 要画的规格
 * @returns 句柄；没画成时 `undefined`
 */
export async function mountChartIn(
  container: HTMLElement,
  spec: ChartSpec,
): Promise<ChartHandle | undefined> {
  const mount = await loadChartModule();
  let drawn: unknown;
  try {
    drawn = mount === undefined ? undefined : mount(container, spec);
  } catch {
    // 画图失败与加载失败同一个口径：不让它把整页带走。
    drawn = undefined;
  }
  const usable = isChartHandle(drawn) ? drawn : undefined;
  if (usable === undefined) {
    releaseHalfHandle(drawn);
  }
  return usable;
}

/** 主题相关的取色：从容器的计算样式里读，chunk 不认识本包的 CSS 变量。 */
export interface ChartPalette {
  readonly colors: readonly [string, string];
  readonly textColor: string;
  readonly gridColor: string;
  readonly tooltipBg: string;
  readonly tooltipText: string;
}

/** CSS 没定义时的兜底色（与卡片样式里的两支同调）。 */
const FALLBACK_PALETTE: ChartPalette = {
  colors: ["#3b6ef6", "#e08a2e"],
  textColor: "#667085",
  gridColor: "#e4e7ec",
  tooltipBg: "rgba(24,26,32,.94)",
  tooltipText: "#f2f4f7",
};

/** 从容器读主题色；读不到就给兜底色，绝不抛。 */
export function paletteOf(container: HTMLElement): ChartPalette {
  const style = globalThis.getComputedStyle(container);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  return {
    colors: [
      read("--rtkc-chart-bar", FALLBACK_PALETTE.colors[0]),
      read("--rtkc-chart-line", FALLBACK_PALETTE.colors[1]),
    ],
    textColor: read("--rtkc-chart-text", FALLBACK_PALETTE.textColor),
    gridColor: read("--rtkc-chart-grid", FALLBACK_PALETTE.gridColor),
    tooltipBg: read("--rtkc-chart-tooltip-bg", FALLBACK_PALETTE.tooltipBg),
    tooltipText: read("--rtkc-chart-tooltip-text", FALLBACK_PALETTE.tooltipText),
  };
}
