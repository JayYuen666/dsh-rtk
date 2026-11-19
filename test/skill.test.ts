// lib/skill.ts 单测：三件事——文案入口把正文与说明原样交给 shared、skill 服务缺席时只回
// false（不抛、不挡装配）、以及注册的撤销权真的挂在调用方给的 effect 上。
//
// 为什么这些用例值钱：`registerUsageSkill` 的失败形态**全部是静默的**。服务缺席 → 回 false、
// 宿主 register 抛错 → 回 false、effect 挂不上 → 回 false。也就是说「skill 没注册上」在
// 装配日志里零痕迹，只有模型侧少一条目录条目。所以判据必须钉在「调了谁、传了什么」上。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { registerUsageSkill, SKILL_NAME, USAGE_ORDER, USAGE_SECTION } from "../lib/skill.ts";

/** 假的 skill 服务：记下每次 register 的入参与交回的 disposer。 */
interface SkillCall {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly source: string;
}

function registryStub(): {
  readonly ctx: { get: (name: string) => unknown };
  readonly calls: SkillCall[];
  readonly disposed: (() => void)[];
  readonly effects: string[];
} {
  const calls: SkillCall[] = [];
  const disposed: (() => void)[] = [];
  const effects: string[] = [];
  const skills = {
    register: (skill: SkillCall): (() => void) => {
      calls.push(skill);
      const dispose = (): void => {
        disposed.push(dispose);
      };
      return dispose;
    },
  };
  return {
    ctx: {
      get: (name: string): unknown => (name === "skills" ? skills : undefined),
      effect: (execute: () => () => void, label?: string): unknown => {
        effects.push(label ?? "");
        // 交回去的 disposer 不在这里执行：撤销的时机属于插件 fiber，与注册那一刻无关。
        execute();
        return () => {
          // 撤销时机归插件 fiber：这条替身只在 `registerSkill` 交回 effect 时被调用一次。
        };
      },
    } as { get: (name: string) => unknown },
    calls,
    disposed,
    effects,
  };
}

describe("registerUsageSkill", () => {
  it("把 name/description/content 原样交给宿主，source 缺省 runtime", () => {
    const stub = registryStub();
    const ok = registerUsageSkill(stub.ctx, "正文全文", "目录里那行说明");
    assert.equal(ok, true);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0], {
      name: SKILL_NAME,
      description: "目录里那行说明",
      content: "正文全文",
      source: "runtime",
    });
  });

  it("skill 服务缺席时回 false 且不抛（精简 profile 照常装配）", () => {
    const ctx = { get: (): unknown => undefined };
    assert.equal(registerUsageSkill(ctx, "正文", "说明"), false);
  });

  it("正文为空时不注册（注册一枚空 skill 只会给目录添一条点开什么都没有的条目）", () => {
    const stub = registryStub();
    assert.equal(registerUsageSkill(stub.ctx, "", "说明"), false);
    assert.deepEqual(stub.calls, []);
  });

  it("宿主 register 抛错时回 false，不把异常穿给 apply", () => {
    const ctx = {
      get: (): unknown => ({
        register: (): never => {
          throw new Error("duplicate skill");
        },
      }),
    };
    assert.equal(registerUsageSkill(ctx, "正文", "说明"), false);
  });

  it("撤销权交给调用方 effect，label 里带 skill 名", () => {
    const stub = registryStub();
    registerUsageSkill(stub.ctx, "正文", "说明");
    assert.equal(stub.effects.length, 1);
    const [label] = stub.effects;
    assert.ok(label?.includes(SKILL_NAME) === true, String(label));
  });

  it("段名与 order 是分开的两个常量：1565 让本段落在三个兄弟插件之后、jobs 说明之前", () => {
    // 值写死在这里而不是从实现取：order 是「与本插件无关的排版位」，改了要有人显式说一声。
    assert.equal(USAGE_ORDER, 1565);
    assert.notEqual(USAGE_SECTION, SKILL_NAME, "段名与 skill 名是两件事，别绑在一起");
  });
});
