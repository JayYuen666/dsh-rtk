// lib/command-family.ts 单测：统计按「哪个工具的哪个子命令」聚合。
//
// 关键事实：插件刻意不存完整命令（README 的隐私口径），所以聚合键只能是家族这一层。
// 归一必须保守——认不出就只留首词，不能靠猜参数语义；猜错了没有读者能验证。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  commandFamilyOf,
  hasRtkFront,
  isTransparentPrefix,
  rewrittenFamilies,
  rtkFrontOf,
  rtkRemainder,
} from "../lib/command-family.ts";

/** 期望值里反复出现的几条命令原文（独立写死，不从被测实现推导）。 */
const CARGO_TEST = "cargo test";
const PNPM_RUN_BUILD = "pnpm run build";
const GIT_STATUS = "git status";
const CD_CARGO = "cd /tmp && cargo test";
const RTK_CARGO = "rtk cargo test";
const GIT_LOG = "git log";
const RTK_GIT_LOG = "rtk git log";
const ENV_RTK_GIT_LOG = "env FOO=1 rtk git log";

describe("commandFamilyOf", () => {
  it("已知工具取两词", () => {
    assert.equal(commandFamilyOf(`${CARGO_TEST} -- --nocapture`), CARGO_TEST);
    assert.equal(commandFamilyOf(`${GIT_STATUS} --short`), GIT_STATUS);
    assert.equal(commandFamilyOf("go build ./..."), "go build");
  });

  it("包管理器 run 取三词（run 与 script 名都是语义）", () => {
    assert.equal(commandFamilyOf(PNPM_RUN_BUILD), PNPM_RUN_BUILD);
    assert.equal(commandFamilyOf("npm run test:unit"), "npm run test:unit");
  });

  it("包管理器不带 run 时只取两词", () => {
    assert.equal(commandFamilyOf("pnpm install --frozen-lockfile"), "pnpm install");
    assert.equal(commandFamilyOf("pnpm go:nowhere"), "pnpm go:nowhere");
  });

  it("run 后面跟 flag 时退回两词（没有 script 名可取名）", () => {
    assert.equal(commandFamilyOf("pnpm run --silent"), "pnpm run");
  });

  it("不认识的工具只取首词", () => {
    assert.equal(commandFamilyOf("rg --hidden foo src"), "rg");
    assert.equal(commandFamilyOf("ls -la"), "ls");
  });

  it("绝对路径只留文件名", () => {
    assert.equal(commandFamilyOf("/usr/bin/rg foo src"), "rg");
    assert.equal(commandFamilyOf(`/opt/homebrew/bin/${CARGO_TEST}`), CARGO_TEST);
  });

  it("包装器自己的选项不成为家族（sudo -u bob cargo test）", () => {
    assert.equal(commandFamilyOf(`sudo -u bob ${CARGO_TEST}`), CARGO_TEST);
    assert.equal(commandFamilyOf(`env --unset=FOO ${GIT_STATUS}`), GIT_STATUS);
    // 选项后面没有值、包装器到此为止：整段都是噪音 → unknown（不是 `-i`）。
    assert.equal(commandFamilyOf("sudo -i"), "unknown");
  });

  it("只按斜杠取文件名对 Windows 路径不够：反斜杠也要切", () => {
    assert.equal(commandFamilyOf(String.raw`C:\tools\rg.exe pattern`), "rg");
    assert.equal(commandFamilyOf("/usr/local/bin/rg pattern"), "rg");
  });

  it("第二个词是路径时不成家族（别把文件名写进账本）", () => {
    assert.equal(commandFamilyOf("pytest tests/test_api.py"), "pytest");
    assert.equal(commandFamilyOf("pytest -q tests/test_api.py"), "pytest");
    // 真的子命令照旧两词。
    assert.equal(commandFamilyOf(CARGO_TEST), CARGO_TEST);
    assert.equal(commandFamilyOf("git log --oneline"), "git log");
  });

  it("剥掉 sudo / env / 赋值前缀", () => {
    assert.equal(commandFamilyOf(`sudo env FOO=1 ${GIT_STATUS}`), GIT_STATUS);
    assert.equal(commandFamilyOf("time cargo build"), "cargo build");
    assert.equal(commandFamilyOf("BAR=2 FOO=1 pytest -q"), "pytest");
  });

  it("第二个词是 flag 时不当子命令（flag 不是动作）", () => {
    assert.equal(commandFamilyOf("cargo --version"), "cargo");
    // 不取值的 flag 跳过之后，子命令仍然读得出来（rtk 1.2.1 放行 `git --no-pager log` 那一类）。
    assert.equal(commandFamilyOf("git --no-pager log"), "git log");
  });

  it("工具自己的取值 flag 与 +toolchain 不吞掉子命令", () => {
    // P1-1：`cargo +nightly test` 过去折成 `cargo`，于是这条命令在账本里与 `cargo build` 混一族。
    assert.equal(commandFamilyOf("cargo +nightly test"), CARGO_TEST);
    assert.equal(commandFamilyOf("cargo +stable build"), "cargo build");
    assert.equal(commandFamilyOf("git -C /tmp log"), "git log");
    assert.equal(commandFamilyOf("git --git-dir=/tmp/x log"), "git log");
    assert.equal(commandFamilyOf("git -c core.pager=cat log"), "git log");
    assert.equal(commandFamilyOf("docker --context prod ps"), "docker ps");
    assert.equal(commandFamilyOf("docker -H tcp://box ps"), "docker ps");
    assert.equal(commandFamilyOf("pnpm --silent run build"), PNPM_RUN_BUILD);
    assert.equal(commandFamilyOf("pnpm -C /repo run build"), PNPM_RUN_BUILD);
  });

  it("不认识的取值 flag 按一个词跳：宁可多切也不吞掉子命令", () => {
    assert.equal(commandFamilyOf("cargo --future-flag test"), CARGO_TEST);
  });

  it("复合命令只看首段", () => {
    assert.equal(commandFamilyOf(CD_CARGO), "cd");
  });

  it("空命令与只剩前缀都是 unknown", () => {
    assert.equal(commandFamilyOf(""), "unknown");
    assert.equal(commandFamilyOf("   "), "unknown");
    assert.equal(commandFamilyOf("sudo env FOO=1"), "unknown");
  });

  it("拆不开的命令不拆，按原文取首段", () => {
    assert.equal(commandFamilyOf("echo $(git status)"), "echo");
  });
});

describe("rewrittenFamilies", () => {
  it("只统计真正被改写过的那一段", () => {
    assert.deepEqual(rewrittenFamilies(CD_CARGO, `cd /tmp && ${RTK_CARGO}`), [CARGO_TEST]);
  });

  it("两段都被改写时按出现顺序给两个家族", () => {
    assert.deepEqual(
      rewrittenFamilies(`${GIT_STATUS} && ${CARGO_TEST}`, `rtk ${GIT_STATUS} && ${RTK_CARGO}`),
      [GIT_STATUS, CARGO_TEST],
    );
  });

  it("没改写时为空表", () => {
    assert.deepEqual(rewrittenFamilies(CD_CARGO, CD_CARGO), []);
  });

  it("原文本来就叫 rtk 的段不算改写", () => {
    assert.deepEqual(rewrittenFamilies(RTK_CARGO, RTK_CARGO), []);
  });

  it("段数对不上时不猜，返回空表", () => {
    assert.deepEqual(rewrittenFamilies(CARGO_TEST, `rtk ${CARGO_TEST} && rtk ${GIT_STATUS}`), []);
  });

  it("拆不开的命令返回空表", () => {
    assert.deepEqual(rewrittenFamilies(`echo $(${CARGO_TEST})`, `rtk echo $(${CARGO_TEST})`), []);
  });

  it("包装器在中间时也算被改写（P1-4）", () => {
    assert.deepEqual(rewrittenFamilies("env FOO=1 cargo test", "env FOO=1 rtk cargo test"), [
      CARGO_TEST,
    ]);
  });
});

describe("rtkFrontOf", () => {
  it("普通前缀：命令本身就是 rtk", () => {
    assert.deepEqual(rtkFrontOf(RTK_GIT_LOG), { prefix: "", rest: GIT_LOG });
    assert.equal(hasRtkFront(RTK_GIT_LOG), true);
  });

  it("包装器在中间时 prefix 是它前面那段，透明包装器才认", () => {
    assert.deepEqual(rtkFrontOf(ENV_RTK_GIT_LOG), {
      prefix: "env FOO=1 ",
      rest: GIT_LOG,
    });
    assert.equal(hasRtkFront(ENV_RTK_GIT_LOG), true);
    assert.equal(hasRtkFront("command rtk git log"), true);
    assert.equal(hasRtkFront("time rtk git log"), true);
    assert.equal(hasRtkFront("nohup rtk git log"), true);
    // 会改变执行语义的包装器不算：它们可能不回传退出码/输出。
    assert.equal(hasRtkFront("sudo rtk git log"), false);
    assert.equal(hasRtkFront("uv run rtk git log"), false);
    assert.equal(hasRtkFront("timeout 5 rtk git log"), false);
  });

  it("没有整词 rtk 就不成立（rtkfoo、rtk 前缀的路径都不算）", () => {
    assert.equal(rtkFrontOf("rtkfoo --version"), undefined);
    assert.equal(rtkFrontOf("env FOO=1 rtk"), undefined);
    // 连第一个真词都没有：偏移回退到 0 与整串长度，不能因此抛错。
    assert.equal(rtkFrontOf("env FOO=1"), undefined);
    assert.equal(rtkFrontOf("   "), undefined);
    assert.equal(rtkFrontOf("rtk"), undefined);
    assert.equal(hasRtkFront("rtk"), false);
    assert.equal(hasRtkFront("rtk "), false);
  });

  it("rtkRemainder 交出 rtk 之后那段，非前插时是 undefined", () => {
    assert.equal(rtkRemainder(RTK_GIT_LOG), GIT_LOG);
    assert.equal(rtkRemainder(ENV_RTK_GIT_LOG), GIT_LOG);
    assert.equal(rtkRemainder("git log"), undefined);
    assert.equal(rtkRemainder("rtk"), undefined);
  });

  it("isTransparentPrefix 只认赋值与透明包装器", () => {
    assert.equal(isTransparentPrefix(""), true);
    assert.equal(isTransparentPrefix("env FOO=1 "), true);
    assert.equal(isTransparentPrefix("env -u FOO "), true);
    assert.equal(isTransparentPrefix("FOO=1 BAR=2 "), true);
    assert.equal(isTransparentPrefix("sudo "), false);
    assert.equal(isTransparentPrefix("xargs "), false);
    assert.equal(isTransparentPrefix("uv run "), false);
  });
});
