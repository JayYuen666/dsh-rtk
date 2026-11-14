// lib/rewrite.ts 单测：退出码协议（0/3 改写、1 无改写、2 deny、其余原样）+ 结论缓存 + cwd 进 key。
//
// 退出码是这一层唯一的真相：`rtk rewrite` 用退出码表达「有没有等价改写」，用 stdout 表达
// 「改写是什么」。翻译成 `RewriteAttempt` 之后，上层只看到「改写后的命令」或「原样 + 原因」。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRewriter } from "../lib/rewrite.ts";
import { createRewriteCache } from "../lib/rewrite-cache.ts";

/** 一个 `rtk rewrite` 的假回执；`undefined` = spawn 没起来，`Error` = spawn 抛错。 */
type FakeResult = { exitCode: number | null; stdout: string } | undefined | Error;

// 三个高频字面量提到模块级：`sonarjs(no-duplicate-string)` 在第四次出现时判红。
const CARGO_TEST = "cargo test";
const CARGO_BUILD = "cargo build";
const REWRITTEN_CARGO_TEST = "rtk cargo test";

/** 造一条按序返回 `results` 的改写器；记录每次 spawn 收到的命令。 */
function harness(
  results: readonly FakeResult[],
  cwd = "/tmp/proj",
): { calls: string[]; rewrite: (command: string) => Promise<unknown> } {
  const calls: string[] = [];
  let cursor = 0;
  const rewriter = createRewriter({
    cwd,
    runRewrite: async (command) => {
      calls.push(command);
      const next = results[cursor];
      cursor += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    cache: createRewriteCache(8),
  });
  return {
    calls,
    rewrite: (command: string) => rewriter(command, new AbortController().signal),
  };
}

describe("退出码协议", () => {
  it("rc=3 改写（stdout 去尾空白）", async () => {
    const testHarness = harness([{ exitCode: 3, stdout: "rtk pytest -q" }]);
    assert.deepEqual(await testHarness.rewrite("python -m pytest -q"), {
      kind: "rewritten",
      command: "rtk pytest -q",
    });
  });

  it("rc=0 也是改写（用户 allow 规则时 rtk 回 0）", async () => {
    const testHarness = harness([{ exitCode: 0, stdout: "rtk cargo test\n" }]);
    assert.deepEqual(await testHarness.rewrite(CARGO_TEST), {
      kind: "rewritten",
      command: REWRITTEN_CARGO_TEST,
    });
  });

  it("rc=1 无等价改写则原样", async () => {
    const testHarness = harness([{ exitCode: 1, stdout: "" }]);
    assert.deepEqual(await testHarness.rewrite("fd ."), {
      kind: "original",
      reason: "no-rewrite",
    });
  });

  it("rc=2 deny（~/.claude 的 deny 规则）则原样", async () => {
    // 本机 `~/.claude/settings.json` 真实存在，插件绝不能因为别人的 deny 规则把命令拦下来——
    // 最多是「这条不压了」。所以 rc=2 与 rc=1 同等对待。
    const testHarness = harness([{ exitCode: 2, stdout: "" }]);
    assert.deepEqual(await testHarness.rewrite(CARGO_TEST), {
      kind: "original",
      reason: "denied",
    });
  });

  it("其它退出码则原样（原因带码）", async () => {
    const testHarness = harness([{ exitCode: 7, stdout: "junk" }]);
    assert.deepEqual(await testHarness.rewrite(CARGO_TEST), {
      kind: "original",
      reason: "exit-7",
    });
  });

  it("stdout 空则原样（空串绝不是改写）", async () => {
    const testHarness = harness([
      { exitCode: 3, stdout: "" },
      { exitCode: 3, stdout: "   \n" },
    ]);
    assert.deepEqual(await testHarness.rewrite(CARGO_TEST), {
      kind: "original",
      reason: "empty-stdout",
    });
    assert.deepEqual(await testHarness.rewrite(CARGO_BUILD), {
      kind: "original",
      reason: "empty-stdout",
    });
  });

  it("超时（没有退出码）则原样", async () => {
    const testHarness = harness([{ exitCode: null, stdout: "" }]);
    assert.deepEqual(await testHarness.rewrite(CARGO_TEST), {
      kind: "original",
      reason: "timeout",
    });
  });

  it("spawn 失败（undefined / 抛错）则原样", async () => {
    const testHarness = harness([undefined, new Error("ENOENT")]);
    assert.deepEqual(await testHarness.rewrite(CARGO_TEST), {
      kind: "original",
      reason: "spawn-failed",
    });
    assert.deepEqual(await testHarness.rewrite(CARGO_BUILD), {
      kind: "original",
      reason: "spawn-failed",
    });
  });
});

describe("缓存", () => {
  it("同一命令只 spawn 一次", async () => {
    const testHarness = harness([{ exitCode: 3, stdout: REWRITTEN_CARGO_TEST }]);
    await testHarness.rewrite(CARGO_TEST);
    await testHarness.rewrite(CARGO_TEST);
    assert.deepEqual(testHarness.calls, [CARGO_TEST]);
  });

  it("「原样」结论也缓存（坏命令不反复 spawn）", async () => {
    const testHarness = harness([{ exitCode: 1, stdout: "" }]);
    await testHarness.rewrite("fd .");
    await testHarness.rewrite("fd .");
    assert.equal(testHarness.calls.length, 1);
  });

  it("超时与 spawn 失败不进缓存（属环境瞬时态）", async () => {
    // 一次抖动不该让该命令在整个会话里都拿不到改写：这两条结论不写缓存，下次重试。
    const testHarness = harness([
      { exitCode: null, stdout: "" },
      { exitCode: 3, stdout: REWRITTEN_CARGO_TEST },
      new Error("boom"),
      { exitCode: 3, stdout: "rtk cargo build" },
    ]);
    assert.equal(((await testHarness.rewrite(CARGO_TEST)) as { kind: string }).kind, "original");
    assert.deepEqual(await testHarness.rewrite(CARGO_TEST), {
      kind: "rewritten",
      command: REWRITTEN_CARGO_TEST,
    });
    assert.equal(((await testHarness.rewrite(CARGO_BUILD)) as { kind: string }).kind, "original");
    assert.deepEqual(await testHarness.rewrite(CARGO_BUILD), {
      kind: "rewritten",
      command: "rtk cargo build",
    });
  });
});

describe("缓存 key 含 cwd", () => {
  it("同一条命令在两个仓各 spawn 一次，结论不互相污染", async () => {
    // 实测（/tmp/cwdtest）：proj/.claude/settings.json 里 deny 了 `cargo test` 时，
    //   cd proj  && rtk rewrite 'cargo test' → rc=2（无输出）
    //   cd other && rtk rewrite 'cargo test' → rc=3 REWRITTEN_CARGO_TEST
    // 退出码是 cwd 的函数，所以它们必须是两个缓存条目。
    const cache = createRewriteCache(8);
    const calls: string[] = [];
    const make = (
      cwd: string,
      exitCode: number,
    ): ((command: string, signal: AbortSignal) => Promise<unknown>) =>
      createRewriter({
        cwd,
        runRewrite: async (command) => {
          calls.push(`${cwd}::${command}`);
          return exitCode === 3
            ? { exitCode, stdout: REWRITTEN_CARGO_TEST }
            : { exitCode, stdout: "" };
        },
        cache,
      });
    const denied = make("/tmp/proj", 2);
    const allowed = make("/tmp/other", 3);
    const { signal } = new AbortController();
    assert.deepEqual(await denied(CARGO_TEST, signal), {
      kind: "original",
      reason: "denied",
    });
    assert.deepEqual(await allowed(CARGO_TEST, signal), {
      kind: "rewritten",
      command: REWRITTEN_CARGO_TEST,
    });
    // 回到被 deny 的仓再问一次：必须仍是它自己的结论，不能被另一个仓的改写覆盖。
    assert.deepEqual(await denied(CARGO_TEST, signal), {
      kind: "original",
      reason: "denied",
    });
    assert.equal(calls.length, 2);
  });
});
