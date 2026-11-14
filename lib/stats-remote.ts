// lib/stats-remote.ts —— 统计读面的宿主侧：把自记账与运行时状态暴露成官方 Typert Remote。
//
// 为什么非 Remote 不可：设置卡跑在浏览器里，统计在宿主进程的内存里，而 `ctx.settings` 只
// 负责配置面、没有「贡献一个只读描述符」的 API。官方 `permission-presets` 也是这么做的。
//
// 三个端点都是**无参、一元、JSON 结果** —— 这正是手写客户端 descriptor 成立的前提（带参数
// 或流式就得上生成器那套 codec）。
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

import { RTK_STATS_NAMESPACE } from "./stats-shape.ts";
import type { StatsStatus, StatsSummary } from "./stats-shape.ts";
import type { StatsStore } from "./stats-store.ts";

/** 客户端侧的**服务键 = 线上命名空间**。`src/stats-reader.ts` 里内联了同一个串（两个产物各自
 *  打包，本串无法跨产物引用），改这里必须同步那一处。 */
export const RTK_STATS_SERVICE_KEY = RTK_STATS_NAMESPACE;

/**
 * 卡片顶部那行运行时状态。探不到的一律给 `null`，别用「没装」冒充「探不到」。
 *
 * 形状的真源在 `./stats-shape.ts` 的 `statsStatusSchema`（客户端读面按它 parse 回执）：
 * 这里只转出那个类型，不另立一份 interface——两份形状各自漂移时，症状是卡片读到
 * `undefined` 而不是编译错误。
 */
export type { StatsStatus } from "./stats-shape.ts";

export interface StatsRemoteDeps {
  readonly store: StatsStore;
  readonly status: () => StatsStatus;
}

/**
 * 统计读面。服务在**构造时**注册（cordis `Service` 契约：`ctx.reflect.provide`，随 fiber
 * 卸载自动撤），因此 `installStatsRemote` 里那句 `new` 的返回值没有意义。
 */
export class RtkStatsService extends TypertRemoteService {
  // 显式字段 + 构造里赋值，不用参数属性：`erasableSyntaxOnly` 不允许参数属性这类带语法的糖。
  private readonly deps: StatsRemoteDeps;

  public constructor(ctx: Context, deps: StatsRemoteDeps) {
    super(ctx, RTK_STATS_SERVICE_KEY);
    this.deps = deps;
  }

  /** 一份统计快照。 */
  // 必须是实例方法：`remoteMethods()` 读的是类**原型**上的描述符，静态方法落不到那儿。
  // oxlint-disable-next-line eslint/new-cap -- `@Remote(…)` 是装饰器工厂，不是构造调用
  @Remote("summary")
  public summary(): StatsSummary {
    return this.deps.store.summary();
  }

  /** rtk 是否可用、版本、以及当前开着的形态。卡片用它渲染「未安装 / 版本过低」的引导行。 */
  // oxlint-disable-next-line eslint/new-cap -- 同上
  @Remote("status")
  public status(): StatsStatus {
    return this.deps.status();
  }

  /** 清零自记账。返回清零后的快照，省一次往返。 */
  // oxlint-disable-next-line eslint/new-cap -- 同上
  @Remote("reset")
  public async reset(): Promise<StatsSummary> {
    await this.deps.store.reset();
    return this.deps.store.summary();
  }
}

/**
 * 这个上下文能注册服务吗（只探「可不可调」这一位）。
 *
 * 写成**类型谓词**而不是 `boolean`：调用方拿到 true 之后就不必再 `as unknown as Context`
 * 硬转一次（那一次断言等于把「探过了」这件事抹掉）。探的判据仍然只是一位——`reflect.provide`
 * 可调用，其余服务面由 `TypertRemoteService` 自己在构造时用。
 */
function hasServiceRegistry(value: unknown): value is Context {
  if (!isRecord(value)) {
    return false;
  }
  const { reflect } = value;
  return isRecord(reflect) && typeof reflect["provide"] === "function";
}

/**
 * 装统计读面。它是**可选**读面：注册失败只该让卡片少一栏，绝不该把压缩主功能打掉 ——
 * 所以先探注册口、把构造包在 try 里、失败时 `console.warn` 一句说明少了什么。
 *
 * 两档失败要分开：**探测不过**是「这个宿主没有那个注册口」（能力缺席，安静返回 false）；
 * **构造时抛错**是「有这个口但装不上」（真失败，要报警）。合成一档的话，用户看到空统计栏
 * 时无法判断该不该去翻日志。
 * @param ctx - 宿主上下文（收 `unknown`：它先过 `hasServiceRegistry` 收窄，调用方不必自己硬转）
 * @param deps - 存储与状态读取器
 * @returns 装上了没有（调用方不需要这个值，它只是让这条路可断言）
 */
export function installStatsRemote(ctx: unknown, deps: StatsRemoteDeps): boolean {
  if (!hasServiceRegistry(ctx)) {
    return false;
  }
  try {
    // oxlint-disable-next-line eslint/no-new -- 构造即注册，返回值无意义
    new RtkStatsService(ctx, deps);
  } catch (error) {
    console.warn(
      `[rtk] 统计读面没能注册（${RTK_STATS_SERVICE_KEY}）：${errorText(error)}。` +
        "设置卡会少一栏统计，压缩本身不受影响。",
    );
    return false;
  }
  return true;
}
