// lib/tokens.ts 单测：定价的两个口径与三种边界。
//
// 为什么值得单独一份：token 定价是卡片上「省了多少」的分母来源，而它的两个分支
// （宿主 tokenMeter 在 / 不在）在生产里**都不会报错**——错了只是数字不同。所以每条分支
// 都必须有一格断言把结论钉住，不能靠「压缩流程跑通了」间接代表。
//
// 断言全部独立写死期望值：若期望从被测实现推出来（例如再跑一遍 `Math.ceil(bytes / 4)`），
// 实现改口径时测试会跟着一起改，永远绿。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { tokenPricerOf } from "../lib/tokens.ts";

/**
 * 假的「取不到服务」。
 *
 * 用 `{}` 而不是 `() => undefined`：回退分支只判「拿到的不是可用服务」，`get` 交回 undefined
 * 与交回一个普通对象走的是同一条路（`isTokenMeter` 都判否）。写成对象还顺带钉住了
 * 「一个空对象不能冒充 tokenMeter」。
 */
const NO_METER: unknown = {};

/** 只记调用的 tokenMeter 替身：`estimateMessage` 回固定值，并把收到的消息原样留下。 */
function meterOf(price: number): {
  readonly service: { readonly estimateMessage: (message: unknown) => number };
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    service: {
      estimateMessage: (message: unknown): number => {
        calls.push(message);
        return price;
      },
    },
    calls,
  };
}

describe("tokenPricerOf", () => {
  it("宿主 tokenMeter 在时用它定价，且把文本包成一条 user 消息", () => {
    const { service, calls } = meterOf(42);
    const price = tokenPricerOf({ get: (name) => (name === "tokenMeter" ? service : undefined) });
    assert.equal(price("hello"), 42);
    assert.equal(calls.length, 1);
    // 包的形状本身是判据：`estimateMessage` 只收 Message，纯文本没有入口。角色与内容块
    // 写错都不会报错，只会算出另一个数——所以这一格逐字段比对。
    assert.deepEqual(
      { role: (calls[0] as { role?: unknown }).role },
      { role: "user" },
      "必须包成 user 角色（system 走另一条计价分支）",
    );
    const { content } = calls[0] as { content?: readonly unknown[] };
    assert.deepEqual(content, [{ type: "text", text: "hello" }]);
  });

  it("服务不在时回退到字节密度：UTF-8 字节 / 4 向上取整", () => {
    const price = tokenPricerOf({ get: () => NO_METER });
    // 12 字节 → 3；与「字符数 / 4」在纯 ASCII 上同值，所以下面那格用非 ASCII 分开。
    assert.equal(price("hello world!"), 3);
  });

  it("回退口径按 UTF-8 字节而不是字符数（中文一字三字节）", () => {
    const price = tokenPricerOf({ get: () => NO_METER });
    // 「中文」= 6 字节 → ceil(6/4) = 2；若按字符数算则是 ceil(2/4) = 1。
    assert.equal(price("中文"), 2);
  });

  it("ctx 没有 get 这个面时也走回退，不抛错", () => {
    // `HostContext.get` 是可选位：老宿主/替身上可能整个缺失。
    const price = tokenPricerOf({});
    assert.equal(price("abcd"), 1);
  });

  it("服务对象存在但没有 estimateMessage 时不算数，走回退", () => {
    // `hasMethods` 判的是「声明的方法都可调用」：一个普通对象不该冒充服务。
    const price = tokenPricerOf({ get: () => ({ estimateMessage: 1 }) });
    assert.equal(price("abcd"), 1);
  });

  it("每次调用都重新查服务：后挂上的 tokenMeter 立刻生效（不缓存口径）", () => {
    // 这一格是「为什么不在工厂里缓存」的判据面：装配时刻服务可能还没就位，
    // 缓存等于把装载顺序变成定价口径的开关，而那种变化没有任何东西会红。
    // 初值给「取不到服务」的普通对象：与真装配里服务尚未挂上时的形状同形。
    let service: unknown = NO_METER;
    const { service: meter } = meterOf(99);
    const price = tokenPricerOf({ get: (name) => (name === "tokenMeter" ? service : undefined) });
    assert.equal(price("abcd"), 1, "服务尚未挂上时按字节回退");
    service = meter;
    assert.equal(price("abcd"), 99, "挂上之后必须立刻改用它");
  });
});
