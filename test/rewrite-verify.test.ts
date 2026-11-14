// lib/rewrite-verify.ts 单测：P1~P4 四道后置校验，逐条有用例，任何一条判据被删掉都要变红。
//
// 为什么不能只信 rtk 的退出码：rc=3 只说明「有等价改写」，不说明改写对插件无损。实测反例两类——
// 把 rtk 插进 wrapper 内部（`uv run rtk cargo test`），以及把 `npm run lint` 塌缩成 `rtk lint`
// （用户脚本完全不跑、无 eslint 时仍 rc=0 伪造成功）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { verifyRewrite } from "../lib/rewrite-verify.ts";

/** 拒绝原因：P1。 */
const NOT_PREFIXED = "not-rtk-prefixed";
/** 拒绝原因：P3（只许剥前缀）。 */
const NOT_A_SUFFIX = "not-a-suffix";

/** 被复用最多的那几条命令/原因：一处改名，全部断言跟着走。 */
const CARGO_TEST = "cargo test";
const UV_RUN_CARGO_TEST = "uv run cargo test";
const RTK_CARGO_TEST = "rtk cargo test";
const SCRIPT_STRIPPED = "script-runner-stripped";

describe("P1 必须以 rtk 开头", () => {
  it("rtk 被插进 wrapper 内部则拒", () => {
    // 实测形态：`uv run cargo test` 被改成 `uv run rtk cargo test`；wrapper 语义未知，统一拒绝。
    assert.equal(verifyRewrite(UV_RUN_CARGO_TEST, "uv run rtk cargo test"), NOT_PREFIXED);
    assert.equal(verifyRewrite("timeout 5 cargo test", "timeout 5 rtk cargo test"), NOT_PREFIXED);
    assert.equal(verifyRewrite("nice -n 5 cargo test", "nice -n 5 rtk cargo test"), NOT_PREFIXED);
    assert.equal(verifyRewrite("env FOO=1 cargo test", "env FOO=1 rtk cargo test"), NOT_PREFIXED);
  });

  it("链式命令的改写也拒（设计内）", () => {
    // 实测 `rtk rewrite 'cd /tmp && cargo test'` 的产物是 `cd /tmp && rtk cargo test`——rtk 插在中间。
    // 链式命令每一段的语义插件都不判，原样执行最安全，所以这里拒绝是正确行为，不是缺陷。
    assert.equal(verifyRewrite("cd /tmp && cargo test", "cd /tmp && rtk cargo test"), NOT_PREFIXED);
  });

  it("rtk 开头通过 P1", () => {
    assert.equal(verifyRewrite(CARGO_TEST, RTK_CARGO_TEST), undefined);
  });
});

describe("P2 rest 非空", () => {
  it("只有 rtk 或 rtk 后纯空白则拒", () => {
    assert.equal(verifyRewrite(CARGO_TEST, "rtk "), "empty-rest");
    assert.equal(verifyRewrite(CARGO_TEST, "rtk    "), "empty-rest");
  });
});

describe("P3 只许剥前缀", () => {
  it("剥 wrapper 通过", () => {
    assert.equal(verifyRewrite("python -m pytest -q", "rtk pytest -q"), undefined);
    assert.equal(verifyRewrite("python3 -m pytest", "rtk pytest"), undefined);
    assert.equal(verifyRewrite("npx tsc --noEmit", "rtk tsc --noEmit"), undefined);
    assert.equal(verifyRewrite("bundle exec rspec", "rtk rspec"), undefined);
    assert.equal(verifyRewrite("cargo build", "rtk cargo build"), undefined);
    // 前插 pnpm：剥掉的前缀为空串，P4 不适用。
    assert.equal(verifyRewrite("pnpm run build", "rtk pnpm run build"), undefined);
  });

  it("增删参数则拒", () => {
    assert.equal(verifyRewrite("cat f", "rtk read f"), NOT_A_SUFFIX);
    assert.equal(verifyRewrite("head -3 f", "rtk read f --head-lines 3"), NOT_A_SUFFIX);
    assert.equal(verifyRewrite("tail -3 f", "rtk read f --tail-lines 3"), NOT_A_SUFFIX);
    assert.equal(
      verifyRewrite("eslint src --format json", "rtk lint src --format json"),
      NOT_A_SUFFIX,
    );
    assert.equal(verifyRewrite("biome check .", "rtk lint check ."), NOT_A_SUFFIX);
  });

  it("改写把尾部参数删掉时拒（判据必须是后缀，不是包含）", () => {
    // 这一格专门钉 `endsWith` 与 `includes` 的差别，用的是**能让两者分叉**的那一对：
    // 原命令 `cargo build extra` 里*包含* `build`，且切掉末尾 5 个字符后正好停在空白上
    // （`cargo build `）——所以写成 `includes` 时 P3 会放行，等于允许「悄悄删掉尾参数」。
    // 真实形态就是 rtk 把 `npm run lint` 塌缩成 `rtk lint` 这一类（尾词被吃掉）。
    assert.equal(verifyRewrite("cargo build extra", "rtk build"), NOT_A_SUFFIX);
  });

  it("词边界：工具名被换掉、参数逐字符相同则拒", () => {
    // 与上一组是两种形态：那条参数也变了（`src --format json` ≠ `src`），这条参数一位没动、
    // 只有工具名从 `eslint` 换成 `lint`。少了词边界判据时它会以「剥掉前缀」的名义被放行，
    // 而 `rtk lint` 正是那个会伪造成功的过滤器。
    assert.equal(verifyRewrite("eslint src", "rtk lint src"), NOT_A_SUFFIX);
  });

  it("词边界反例：前缀确实以空白结尾则放行", () => {
    // 实测 `rtk rewrite 'pnpm exec tsc --noEmit'` → `rtk tsc --noEmit`，剥掉的是 `pnpm exec `。
    assert.equal(verifyRewrite("pnpm exec tsc --noEmit", "rtk tsc --noEmit"), undefined);
  });

  it("原命令前导空白被容忍", () => {
    assert.equal(verifyRewrite("   cargo test", "rtk cargo test"), undefined);
  });
});

describe("P4 被剥前缀不得含脚本运行词", () => {
  it("npm run 脚本被塌缩则拒（最危险的官方坏改写）", () => {
    // 实测后果：用户脚本完全不跑、转去跑 ESLint，无 eslint 时仍 rc=0 伪造成功。
    assert.equal(verifyRewrite("npm run lint", "rtk lint"), SCRIPT_STRIPPED);
    assert.equal(verifyRewrite("pnpm run test", "rtk test"), SCRIPT_STRIPPED);
    assert.equal(verifyRewrite("yarn run-script build", "rtk build"), SCRIPT_STRIPPED);
    assert.equal(verifyRewrite("bun run dev", "rtk dev"), SCRIPT_STRIPPED);
  });

  it("白名单 wrapper 含 run 词时放行（uv run）", () => {
    assert.equal(verifyRewrite(UV_RUN_CARGO_TEST, RTK_CARGO_TEST), undefined);
  });

  it("白名单不影响不含 run 词的具名 wrapper（bin/）", () => {
    // 防有人把白名单与 SCRIPT_RUNNER 写成 if / else if：那样这条也绿，但白名单一旦短路就
    // 再没有独立判据了。这条钉住「两条判据各自成立」。
    assert.equal(verifyRewrite("bin/rspec spec", "rtk rspec spec"), undefined);
  });

  it("前插式改写没有剥前缀则放行", () => {
    assert.equal(verifyRewrite("npm run build", "rtk npm run build"), undefined);
  });
});

describe("判据次序", () => {
  it("P1 先于 P3（不前缀就绝不看后缀）", () => {
    assert.equal(verifyRewrite(UV_RUN_CARGO_TEST, "rtk uv run cargo test "), undefined);
  });

  it("空改写走 P1（缺尾随空白就不是 rtk 前缀）", () => {
    assert.equal(verifyRewrite("x", "rtk"), NOT_PREFIXED);
  });
});
