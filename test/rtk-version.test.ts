// lib/rtk-version.ts 单测：三段解析（含溢出与读不懂）、支持面比较、阈值同源，
// 以及装配期探测的三条失败路径（读不到 / 读不懂 / 读取本身抛错）。
//
// 「阈值同源」那条不写死 1.0.0：期望值从 MIN_RTK_VERSION 走一遍 parse → format 回到原字符串，
// 这样抬下限时不会被一份独立的字面量挡住。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  parseRtkVersion,
  isRtkVersionSupported,
  formatRtkVersion,
  probeRtkVersion,
  MIN_RTK_VERSION,
} from "../lib/rtk-version.ts";

describe("parseRtkVersion", () => {
  it("解析 rtk 1.2.0", () => {
    assert.deepEqual(parseRtkVersion("rtk 1.2.0"), { major: 1, minor: 2, patch: 0 });
  });

  it("解析裸 1.0.0", () => {
    assert.deepEqual(parseRtkVersion("1.0.0"), { major: 1, minor: 0, patch: 0 });
  });

  it("带预发布后缀也解析（rc 与正式版 CLI 面无差异）", () => {
    assert.deepEqual(parseRtkVersion("rtk 1.2.0-rc.1"), { major: 1, minor: 2, patch: 0 });
  });

  it("读不懂 undefined", () => {
    assert.equal(parseRtkVersion("not a version"), undefined);
    assert.equal(parseRtkVersion(""), undefined);
  });

  it("拒绝溢出分量", () => {
    assert.equal(parseRtkVersion("rtk 1.2.999999999999"), undefined);
  });
});

describe("isRtkVersionSupported", () => {
  it("≥1.0.0 支持", () => {
    assert.equal(isRtkVersionSupported({ major: 1, minor: 0, patch: 0 }), true);
    assert.equal(isRtkVersionSupported({ major: 2, minor: 0, patch: 0 }), true);
  });

  it("0.x 不支持", () => {
    assert.equal(isRtkVersionSupported({ major: 0, minor: 99, patch: 9 }), false);
  });

  it("同主版本比次版本、同次版本比补丁", () => {
    assert.equal(isRtkVersionSupported({ major: 1, minor: 0, patch: 1 }), true);
    assert.equal(isRtkVersionSupported({ major: 1, minor: 0, patch: 0 }), true);
  });
});

describe("阈值同源", () => {
  it("下限阈值自洽（parse → format 回到原串）", () => {
    const parsed = parseRtkVersion(`rtk ${MIN_RTK_VERSION}`);
    assert.ok(parsed !== undefined);
    assert.equal(formatRtkVersion(parsed), MIN_RTK_VERSION);
  });

  it("格式化的三段都是十进制字面量（不含 e 记法）", () => {
    assert.equal(formatRtkVersion({ major: 10, minor: 0, patch: 3 }), "10.0.3");
  });
});

describe("probeRtkVersion", () => {
  it("拿到版本且支持", async () => {
    const probe = await probeRtkVersion(async () => "rtk 1.2.0");
    assert.ok(probe !== undefined);
    assert.equal(probe.raw, "rtk 1.2.0");
    assert.equal(formatRtkVersion(probe.version), "1.2.0");
    assert.equal(probe.supported, true);
  });

  it("版本过低 supported false（不是 undefined）", async () => {
    const probe = await probeRtkVersion(async () => "rtk 0.9.9");
    assert.ok(probe !== undefined);
    assert.equal(probe.supported, false);
  });

  it("读不到版本 undefined", async () => {
    // 用「查表未命中」表达「这一轮没有任何输出」：直接写 `async () => undefined`
    // 会被 unicorn/no-useless-undefined 判成多余字面量，而这里要表达的是一份空输出，
    // 不是「返回 undefined 这个动作」。
    const outputs = new Map<string, string>();
    assert.equal(await probeRtkVersion(async () => outputs.get("absent")), undefined);
  });

  it("输出读不懂 undefined", async () => {
    assert.equal(await probeRtkVersion(async () => "command not found"), undefined);
  });

  it("读取抛错 undefined（装配不许因此失败）", async () => {
    assert.equal(
      await probeRtkVersion(() => {
        throw new Error("ENOENT");
      }),
      undefined,
    );
  });
});
