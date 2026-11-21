// 图表容器的 React 绑定：卡片上的两柱图与 Insights 页的组合图共用这一段。
//
// 两处都要的东西只有三件——一个 ref 回调、一次挂载/更新、卸载时 dispose。写两份的后果不是
// 体积，而是**只有一份会跟着 ECharts 的生命周期改**：漏 dispose 的那一份会往 window 上多挂
// 一个 resize 监听，而这只在切换页面许多次之后才看得出来。
//
// chunk 是异步来的（第一次真要画图才请求 `client.insights-echarts.js`），所以挂载要 await；
// 期间容器是空的，但那一段只有几十毫秒，不做骨架屏。
//
// 这个文件里有两处**并发**要盯住，两处都是 await 之后世界可能已经变了：
//
//   1. 两次 spec 变更在 chunk 回来之前接连发生 → 两个 effect 都会走到「还没有 handle」那一支，
//      于是各自 `mountChartIn`。ECharts 对同一个容器二次 `init` 会**返回已有实例**，两个包装
//      句柄指向同一张 canvas；先回来的那个若被判定「已卸载」并 `dispose()`，被销毁的是另一个
//      刚拿到的实例（页面上表现为图突然空白）。所以「谁来挂」只能有一个，用共享的 in-flight
//      promise 收敛，后到的只负责 update。
//   2. 卸载发生在 await 期间 → 落地前必须再看一眼 `disposed`，否则画好的图挂在一个已经不在
//      文档里的节点上，并且永远拿不到 dispose（canvas 与 resize 监听都留在那儿）。
//
// 主题切换同理：`paletteOf` 读的是容器上的 CSS 变量，而宿主切主题只改 `body` 的属性、不重新
// 渲染本组件。只依赖 `spec` 的 effect 察觉不到这件事，于是切一次主题图表就留着上一套配色。
import { useCallback, useEffect, useRef, useState } from "react";

import type { ChartHandle, ChartSpec } from "./insights-chart-spec.ts";
import { mountChartIn, paletteOf } from "./insights-chart.ts";

/** 一个容器上的图：已经挂上的句柄、正在挂的那一趟、以及「这个容器还算不算数」。 */
interface ChartState {
  handle: ChartHandle | undefined;
  /**
   * 这个句柄是挂在哪个容器上的。
   *
   * 少了这一位就有一个只在「容器条件渲染」时才现形的坏法：句柄还在，但它那张 canvas 所属的
   * 节点已经被 React 换掉或摘掉了；此后的 `update` 全都打在一个不在文档里的节点上——图上什么
   * 都不变，而代码一路正常。所以更新之前先核对节点身份。
   */
  node: HTMLElement | undefined;
  /** 进行中的挂载。多处同时要图时共用它，第二个调用者不再发第二趟。 */
  pending: Promise<ChartHandle | undefined> | undefined;
  /** 容器已经作废（组件卸载或 ref 换节点）：await 回来时用它决定要不要立刻拆掉。 */
  disposed: boolean;
  /** 还没挂上时最近一次要画的规格：让挂上那一刻直接用最新的一份，而不是排队时的那份。 */
  latest: ChartSpec | undefined;
}

const freshState = (disposed: boolean): ChartState => ({
  handle: undefined,
  node: undefined,
  pending: undefined,
  disposed,
  latest: undefined,
});

// 用两个取值函数读这两个字段，而不是直接读 `state.handle` / `state.disposed`：
// 函数体里在 await **之前**判过「还没有 handle」，直接读的话类型会一路收窄成 never，
// 于是 await 之后那句 `state.handle?.update()` 被当成不可达——而它恰恰是并发时唯一
// 要走到的那一条。这三行不是抽象层的装饰，是让类型别骗人的手段。
const handleOf = (state: ChartState): ChartHandle | undefined => state.handle;
const disposedOf = (state: ChartState): boolean => state.disposed;
const pendingOf = (state: ChartState): Promise<ChartHandle | undefined> | undefined =>
  state.pending;

/**
 * 把主题色叠进规格。
 *
 * `colors` / `textColor` / `gridColor` 由调用方留空（它拿不到容器的计算样式），所以**每一条**
 * 下沉到 ECharts 的路径都要先过这一步。只在首次挂载时叠、更新时把原规格原样递下去，表现是
 * 切一次页签图表就从本包配色跳回 ECharts 自带调色板——实测就是这样丢掉线色的。
 * @param node - 图表容器（取色从这里读）
 * @param spec - 调用方给的规格
 * @returns 叠好主题色的规格
 */
function themedOf(node: HTMLElement, spec: ChartSpec): ChartSpec {
  const palette = paletteOf(node);
  return {
    ...spec,
    colors: palette.colors,
    textColor: palette.textColor,
    gridColor: palette.gridColor,
    tooltipBg: palette.tooltipBg,
    tooltipText: palette.tooltipText,
  };
}

/**
 * 已经有图就地更新色与数据；没图就把新规格记下来，等挂上那一刻用最新的一份。
 *
 * `node` 必须是**画这张图的那个容器**：换了节点就等于换了画布，往旧句柄上 update 只会让
 * 屏幕停在上一帧。所以节点对不上时按「还没有图」处理——记下最新规格，等新容器挂上再用。
 * @param state - 这个容器上的图状态
 * @param node - 本次要画的容器
 * @param spec - 要画的规格
 */
function updateChart(state: ChartState, node: HTMLElement, spec: ChartSpec): void {
  const handle = handleOf(state);
  if (handle === undefined || state.node !== node) {
    state.latest = spec;
    return;
  }
  handle.update(spec);
}

/**
 * 把一张图挂到调用方给的容器上（或就地更新）。
 *
 * 三条规则，各自堵一种坏法：
 *   · 已经有 handle → 只 update，绝不重复 mount；
 *   · 正在挂 → 搭同一趟，回来后只 update（不接管、不 dispose）；
 *   · 落地时容器已作废 → 立刻 dispose，把 canvas 与监听一起还回去。
 *
 * 「谁接管」由 `state.pending === pending` 判：只有**建出这一趟**的调用会把它清掉，
 * 后到的调用看到 `pending` 已经没了，就只更新数据、绝不去 dispose。
 * @param node - 图表容器
 * @param state - 这个容器上的图状态（跨 effect 共享）
 * @param spec - 本次要画的规格
 * @param report - 没画成时回报给组件
 */
async function attachChart(
  node: HTMLElement,
  state: ChartState,
  spec: ChartSpec,
  report: (failed: boolean) => void,
): Promise<void> {
  if (disposedOf(state)) {
    return;
  }
  const themed = themedOf(node, spec);
  if (handleOf(state) !== undefined && state.node === node) {
    updateChart(state, node, themed);
    return;
  }
  state.pending ??= mountChartIn(node, themed);
  const pending = pendingOf(state);
  const mounted = await pending;
  if (pendingOf(state) !== pending) {
    // 这一趟不是创建者（或已经被别人收尾）：只把最新数据递进去，不接管句柄。
    updateChart(state, node, themed);
    return;
  }
  state.pending = undefined;
  if (disposedOf(state)) {
    // await 期间容器没了：把刚画好的图拆掉，否则 canvas 与 resize 监听永远留在页面上。
    mounted?.dispose();
    return;
  }
  state.handle = mounted;
  state.node = node;
  // 挂上之前又来过一次 spec 变更：那一刻没有 handle，`updateChart` 只把它记进了 `latest`。
  // 现在有了句柄，补一次更新——否则图上画的是排队那一刻的数据，与页面上其它数字不一致。
  const { latest } = state;
  if (latest !== undefined && latest !== themed) {
    updateChart(state, node, latest);
  }
  state.latest = undefined;
  report(mounted === undefined);
}

/**
 * 把一张图挂到调用方给的容器上。
 *
 * 返回的 `containerRef` 要交给 React 的 `ref`（**不是** `useRef` 的 `.current`）：容器是在
 * 渲染之后才存在的，`useEffect` 那一跑必须读得到它。
 * @param spec - 要画的图；`undefined` 表示这一屏暂时没有图
 * @returns 容器 ref 与「这次没画成」的标记
 */
export function useChart(spec: ChartSpec | undefined): {
  readonly containerRef: (node: HTMLElement | null) => void;
  readonly failed: boolean;
} {
  const nodeRef = useRef<HTMLElement | null>(null);
  const specRef = useRef<ChartSpec | undefined>(spec);
  const stateRef = useRef<ChartState>(freshState(false));
  const observerRef = useRef<ResizeObserver | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  const containerRef = useCallback((node: HTMLElement | null): void => {
    if (nodeRef.current === node) {
      return;
    }
    // 换节点或卸载：先拆旧的。卸掉的是**上一张**图，与 `node === null` 与否无关——
    // React 在同一个组件上换 ref 节点时会先给 null 再给新节点，两次都要走到这里。
    const previous = stateRef.current;
    previous.disposed = true;
    previous.handle?.dispose();
    previous.handle = undefined;
    previous.node = undefined;
    stateRef.current = freshState(node === null);
    nodeRef.current = node;
    // 尺寸自适应观察**容器**而不是 window：侧栏收起、面板分栏这类不动窗口的布局变化
    // 也要让图跟着变。观察器跟着节点走（换节点换观察对象，卸载即断开）。
    observerRef.current?.disconnect();
    if (node !== null) {
      observerRef.current ??= new ResizeObserver(() => {
        stateRef.current.handle?.resize();
      });
      observerRef.current.observe(node);
    }
  }, []);

  useEffect(() => {
    specRef.current = spec;
    const node = nodeRef.current;
    if (node === null || spec === undefined) {
      return;
    }
    // 必须把 rejection 收掉：`attachChart` 里每一段 await 都可能抛（chunk 加载、mount），
    // 而 `void somePromise` 不会消费 rejection——那会变成一条未处理的拒绝，在宿主里表现为
    // 一条谁也没见过的全局错误，且原来的失败标记也就此丢掉。包一层 async IIFE + try/catch
    // 而不是挂 `.catch`：本仓基线禁 `promise/prefer-await-to-then`，而这里恰好也不需要链。
    void (async () => {
      try {
        await attachChart(node, stateRef.current, spec, (didFail) => {
          setFailed(didFail);
        });
      } catch {
        // 走到这里说明 `attachChart` 自己没兜住（它内部对加载失败是有返回值的），
        // 记一句再让占位图留着——图表是附加信息，缺了它页面照常。
        console.warn("[rtk] cannot attach the chart");
        setFailed(true);
      }
    })();
  }, [spec]);

  // 主题切换：宿主只改 `body` 上的属性，本组件不会重渲染。观察那一处属性，重新取色再 update。
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const node = nodeRef.current;
      const { current } = specRef;
      if (node === null || current === undefined) {
        return;
      }
      updateChart(stateRef.current, node, themedOf(node, current));
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-ds-dark-theme", "class", "style"],
    });
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(
    () => () => {
      // 卸载的兜底：`containerRef(null)` 通常已经拆过了，但 ref 回调不一定每次都拿到 null
      // （React 只保证在真正卸载时调用一次，顺序也无从依赖），这里再收一次是最便宜的保险。
      const state = stateRef.current;
      state.disposed = true;
      state.handle?.dispose();
      state.handle = undefined;
      state.node = undefined;
      observerRef.current?.disconnect();
      observerRef.current = undefined;
    },
    [],
  );

  return { containerRef, failed };
}
