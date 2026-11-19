// lib/output-window.ts 单测：日志目标的判定与头尾窗口的形状。
//
// 两条独立性是这一层的全部价值，所以各有一组用例：
//   1. 「是不是日志」由**命令 × 目标**两条证据决定，不是「文件很大」——源码扩展名一律不动；
//   2. 「窗口」只在总行数超过头尾之和时发生，且省略行数要能对账（头 + 标记 + 尾 = 结果）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  DEFAULT_WINDOW_HEAD_LINES,
  DEFAULT_WINDOW_TAIL_LINES,
  isLogTarget,
  isReadingTarget,
  windowOf,
} from "../lib/output-window.ts";

describe("isLogTarget：自带日志语义的命令", () => {
  it("输出形态由命令决定的那几条，与操作数无关", () => {
    for (const command of [
      "journalctl -u nginx",
      "dmesg",
      "docker logs my-container",
      "kubectl logs pod-a",
      "ps aux",
    ]) {
      assert.equal(isLogTarget(command), true, command);
    }
  });
});

describe("isLogTarget：读文件的命令按目标判", () => {
  it("tail / head / less / zcat 读到日志文件时命中", () => {
    for (const command of [
      "tail -n 100 build.log",
      "head -50 app.log",
      "less /var/log/system.log",
      "zcat archive.log.gz.gz",
      "   tail -f app.log",
    ]) {
      assert.equal(isLogTarget(command), true, command);
    }
  });

  it("同几条命令读到源码时一个都不命中（这是模型的阅读材料，不是日志）", () => {
    for (const command of [
      "tail -n 100 src/app.ts",
      "head -50 README.md",
      "less lib/guard.ts",
      "more docs/DETAIL.zh.md",
      "zcat src/main.go.gz",
    ]) {
      assert.equal(isLogTarget(command), false, command);
    }
  });

  it("cat 的日志类扩展名命中（含 `.log.1` 这种轮转形态）", () => {
    for (const command of [
      "cat build.log",
      "cat -n build.log",
      "cat build.log | head",
      "cat events.jsonl",
      "cat run.ndjson",
      "cat crash.trace",
      "cat heap.dump",
      "cat app.log.1",
    ]) {
      assert.equal(isLogTarget(command), true, command);
    }
  });

  it("cat 读 `.txt` / 源码扩展名一律不命中（`.txt` 常常是要逐字读的报告与正文）", () => {
    for (const command of [
      "cat dist/out.txt",
      "cat coverage/rust-summary.txt",
      "cat notes.txt",
      "cat src/app.ts",
      "cat lib/guard.py",
      "cat main.go",
      "cat Cargo.toml",
      "cat package.json",
      "cat README.md",
      "cat Makefile",
    ]) {
      assert.equal(isLogTarget(command), false, command);
    }
  });

  it("cat 带多个操作数时任意一个命中就算", () => {
    assert.equal(isLogTarget("cat src/app.ts build.log"), true);
  });

  it("不是 cat、不是日志查看器的命令一律不动", () => {
    for (const command of [
      "cargo test",
      "git diff",
      "grep -rn foo .",
      "python3 script.py",
      "echo hi",
    ]) {
      assert.equal(isLogTarget(command), false, command);
    }
  });
});

describe("isReadingTarget：模型的阅读材料", () => {
  it("读文件的命令 + 目标不是日志 = 阅读材料（两条压缩路都不该碰）", () => {
    for (const command of [
      "cat src/app.ts",
      "cat notes.txt",
      "cat README.md",
      "cat package.json",
      "head -1000 src/app.ts",
      "tail -500 lib/guard.ts",
      "less docs/DETAIL.zh.md",
      "more Cargo.toml",
      "zcat src/main.go.gz",
    ]) {
      assert.equal(isReadingTarget(command), true, command);
      // 同一把尺子的两面：阅读材料一定不是日志目标，否则两条路会给同一份输出打架。
      assert.equal(isLogTarget(command), false, command);
    }
  });

  it("读日志不是阅读材料（日志可以走清理链与窗口）", () => {
    for (const command of ["cat build.log", "tail -100 app.log", "head -50 /var/log/system.log"]) {
      assert.equal(isReadingTarget(command), false, command);
    }
  });

  it("非读文件的命令不算阅读材料（`ps` / 构建脚本都该能被压）", () => {
    for (const command of [
      "ps aux",
      "journalctl -u nginx",
      "./scripts/build.sh",
      "make",
      "cargo test",
    ]) {
      assert.equal(isReadingTarget(command), false, command);
    }
  });
});

describe("复合命令：按段判，不按首词判", () => {
  // 缺陷的形状：两个判据都只取整条命令的**首词**，于是 `cd X && cat build.log` 的首词是
  // `cd`——既不算日志也不算阅读材料，两条压缩路一起放过它。日志那份白丢一次窗口机会
  // （实测 55,213 B 的日志一个字没压），阅读材料那份更糟：`cd X && cat src/app.ts` 因为
  // 「既不是日志也不是阅读材料」而落进清理链，`dedup` 把连续 200 行相同折成 `[x200]`
  // （实测 8,044 B 源码 → 360 B），模型读到的是残件——这正是「阅读材料一律不碰」那条
  // 硬规矩要防的形状，而它在复合命令上从来没生效过。
  it("日志在后一段时命中（`cd X && cat build.log` 该被窗口化）", () => {
    for (const command of [
      "cd /tmp && cat build.log",
      "cd /tmp/win-probe && cat build.log",
      "cd /tmp; cat build.log",
      "make 2>&1 && cat out.log",
      "cd /repo && tail -100 app.log",
    ]) {
      assert.equal(isLogTarget(command), true, command);
      assert.equal(isReadingTarget(command), false, command);
    }
  });

  it("阅读材料在后一段时命中（`cd X && cat src/app.ts` 一个字都不许动）", () => {
    for (const command of [
      "cd /tmp && cat src/app.ts",
      "cd /repo && head -1000 lib/guard.ts",
      "cd /tmp; cat notes.txt",
      "cd /repo && cat README.md",
    ]) {
      assert.equal(isReadingTarget(command), true, command);
      assert.equal(isLogTarget(command), false, command);
    }
  });

  it("日志与阅读材料同时出现时按日志算（这条不改变今天的行为）", () => {
    // `cat src/app.ts && cat build.log` 在改动前就是 log=true（首词是 cat、操作数里有
    // `build.log`），改动后仍是 log=true（后一段是日志）。有日志可压时压日志，是既有裁决。
    assert.equal(isLogTarget("cat src/app.ts && cat build.log"), true);
    assert.equal(isReadingTarget("cat src/app.ts && cat build.log"), false);
  });

  it("拆不开的命令退回按整条判（命令替换、重定向、后台执行）", () => {
    // `splitCommand` 对这些形状返回 undefined，调用方按整条当一段——保守方向不能反过来：
    // 判不出来时宁可不动手，也不能把一段未知语义命令当日志压掉。
    assert.equal(isLogTarget("cat build.log > out.txt"), true);
    assert.equal(isReadingTarget("cat build.log > out.txt"), false);
    assert.equal(isLogTarget("cd $(pwd) && cat build.log"), false);
    assert.equal(isReadingTarget("cd $(pwd) && cat build.log"), false);
  });

  it("整条都是别的命令时仍然两条路都不接（`cd X && ls -la`）", () => {
    assert.equal(isLogTarget("cd /tmp && ls -la"), false);
    assert.equal(isReadingTarget("cd /tmp && ls -la"), false);
  });
});

/** 造 `count` 行文本，行内容 `line N`（提到模块级：每次 describe 重建一份是纯浪费）。 */
const linesOf = (count: number): string =>
  Array.from({ length: count }, (_unused, index) => `line ${String(index)}`).join("\n");

describe("windowOf 的形状", () => {
  it("总行数不超过头尾之和时不动手（返回 undefined，不是等长副本）", () => {
    assert.equal(windowOf(linesOf(250), 50, 200), undefined);
    assert.equal(windowOf(linesOf(10), 50, 200), undefined);
  });

  it("超出的部分换成一行省略标记，头尾都保留", () => {
    const result = windowOf(linesOf(1000), 3, 4);
    assert.notEqual(result, undefined);
    const kept = result?.text.split("\n") ?? [];
    assert.deepEqual(kept.slice(0, 3), ["line 0", "line 1", "line 2"]);
    assert.equal(kept[3], "[+993 lines omitted]");
    assert.deepEqual(kept.slice(4), ["line 996", "line 997", "line 998", "line 999"]);
    assert.equal(result?.omitted, 993);
  });

  it("头 + 标记 + 尾恰好等于保留行数（省略量能对账）", () => {
    const total = 500;
    const result = windowOf(linesOf(total), DEFAULT_WINDOW_HEAD_LINES, DEFAULT_WINDOW_TAIL_LINES);
    const kept = (result?.text ?? "").split("\n");
    assert.equal(kept.length, DEFAULT_WINDOW_HEAD_LINES + 1 + DEFAULT_WINDOW_TAIL_LINES);
    assert.equal(result?.omitted, total - DEFAULT_WINDOW_HEAD_LINES - DEFAULT_WINDOW_TAIL_LINES);
  });

  it("原文本末尾有没有换行，结果跟着保持一致", () => {
    const withNewline = windowOf(`${linesOf(300)}\n`, 2, 2);
    assert.equal(withNewline?.text.endsWith("\n"), true);
    const withoutNewline = windowOf(linesOf(300), 2, 2);
    assert.equal(withoutNewline?.text.endsWith("\n"), false);
  });

  it("尾部保留 0 行时只留头 + 标记", () => {
    const result = windowOf(linesOf(100), 2, 0);
    assert.deepEqual(result?.text.split("\n"), ["line 0", "line 1", "[+98 lines omitted]"]);
  });

  it("不合法入参不窗口化（负行数、头尾都为 0）", () => {
    assert.equal(windowOf(linesOf(1000), -1, 200), undefined);
    assert.equal(windowOf(linesOf(1000), 50, -1), undefined);
    assert.equal(windowOf(linesOf(1000), 0, 0), undefined);
  });
});
