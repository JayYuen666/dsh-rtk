// lib/warn-hint.ts 单测：只在「确实没有警告」时补提示，且必须落在退出 marker 之前。
//
// 这一层不修 rtk（插件改不了它），只如实告知信息损失：`rtk cargo test` 会吞掉编译警告，
// 模型需要知道「要看警告得跑 cargo build / cargo check」。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isCargoTest, appendWarnHint } from "../lib/warn-hint.ts";

const HINT = "[rtk] cargo test 前缀不保留编译警告；需要看警告请直接跑 cargo build / cargo check";
const EXIT_ZERO = "[exit code: 0]";
const fg = (text: string): Record<string, unknown> => ({
  kind: "foreground",
  exitCode: 0,
  stdout: { text },
});

describe("isCargoTest", () => {
  it("命中三种写法", () => {
    assert.equal(isCargoTest("cargo test"), true);
    assert.equal(isCargoTest("cargo test --lib"), true);
    assert.equal(isCargoTest("  cargo   test  "), true);
  });

  it("不命中其它 cargo 子命令与近似词", () => {
    assert.equal(isCargoTest("cargo build"), false);
    assert.equal(isCargoTest("cargo testing"), false);
    assert.equal(isCargoTest("cargotest"), false);
    assert.equal(isCargoTest(""), false);
  });
});

describe("appendWarnHint", () => {
  it("无 warning 时插在 marker 之前，exitCode 不动", () => {
    const base = `running 1 test\ntest result: ok. 1 passed\n${EXIT_ZERO}`;
    const out = appendWarnHint(fg(base), HINT) as { exitCode: number; stdout: { text: string } };
    assert.equal(out.exitCode, 0);
    // 提示必须在 marker 之前：marker 是客户端解析退出状态的锚点，落在它后面就等于没被解析。
    assert.ok(out.stdout.text.indexOf(HINT) < out.stdout.text.indexOf(EXIT_ZERO));
    assert.ok(out.stdout.text.endsWith(EXIT_ZERO));
  });

  it("无 marker 时追加在末尾", () => {
    const out = appendWarnHint(fg("running 1 test\ntest result: ok."), HINT) as {
      stdout: { text: string };
    };
    assert.ok(out.stdout.text.endsWith(`\n${HINT}`));
  });

  it("已有 warning 时不加（否则是噪音）", () => {
    const value = fg(`warning: unused import\n${EXIT_ZERO}`);
    assert.deepEqual(appendWarnHint(value, HINT), value);
  });

  it("已有 error 时不加", () => {
    const value = fg("error[E0308]: mismatched types\n[exit code: 101]");
    assert.deepEqual(appendWarnHint(value, HINT), value);
  });

  it("非结构化 / background 原样返回", () => {
    assert.equal(appendWarnHint("raw string", HINT), "raw string");
    assert.deepEqual(appendWarnHint({ kind: "background", jobId: "j1" }, HINT), {
      kind: "background",
      jobId: "j1",
    });
    assert.deepEqual(appendWarnHint({ kind: "foreground", stdout: "text" }, HINT), {
      kind: "foreground",
      stdout: "text",
    });
    assert.equal(appendWarnHint(undefined, HINT), undefined);
    assert.deepEqual(appendWarnHint({ kind: "foreground", stdout: {} }, HINT), {
      kind: "foreground",
      stdout: {},
    });
  });

  it("空 stdout 直接给提示（没有多余换行）", () => {
    const out = appendWarnHint(fg(""), HINT) as { stdout: { text: string } };
    assert.equal(out.stdout.text, HINT);
  });

  it("只改 stdout.text，其余字段保留", () => {
    const value = {
      kind: "foreground",
      exitCode: 101,
      cwd: "/x",
      stdout: { text: `test result: FAILED\n[exit code: 101]`, truncated: false, spillPath: "/s" },
      stderr: { text: "note: in /x" },
    };
    const out = appendWarnHint(value, HINT) as Record<string, unknown> & {
      stdout: Record<string, unknown>;
    };
    assert.equal(out["exitCode"], 101);
    assert.equal(out["cwd"], "/x");
    assert.equal(out.stdout["truncated"], false);
    assert.equal(out.stdout["spillPath"], "/s");
    assert.deepEqual(out["stderr"], { text: "note: in /x" });
  });
});
