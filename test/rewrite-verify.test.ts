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
/** 复合命令的两侧样例：多段校验那几条用例反复用同一对，抽出来免得撞 no-duplicate-string。 */
const CD_CARGO = "cd /tmp && cargo test";
const CD_RTK_CARGO = "cd /tmp && rtk cargo test";
const SCRIPT_STRIPPED = "script-runner-stripped";

describe("P1 必须以 rtk 开头", () => {
  it("rtk 被插进 wrapper 内部则拒", () => {
    // 实测形态：`uv run cargo test` 被改成 `uv run rtk cargo test`；wrapper 语义未知，统一拒绝。
    assert.equal(verifyRewrite(UV_RUN_CARGO_TEST, "uv run rtk cargo test"), NOT_PREFIXED);
    assert.equal(verifyRewrite("timeout 5 cargo test", "timeout 5 rtk cargo test"), NOT_PREFIXED);
    assert.equal(verifyRewrite("nice -n 5 cargo test", "nice -n 5 rtk cargo test"), NOT_PREFIXED);
    assert.equal(verifyRewrite("env FOO=1 cargo test", "env FOO=1 rtk cargo test"), NOT_PREFIXED);
  });

  it("链式命令按段校验：只前插了 rtk 的那一段通过，其余段必须原样", () => {
    // 早期版本在这里整条拒（rtk 把 `rtk ` 插在中间，P1 只认开头）。改判的理由：rtk 逐段改写
    // （discover/registry.rs 的 rewrite_compound），实测产物就是 `cd /tmp && rtk cargo test`——
    // 只有承载输出的那一段被换掉。§「复合命令按段校验」把这条形状收进合法面，安全性由
    // 「分隔符序列必须逐一相同 + 每段各自过 P1~P4」两条保证。
    assert.equal(verifyRewrite(CD_CARGO, CD_RTK_CARGO), undefined);
    // 动到没被改写的那一段 → 拒（点名第几段）。
    assert.equal(
      verifyRewrite(CD_CARGO, "cd /other && rtk cargo test"),
      "segment 0: not-rtk-prefixed",
    );
    // 换掉分隔符 → 拒（连接语义变了）。
    assert.equal(verifyRewrite(CD_CARGO, "cd /tmp ; rtk cargo test"), "separator-changed");
    // 段数变了（多一段 / 少一段）→ 拒。
    assert.equal(verifyRewrite(CD_CARGO, RTK_CARGO_TEST), "not-segmentable");
    assert.equal(verifyRewrite(CD_CARGO, `${CD_RTK_CARGO} && rtk ls`), "not-segmentable");
  });

  it("段本身已经是 rtk 形态时不再接受二次前插", () => {
    // `structuralReject` 只看整条命令的开头，所以 `cd a && rtk cargo test` 会在它那一关放行
    // （首词是 cd）。真正拦住「压两次」的是这里：第二段本来就是 rtk 形态，再前插一层就是
    // `rtk rtk cargo test`——在 P1~P4 眼里完全合法，只有这条段级判据能拒。
    assert.equal(
      verifyRewrite("cd a && rtk cargo test", "cd a && rtk rtk cargo test"),
      "segment 1: already-rtk",
    );
    assert.equal(verifyRewrite(RTK_CARGO_TEST, `rtk ${RTK_CARGO_TEST}`), "already-rtk");
  });

  it("每一段都必须自己通过 P1~P4", () => {
    // 第二段被塌缩成非前插形态（`npm run lint` → `lint`）→ 拒，且点名段号。
    assert.equal(
      verifyRewrite("cd a && npm run lint", "cd a && rtk lint"),
      "segment 1: script-runner-stripped",
    );
    // 第一段被前插 rtk、第二段原样：合法。
    assert.equal(
      verifyRewrite("cargo test && echo done", "rtk cargo test && echo done"),
      undefined,
    );
    // 管道同形。
    assert.equal(verifyRewrite("cargo test | tail -5", "rtk cargo test | tail -5"), undefined);
    // 第二段被换成「不是纯前插」的形态（`cat f` → `rtk read f`：rtk 会这么改，但读法变了）→ 拒。
    assert.equal(
      verifyRewrite("cargo test | cat f", "rtk cargo test | rtk read f"),
      "segment 1: not-a-suffix",
    );
    // 第二段纯前插同样合法（`tail -5` → `rtk tail -5` 只是多了前缀，语义没被换掉）。
    assert.equal(verifyRewrite("cargo test | tail -5", "rtk cargo test | rtk tail -5"), undefined);
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
    assert.equal(verifyRewrite("   cargo test", RTK_CARGO_TEST), undefined);
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
