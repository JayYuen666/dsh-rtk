// lib/messages.ts 单测：两语字典的键集同源、关键文案点名了出路、以及一条**不许有**的键。
//
// 「没有 retrievalHint 键」这条是设计约束的守门人：全文提示只能来自宿主 SpillRef.retrievalHint，
// 插件自己拼路径正是 v3.4 那个硬错（拿 ref.path 拼，宿主根本没有那个字段）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { messagesFor } from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { MESSAGES } from "../lib/messages.ts";

// 写死的期望键集，**不从 MESSAGES 自己取键**：从被测对象推期望值，删掉一个键两边一起少，
// 这条断言永远绿。表里只留真的从宿主发出去了的键——卡片文案归 src/ui-messages.ts。
const KEYS = ["cargoTestWarnHint", "spillSummary", "spillLocation", "spillRelaxed"] as const;

describe("messages 两语字典同源", () => {
  it("zh/en 键集合相等", () => {
    assert.deepEqual(Object.keys(MESSAGES.zh).toSorted(), Object.keys(MESSAGES.en).toSorted());
  });

  it("每条文案都非空", () => {
    for (const locale of ["zh", "en"] as const) {
      for (const key of KEYS) {
        assert.ok(MESSAGES[locale][key].length > 0, `${locale}.${key} 是空串`);
      }
    }
  });
});

describe("messages 关键文案", () => {
  it("键集恰好是这几个宿主消息，不多带卡片文案", () => {
    assert.deepEqual(Object.keys(MESSAGES.zh).toSorted(), [...KEYS].toSorted());
    assert.deepEqual(Object.keys(MESSAGES.en).toSorted(), [...KEYS].toSorted());
  });

  it("warnHint 指向 cargo build", () => {
    assert.ok(messagesFor(MESSAGES, "en").cargoTestWarnHint.includes("cargo build"));
  });

  it("spillLocation 带 {path} 与 {hint} 两个占位符（少了 path 模型就找不到文件）", () => {
    for (const locale of ["zh", "en"] as const) {
      const text = messagesFor(MESSAGES, locale).spillLocation;
      assert.ok(text.includes("{path}"), `${locale} 少了 {path}`);
      assert.ok(text.includes("{hint}"), `${locale} 少了 {hint}`);
      assert.ok(!text.includes("{locator}"), `${locale} 用了不存在的占位符名`);
    }
  });

  it("spillSummary 不超过 120 字（宿主的 notice 形态上限）", () => {
    for (const locale of ["zh", "en"] as const) {
      assert.ok(messagesFor(MESSAGES, locale).spillSummary.length <= 120, locale);
    }
  });

  it("没有 retrievalHint 键（全文提示由 SpillRef 提供）", () => {
    assert.equal(Object.hasOwn(MESSAGES.zh, "retrievalHint"), false);
    assert.equal(Object.hasOwn(MESSAGES.en, "retrievalHint"), false);
  });
});
