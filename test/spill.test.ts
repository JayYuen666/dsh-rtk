// lib/spill.ts 单测：压缩后正文的封顶，以及把压缩前原文交给宿主的 spill 存储。
//
// 硬错 1 的判据在这里：宿主 `saveText` 返回的 `SpillRef` 只有 `locator` / `bytes` /
// `retrievalHint` 三个字段，**没有 `path`**。全文提示必须原样用宿主给的
// `retrievalHint`（官方注释：消费方用它渲染，不要解析 locator）。桩自己造一个 `{path}`
// 会让测试全绿而线上恒 undefined——那正是这一格要防的。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { SpillLocator } from "@deepseek-ai/dsh-spill";
import { capCompressed, spillOriginal } from "../lib/spill.ts";

/** 桩必须按**真宿主形状**返回。 */
const REF = {
  locator: "spill:abc" as SpillLocator,
  bytes: 1234,
  retrievalHint: "read the spill file: spill:abc",
};

describe("capCompressed", () => {
  it("不超帽时原样返回", () => {
    assert.equal(capCompressed("abc", 10), "abc");
  });

  it("超帽时保留尾部（与 bash 截断语义一致）", () => {
    assert.equal(capCompressed("abcdef", 3), "def");
  });

  it("按字节判帽：中文不按字符数算", () => {
    // 「测试测试」= 12 字节；帽 6 字节装得下两个汉字 → 留住末尾的「测试」。
    assert.equal(capCompressed("测试测试", 6), "测试");
  });

  it("帽为 0 时返回空串", () => {
    assert.equal(capCompressed("abc", 0), "");
  });

  it("空输入返回空串", () => {
    assert.equal(capCompressed("", 10), "");
  });

  it("emoji 不切坏代理对", () => {
    // 每个 emoji 是 4 字节 UTF-8 / 2 个 UTF-16 码元；帽 8 只能装两个。
    assert.equal(capCompressed("😀😀😀", 8), "😀😀");
  });

  it("帽落在字符中间时整个字符都不留（不产出半个字符）", () => {
    // 「测」是 3 字节；帽 2 装不下任何一个完整字符。
    assert.equal(capCompressed("测", 2), "");
  });

  it("一字节与两字节字符的宽度各自算对", () => {
    // 「é」是 U+00E9，UTF-8 占 2 字节；「a」占 1 字节。
    assert.equal(capCompressed("aé", 3), "aé");
    assert.equal(capCompressed("aé", 2), "é");
  });
});

describe("spillOriginal（SpillRef 真形状）", () => {
  it("locator 与 retrievalHint 原样透传", async () => {
    const store = { saveText: async () => REF };

    const result = await spillOriginal({
      spillStore: store,
      owner: "s1",
      toolName: "bash",
      callId: "c1",
      text: "orig",
    });

    assert.ok(result !== undefined);
    assert.equal(result.locator, REF.locator);
    assert.equal(result.bytes, REF.bytes);
    // 关键：不是插件拼的模板，而是宿主给的那句话。
    assert.equal(result.retrievalHint, REF.retrievalHint);
  });

  it("传给 saveText 的入参形状与宿主契约逐字一致", async () => {
    const calls: unknown[] = [];
    const store = {
      saveText: async (input: unknown) => {
        calls.push(input);
        return REF;
      },
    };

    await spillOriginal({
      spillStore: store,
      owner: "s1",
      toolName: "bash",
      callId: "c1",
      text: "orig",
    });

    assert.deepEqual(calls[0], {
      owner: { sessionId: "s1" },
      source: { kind: "tool", toolName: "bash", callId: "c1", label: "result" },
      suggestedName: "bash.txt",
      content: "orig",
    });
  });

  it("saveText 抛错时 undefined（取回通道缺失不影响压缩本身）", async () => {
    const store = {
      saveText: async () => {
        throw new Error("no backend");
      },
    };

    assert.equal(
      await spillOriginal({
        spillStore: store,
        owner: "s1",
        toolName: "bash",
        callId: "c1",
        text: "orig",
      }),
      undefined,
    );
  });

  it("spillStore 缺席时 undefined", async () => {
    assert.equal(
      await spillOriginal({
        spillStore: undefined,
        owner: "s1",
        toolName: "bash",
        callId: "c1",
        text: "orig",
      }),
      undefined,
    );
  });
});
