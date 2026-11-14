// lib/stdout-extract.ts 单测：从 tool-bash / tool-bash-persistent 的回执里拆出「可压缩的 stdout」，
// 并保证 stderr 段与退出码 marker 原样回填。
//
// 为什么要拆：`tool-bash` 的 `stdout.text` 是一条拼好的串——stdout 正文、`\n[stderr]\n` 前缀的
// stderr、最后一行退出码 marker。压缩只能动正文那一段。marker 尤其不能动：客户端用
// `parseExitStatus` 锚 `$` 解析它，挪走或改形就等于改了这条命令的退出状态。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { extractBody, reassemble } from "../lib/stdout-extract.ts";

const EXIT_101 = "[exit code: 101]";
const STDERR_LINE = "warning: x";
const STDOUT_BODY = "running 1 test\ntest result: FAILED";

/** tool-bash 前景回执的最小真实形状（字段取自 packages/shell/tool-bash 的 output schema）。 */
const STRUCT = {
  kind: "foreground",
  exitCode: 101,
  cwd: "/x",
  stdout: {
    text: `${STDOUT_BODY}\n[stderr]\n${STDERR_LINE}\n${EXIT_101}`,
    truncated: false,
    spillPath: undefined,
  },
  stderr: { text: STDERR_LINE },
};

/** 取回执里的 stdout.text；用例只关心这一格，抽出来省掉逐处 as。 */
function bodyOf(value: unknown): string {
  const record = value as { stdout: { text: string } };
  return record.stdout.text;
}

describe("extractBody 结构化", () => {
  it("拆 stdout / stderr / marker", () => {
    const extracted = extractBody(STRUCT);

    assert.ok(extracted);
    assert.equal(extracted.shape, "structured");
    assert.equal(extracted.marker, EXIT_101);
    assert.equal(extracted.stdout, STDOUT_BODY);
    assert.equal(extracted.stderr, STDERR_LINE);
    assert.equal(extracted.stdout.includes("[stderr]"), false);
  });

  it("background / promoted 形状不支持", () => {
    assert.equal(extractBody({ kind: "background" }), undefined);
    assert.equal(extractBody({ kind: "promoted" }), undefined);
  });

  it("没有 marker 时 marker 是空串", () => {
    const extracted = extractBody({ kind: "foreground", stdout: { text: "plain output" } });

    assert.ok(extracted);
    assert.equal(extracted.marker, "");
    assert.equal(extracted.stdout, "plain output");
  });

  it("marker 只在末尾才算（正文中间的方括号不是退出状态）", () => {
    // 正文里出现同样的串必须留在正文里：`$` 锚掉了才不会被误切。
    const extracted = extractBody({
      kind: "foreground",
      stdout: { text: `log says ${EXIT_101} happened\nkept line` },
    });

    assert.ok(extracted);
    assert.equal(extracted.marker, "");
    assert.equal(extracted.stdout, `log says ${EXIT_101} happened\nkept line`);
  });

  it("marker 出现在行首但不是末行时不算（锚的是结尾）", () => {
    // 只锚「行首」而不锚「结尾」就会在这里误切：正文被截断，「more output」整段丢掉。
    const extracted = extractBody({
      kind: "foreground",
      stdout: { text: `${EXIT_101}\nmore output` },
    });

    assert.ok(extracted);
    assert.equal(extracted.marker, "");
    assert.equal(extracted.stdout, `${EXIT_101}\nmore output`);
  });

  it("stdout 不是对象时 undefined", () => {
    assert.equal(extractBody({ kind: "foreground", stdout: "text" }), undefined);
  });

  it("stdout.text 不是字符串时 undefined", () => {
    assert.equal(extractBody({ kind: "foreground", stdout: { text: 42 } }), undefined);
  });
});

describe("extractBody 裸字符串（持久 shell 的回执）", () => {
  it("切出持久 shell 的 marker", () => {
    const extracted = extractBody("body line\n[Command finished with exit code 3]");

    assert.ok(extracted);
    assert.equal(extracted.shape, "string");
    assert.equal(extracted.marker, "[Command finished with exit code 3]");
    assert.equal(extracted.stdout, "body line");
  });

  it("没有 marker 的裸字符串整段就是正文", () => {
    const extracted = extractBody("body line");

    assert.ok(extracted);
    assert.equal(extracted.marker, "");
    assert.equal(extracted.stdout, "body line");
  });

  it("非字符串非对象 undefined", () => {
    assert.equal(extractBody(42), undefined);
    assert.equal(extractBody(null), undefined);
    assert.equal(extractBody(undefined), undefined);
  });
});

describe("reassemble", () => {
  it("结构化回执只换 stdout.text，其余字段不动", () => {
    const extracted = extractBody(STRUCT);
    assert.ok(extracted);

    const text = bodyOf(reassemble(extracted, "cargo test: 1 failed"));

    assert.equal(text, `cargo test: 1 failed\n[stderr]\n${STDERR_LINE}\n${EXIT_101}`);
  });

  it("退出码与 cwd 等字段原样保留", () => {
    const extracted = extractBody(STRUCT);
    assert.ok(extracted);

    const rebuilt = reassemble(extracted, "compressed") as typeof STRUCT;

    assert.equal(rebuilt.exitCode, 101);
    assert.equal(rebuilt.cwd, "/x");
    assert.equal(rebuilt.stdout.truncated, false);
  });

  it("没有 stderr 段时不插 [stderr]", () => {
    const extracted = extractBody({ kind: "foreground", stdout: { text: "out\n[exit code: 0]" } });
    assert.ok(extracted);

    const text = bodyOf(reassemble(extracted, "compressed"));

    assert.equal(text, "compressed\n[exit code: 0]");
  });

  it("裸字符串的 marker 补在末行", () => {
    const extracted = extractBody("body\n[Command finished with exit code 3]");
    assert.ok(extracted);

    assert.equal(
      reassemble(extracted, "compressed"),
      "compressed\n[Command finished with exit code 3]",
    );
  });

  it("裸字符串没有 marker 时原样返回压缩结果", () => {
    const extracted = extractBody("body");
    assert.ok(extracted);

    assert.equal(reassemble(extracted, "compressed"), "compressed");
  });

  it("truncated 与 spillPath 都保留", () => {
    const extracted = extractBody({
      kind: "foreground",
      stdout: { text: "out", truncated: true, spillPath: "/spill/x" },
    });
    assert.ok(extracted);

    const rebuilt = reassemble(extracted, "c") as {
      stdout: { truncated: boolean; spillPath: string };
    };

    assert.equal(rebuilt.stdout.truncated, true);
    assert.equal(rebuilt.stdout.spillPath, "/spill/x");
  });

  it("手搓的 Extracted 缺 value 时不崩（reassemble 必须是全函数）", () => {
    // 契约上 `value` 是可选的；调用方只拿到拆解结果、丢了原始对象时也要能拼出一条文本。
    const bare = { shape: "structured" as const, stdout: "x", stderr: "", marker: "", raw: "x" };

    assert.deepEqual(reassemble(bare, "c"), { stdout: { text: "c" } });
  });

  it("value.stdout 不是对象时也能拼（脏形状不抛）", () => {
    const dirty = {
      shape: "structured" as const,
      stdout: "x",
      stderr: "",
      marker: "",
      raw: "x",
      value: { kind: "foreground", stdout: "not-a-record" },
    };

    assert.deepEqual(reassemble(dirty, "c"), {
      kind: "foreground",
      stdout: { text: "c" },
    });
  });

  it("marker 是超时形态时也原样回填", () => {
    const extracted = extractBody({
      kind: "foreground",
      stdout: { text: "partial\n[stderr]\nboom\n[timed out after 5000ms]" },
    });
    assert.ok(extracted);

    const text = bodyOf(reassemble(extracted, "compressed"));

    assert.equal(text, "compressed\n[stderr]\nboom\n[timed out after 5000ms]");
  });

  it("marker 是被信号杀掉的形态时也原样回填", () => {
    const extracted = extractBody({
      kind: "foreground",
      stdout: { text: "partial\n[killed by signal: SIGTERM]" },
    });
    assert.ok(extracted);

    assert.equal(
      bodyOf(reassemble(extracted, "compressed")),
      "compressed\n[killed by signal: SIGTERM]",
    );
  });
});
