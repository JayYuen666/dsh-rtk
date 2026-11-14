// 一段模型可见文本的 token 定价。
//
// 为什么收成一个函数而不是在两处各算一次：字节能数、token 不能——它是模型侧的估计量，
// 而宿主已经把那份估计做在 `ctx.tokenMeter` 里（`estimateMessage` 是它的实例面）。自己再写
// 一份 `bytes / 4` 就有了第二个口径：宿主改密度（`CHARS_PER_TOKEN`）时卡片上的数字与宿主
// 账单说的不是一回事，而两处都不会红。
//
// 服务缺席时**必须**有回退：`tokenMeter` 是本插件可选的协作者（没装它的 profile 压缩照常），
// 少一个统计分母不该让 `tools/post-execute` 抛错。回退用同一密度的字节口径，并在 `statsNote`
// 里如实说明这一格是估算。
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-llm";

import { hasMethods } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 把一段文本折成 token 数。纯函数性质：同文本同结果，不抛错。 */
export type TokenPricer = (text: string) => number;

/**
 * 宿主 tokenMeter 的最小面。
 *
 * 只列本文件真正调用的那一个方法：拿到整个服务对象再 `meter.estimateMessage(...)` 会让
 * 「服务换了实现但留着同名方法」这类变化静默变成另一套定价。
 */
interface TokenMeterFace {
  readonly estimateMessage: (message: UserMessage) => number;
}

/** 字节回退口径：与宿主 `CHARS_PER_TOKEN = 4` 同密度，但按 UTF-8 字节而非 UTF-16 码元。 */
const FALLBACK_BYTES_PER_TOKEN = 4;

/**
 * 服务能力判定（类型谓词，不做断言）。
 *
 * 写成 `value is TokenMeterFace` 而不是 `hasMethods(...) ? (found as TokenMeterFace) : undefined`：
 * 后者是「先断言再当真」，`hasMethods` 说它有 `estimateMessage` 之后就再没有东西替它复核形状；
 * 谓词形式让收窄由编译器完成，也符合本仓 `isAgentsFace` / `isSpillStore` 的既有写法。
 */
function isTokenMeter(value: unknown): value is TokenMeterFace {
  return hasMethods(value, ["estimateMessage"]);
}

function meterOf(ctx: { readonly get?: (name: string) => unknown }): TokenMeterFace | undefined {
  const found = ctx.get?.("tokenMeter");
  return isTokenMeter(found) ? found : undefined;
}

/**
 * 取一个定价函数。
 *
 * **为什么要包成 Message**：`tokenMeter` 的公开面只有 `estimateMessage(message)`，没有
 * 「纯文本 → token」的入口——它的 `estimateContent` 是按内容块计价的，而内容块必须挂在一条
 * 消息上。包出来的消息**不落库、不进会话**，只用来算一次数字。
 *
 * **为什么每次调用都重新找服务**：`tokenMeter` 由别的插件挂上来，装配本插件的时刻它可能还没
 * 就位。在工厂里查一次并缓存，等于把「谁先装载」变成定价口径的开关——同一个 profile 里换个
 * 加载顺序，卡片上的数字就从 token 变成字节，而没有任何东西会红。`ctx.get` 只是一次表查找，
 * 热路径上也只在压缩成功后才走两趟。
 *
 * **角色框架那 4 个 token**：`estimateMessage` 对非 system 角色一律「内容 + 4」。两侧都加这 4，
 * 所以「省下多少」不受影响，只有绝对值带这点偏置——卡片文案写着这是估算。
 *
 * @param ctx 能 `get` 到服务的上下文（测试可给同形替身）
 * @returns 定价函数；服务不在时回退到字节密度估算
 */
export function tokenPricerOf(ctx: { readonly get?: (name: string) => unknown }): TokenPricer {
  return (text: string): number => {
    const meter = meterOf(ctx);
    if (meter === undefined) {
      return Math.ceil(Buffer.byteLength(text, "utf8") / FALLBACK_BYTES_PER_TOKEN);
    }
    return meter.estimateMessage(
      createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }),
    );
  };
}
