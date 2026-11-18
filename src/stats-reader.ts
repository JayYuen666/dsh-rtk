// src/stats-reader.ts —— 卡片与 Insights 页经官方 Typert Remote 读宿主进程里的自记账统计。
//
// 为什么 descriptor 是**手写**的：宿主网关在源模式（`{mode:"src-json"}`）下从方法签名推
// 参数名，不需要生成器的 typeSymbol / create()。而客户端 `$mount` 的贡献校验要求**每个入参**
// 带 strict codec —— 本包四个方法里三个无参（`parameters: []`），只有 `insights` 带一个
// `request`，所以只需为它手写一枚 codec。这也是「手写 descriptor 成立」在这里的边界：
// 再多一个带参方法就该上生成器那套了。
//
// ⚠ 为什么走 `ctx.get("remote")` 而不是把 `remote` 写进 `inject`：cordis 对**未 inject 的
// 服务**读取是抛错的（`cannot get property "remote" without inject`），而卡片的其余部分在
// 「没装远程通道」的部署里也必须照常渲染。`ctx.get` 是显式读取，不受 inject 门禁约束。
//
// ⚠ 类型一律 `import type`：`@deepseek-ai/*` 只作类型消费，产物里不新增模块说明符。
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/client";
import { z } from "zod";

import {
  InsightsRequestSchema,
  InsightsResponseSchema,
  StatsOverviewSchema,
} from "../lib/insights-shape.ts";
import type { InsightsRequest, InsightsResponse, StatsOverview } from "../lib/insights-shape.ts";
import { statsStatusSchema } from "../lib/stats-shape.ts";
import type { StatsStatus } from "../lib/stats-shape.ts";

/** 卡片所在 bundle 的包名：`$mount` 的 `package` 位与插槽键同源（见 src/client-entry.ts）。 */
export const PACKAGE_NAME = "@jayyuen66/dsh-rtk";

/** 服务键 = 线上命名空间。宿主侧 `RTK_STATS_SERVICE_KEY` 是同一个串（产物各自打包，
 *  无法跨产物引用）；改这里必须同步 lib/stats-remote.ts。 */
const STATS_NAMESPACE = "rtkStats";

/** 网关给命名空间注册的服务键：`remote.<namespace>`。它在 `$mount` 完成**之后**才存在。 */
const STATS_SERVICE_KEY = `remote.${STATS_NAMESPACE}`;

/**
 * 线上回执逐字段过 schema 再交给卡片。
 *
 * 不做断言：这条数据跨进程、跨版本从网关来，`as StatsOverview` 只把「形状不对」这件事
 * 推迟到卡片渲染时炸成 `undefined.toFixed`。schema 是同一份 `lib/insights-shape.ts` 里的
 * 线上定义——真源一处，读面不为它再抄一份形状。
 */
function parseOrThrow<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

/**
 * `insights` 的入参 codec。
 *
 * `mode: "strict"` 是网关的硬要求（缺了它 `$mount` 直接被拒，理由串是
 * `generated Remote … has no strict codec`），而 `create()` 交出的 `parse` 只在**客户端**
 * 用：它把调用方写的请求在发出前收成合法形状，坏请求当场炸在调用点，而不是等网关回一句
 * `BAD_ARGS`。服务端不读这枚 codec —— 它只收已经还原好的参数对象。
 *
 * `typeSymbol` 用 `<包名>#<语义名>` 的形状（与兄弟仓同一套约定）：它只是 codec 的身份串，
 * 真源仍是 `InsightsRequestSchema`，两处不会各说一套。
 */
const INSIGHTS_CODEC: TypertCodec<InsightsRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#insights-request`,
  create: () => ({
    parse(value: unknown): InsightsRequest {
      return parseOrThrow(InsightsRequestSchema, value);
    },
  }),
};

/**
 * 四个端点。
 *
 * `insights` 是唯一带参的那个：它的 `parameters` 里写 `name`（源级参数名，宿主侧方法签名
 * 必须同名）、`wire`（线上 `args` 的键）、`source: "json"` 与那枚 strict codec。
 */
export const STATS_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${STATS_NAMESPACE}/overview`,
    service: STATS_NAMESPACE,
    namespace: STATS_NAMESPACE,
    method: "overview",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${STATS_NAMESPACE}/insights`,
    service: STATS_NAMESPACE,
    namespace: STATS_NAMESPACE,
    method: "insights",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: INSIGHTS_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${STATS_NAMESPACE}/status`,
    service: STATS_NAMESPACE,
    namespace: STATS_NAMESPACE,
    method: "status",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${STATS_NAMESPACE}/reset`,
    service: STATS_NAMESPACE,
    namespace: STATS_NAMESPACE,
    method: "reset",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
];

/**
 * 读取器形状用属性签名而不是方法签名：工作区的
 * `typescript(method-signature-style)` 要求这块写成 `readonly m: () => …`。
 */
export interface StatsReader {
  readonly overview: () => Promise<StatsOverview>;
  readonly insights: (request: InsightsRequest) => Promise<InsightsResponse>;
  readonly status: () => Promise<StatsStatus>;
  readonly reset: () => Promise<StatsOverview>;
}

/** 客户端上下文里本模块用到的那一位：显式读取一个可选服务。 */
export interface RemoteHost {
  get?: (name: string, strict?: boolean) => unknown;
}

interface RemoteMounter {
  $mount: (config: {
    package: string;
    descriptors: readonly InvocationDescriptor[];
  }) => Promise<unknown>;
}

const isRemoteMounter = (value: unknown): value is RemoteMounter =>
  isRecord(value) && typeof value["$mount"] === "function";

/**
 * 可调用的无参或多参函数。
 *
 * 命名空间的方法表类型是 `Record<string, unknown>`（见 `RemoteNamespace`），
 * 这里把「确实是函数」这一步收成一个类型谓词——调用点因此不必对 `unknown` 写断言，
 * 断言会把「先判过」这件事抹掉，而这一判正是缺方法时的报错依据。
 */
const isCallable = (value: unknown): value is (...args: readonly unknown[]) => unknown =>
  typeof value === "function";

/** 线上回执的最小形状（`ok: true` 带 value / `ok: false` 带 error）。 */
function isWireResult(value: unknown): value is RemoteResult<unknown> {
  if (!isRecord(value)) {
    return false;
  }
  return value["ok"] === true ? "value" in value : isRecord(value["error"]);
}

/**
 * 远端命名空间的服务方法表：每个方法回一份线上结果。**值类型留 `unknown`**：
 * 网关版本与客户端产物各自独立发布，descriptor 里声明的方法服务端不一定还留着，
 * 断言成函数表会让「缺方法」变成运行期 `is not a function`（见 `callOf`）。
 */
type RemoteNamespace = Record<string, unknown>;

/**
 * 取一个远端方法的回执。
 *
 * 两处形状都不确定，所以整段都在收窄：
 *   - `Record` 索引在 `noUncheckedIndexedAccess` 下是 `T | undefined`，缺方法确实可能发生
 *     （网关版本与客户端产物各自独立发布，descriptor 里有的方法服务端不一定还留着）；
 *   - 客户端命名空间的方法**经网关注册成异步代理**，返回值可能是 thenable，也可能已经是
 *     一份现成回执（同进程内联时）。`Promise.resolve` 把两种都摊平成同一个等待面——
 *     直接用 `await` 会被 `typescript(await-thenable)` 判红（静态类型是 `unknown`）。
 *
 * `args` 是可选的位置实参：只有 `insights` 会传一个请求对象，其余方法一个都不传
 * （空数组也不传——那会把「无参」写成两种表达）。
 */
async function callOf(
  namespace: RemoteNamespace,
  method: string,
  args: readonly unknown[] = [],
): Promise<RemoteResult<unknown>> {
  const call = namespace[method];
  // 类型谓词而不是 `as () => unknown` 断言：断言等于说「它一定是这个形状」，
  // 而这里恰恰是「先确认可调用，再把它的返回值当未知量处理」。
  if (!isCallable(call)) {
    throw new TypeError(`remote namespace ${STATS_SERVICE_KEY} has no method ${method}`);
  }
  const outcome: unknown = await Promise.resolve(call(...args));
  if (!isWireResult(outcome)) {
    throw new TypeError(
      `remote namespace ${STATS_SERVICE_KEY} method ${method} did not return a wire result`,
    );
  }
  return outcome;
}

/**
 * 线上拒绝（`result.ok=false`）翻成异常：code 与 message 都来自网关的错误对象。
 * 两个分支都写成真实语句（if-return / throw）：只写 if-throw 时隐式空 else 在 v8 的块覆盖里
 * 会记成一个无处落位的空块，整包 100% 门禁被这条伪块随机打红。
 */
async function unwrapWire<Value>(call: Promise<RemoteResult<Value>>): Promise<Value> {
  const result = await call;
  if (result.ok) {
    return result.value;
  }
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

/** 每次调用现读命名空间：`$mount` 之前它不存在，`$mount` 之后才由网关注册。 */
async function namespaceOf(
  ctx: RemoteHost,
  mountedRef: { promise: Promise<unknown> | undefined },
): Promise<RemoteNamespace> {
  // remote 是未写进 inject 的可选服务，提供方不保证在卡片 apply 之前注册：每次调用现读。
  const mounter = ctx.get?.("remote");
  if (!isRemoteMounter(mounter)) {
    throw new Error("remote channel is not available in this deployment");
  }
  try {
    mountedRef.promise ??= mounter.$mount({
      package: PACKAGE_NAME,
      descriptors: STATS_DESCRIPTORS,
    });
    await mountedRef.promise;
  } catch (error) {
    // 挂载失败不留缓存：rejected promise 一旦复用，之后每次刷新都撞同一个 rejection，
    // 重试永远不会发生。
    mountedRef.promise = undefined;
    throw error;
  }
  const namespace = ctx.get?.(STATS_SERVICE_KEY);
  if (!isRecord(namespace)) {
    throw new Error(`remote namespace ${STATS_SERVICE_KEY} is missing`);
  }
  return namespace;
}

function buildStatsReader(ctx: RemoteHost): StatsReader {
  const mountedRef: { promise: Promise<unknown> | undefined } = { promise: undefined };
  return {
    overview: async (): Promise<StatsOverview> => {
      const namespace = await namespaceOf(ctx, mountedRef);
      const value = await unwrapWire(callOf(namespace, "overview"));
      return parseOrThrow(StatsOverviewSchema, value);
    },
    insights: async (request: InsightsRequest): Promise<InsightsResponse> => {
      const namespace = await namespaceOf(ctx, mountedRef);
      const value = await unwrapWire(callOf(namespace, "insights", [request]));
      return parseOrThrow(InsightsResponseSchema, value);
    },
    status: async (): Promise<StatsStatus> => {
      const namespace = await namespaceOf(ctx, mountedRef);
      const value = await unwrapWire(callOf(namespace, "status"));
      return parseOrThrow(statsStatusSchema, value);
    },
    reset: async (): Promise<StatsOverview> => {
      const namespace = await namespaceOf(ctx, mountedRef);
      const value = await unwrapWire(callOf(namespace, "reset"));
      return parseOrThrow(StatsOverviewSchema, value);
    },
  };
}

/**
 * 造一个读统计的读取器；**连 `ctx.get` 面都不在时返回 `undefined`**（卡片照常渲染，
 * 统计区显示「读面未连接」）。remote 是否在场**不在这一步判**：解析推迟到每次调用。
 */
export function createStatsReader(ctx: RemoteHost): StatsReader | undefined {
  // 单 return（三元另一支是 undefined）：consistent-return 不接受「早退 undefined + 晚退函数」。
  return typeof ctx.get === "function" ? buildStatsReader(ctx) : undefined;
}
