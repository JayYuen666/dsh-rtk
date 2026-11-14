// lib/spill-read.ts 单测：从 tool-bash 回执里按 `stdout.spillPath` 读回被截断掉的全文。
//
// 这条路径只在一格成立：`stdout.truncated === true` 时，落在文件里的才是完整输出，
// 上下文里那段是**尾部**。压缩前必须拿全文，否则压的是残片。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readSpillFullText } from "../lib/spill-read.ts";

const FULL_PATH = "/spill/full";
const MISSING_PATH = "/missing";

/** 只有 FULL_PATH 读得出来的假文件系统。 */
const fs = {
  readFile: async (path: string) => {
    if (path === FULL_PATH) {
      return "FULL TEXT";
    }
    throw new Error("ENOENT");
  },
};

describe("readSpillFullText", () => {
  it("有 spillPath 时读全文", async () => {
    const full = await readSpillFullText(
      { kind: "foreground", stdout: { spillPath: FULL_PATH } },
      fs,
    );

    assert.equal(full, "FULL TEXT");
  });

  it("没有 spillPath 时 undefined", async () => {
    assert.equal(await readSpillFullText({ kind: "foreground", stdout: {} }, fs), undefined);
  });

  it("读失败时 undefined（不抛）", async () => {
    assert.equal(
      await readSpillFullText({ kind: "foreground", stdout: { spillPath: MISSING_PATH } }, fs),
      undefined,
    );
  });

  it("裸字符串回执 undefined", async () => {
    assert.equal(await readSpillFullText("text", fs), undefined);
  });

  it("background 形状 undefined", async () => {
    assert.equal(await readSpillFullText({ kind: "background" }, fs), undefined);
  });

  it("stdout 不是对象时 undefined", async () => {
    assert.equal(await readSpillFullText({ kind: "foreground", stdout: "x" }, fs), undefined);
  });

  it("spillPath 不是字符串时 undefined", async () => {
    assert.equal(
      await readSpillFullText({ kind: "foreground", stdout: { spillPath: 42 } }, fs),
      undefined,
    );
  });

  it("超过 10MiB 时拒绝读入（防把整包塞进上下文）", async () => {
    const oversized = "x".repeat(10 * 1024 * 1024 + 1);
    const huge = { readFile: async () => oversized };

    assert.equal(
      await readSpillFullText({ kind: "foreground", stdout: { spillPath: FULL_PATH } }, huge),
      undefined,
    );
  });

  it("恰好 10MiB 时仍然读入（上限是「大于」才拒）", async () => {
    const exact = "x".repeat(10 * 1024 * 1024);
    const huge = { readFile: async () => exact };

    const full = await readSpillFullText(
      { kind: "foreground", stdout: { spillPath: FULL_PATH } },
      huge,
    );

    assert.equal(full?.length, exact.length);
  });
});
