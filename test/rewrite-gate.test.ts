// lib/rewrite-gate.ts 单测：五道拒绝来源（结构 / 用户 / 内建表 / vitest 版本）+ workdir 三级真源。
//
// 拒绝层是「改写前」唯一的闸门：它先回答「这条命令该不该交给 rtk」，答案是否就原样执行。
// 判据次序有意义——结构判据不读盘，用户表是显式意图，内建表是证据表，版本门控要读
// `node_modules`（最贵），所以按这个顺序短路。
import { describe, it, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWorkdir, shouldSkipRewrite } from "../lib/rewrite-gate.ts";
import { resetVitestMajorCache } from "../lib/vitest-major.ts";

/** 门禁的固定参数；用例只覆盖自己关心的那一位。 */
const BASE = { denyCommands: [] as readonly string[], cwd: "/tmp", vitestMaxMajor: 5 };

/** 被大量复用的命令串与原因串：一处改名，全部断言跟着走。 */
const CARGO_TEST = "cargo test";
const GIT_SHOW_HEAD = "git show HEAD";
const VITEST_VERSION = "vitest-version";
const DENY_TABLE = "deny-table";
/** 复合命令的两段样例：后半段命中拒绝表那一组反复用同一串。 */
const CD_PREFIX = "cd x && ";
const VITEST_RUN = "vitest run";
const GH_PR_VIEW = "gh pr view";
const HEADER_CWD = "/from/header";
/** ensure 的固定回答：多处用例共用一份，避免同一字面量散落多处被 no-duplicate-string 判红。 */
const FROM_ENSURE = "/from/ensure";

/** 回固定回答的 `ensure` 替身。 */
async function fromEnsure(): Promise<string> {
  return FROM_ENSURE;
}

/** 造一个带 `session.header.cwd` 的假 exec；`cwd` 故意收 unknown，以覆盖脏值。 */
function headerExec(cwd: unknown): { agent: unknown } {
  return { agent: { session: { header: { cwd } } } };
}

/** 简化调用：把 over 叠到 BASE 上。 */
function gate(command: string, over: Partial<typeof BASE> = {}): string | undefined {
  return shouldSkipRewrite(command, { ...BASE, ...over });
}

/** 本轮建出来的临时根，`afterAll` 统一清掉。 */
const tempRoots: string[] = [];

/** 新建一个登记过清理的临时根。 */
function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "rtk-gate-"));
  tempRoots.push(root);
  return root;
}

/** 造一个装了指定版本 vitest 的工程目录；`version` 为 undefined 时写坏 JSON。 */
function makeProject(root: string, relative: string, version: string | undefined): string {
  const dir = path.join(root, relative);
  const vitestPkg = path.join(dir, "node_modules", "vitest");
  mkdirSync(vitestPkg, { recursive: true });
  const body = version === undefined ? "{ not json" : JSON.stringify({ name: "vitest", version });
  writeFileSync(path.join(vitestPkg, "package.json"), body);
  return dir;
}

describe("结构判据", () => {
  it("空命令", () => {
    assert.equal(gate("   "), "empty-command");
  });

  it("已 rtk", () => {
    assert.equal(gate("rtk cargo test"), "already-rtk");
  });

  it("复合命令：可拆的放行、拆不开的拒", () => {
    // 可逐段拆分的交给 rtk 逐段改写（见 prefix-safety 的 splitCommand）。
    assert.equal(gate("cd /tmp && cargo test"), undefined);
    assert.equal(gate("cargo test | tee log"), undefined);
    // 拆不开的仍然整条拒：重定向 / 命令替换 / 后台。
    assert.equal(gate("cargo test > o.txt"), "compound");
    assert.equal(gate("echo $(cargo test)"), "compound");
    assert.equal(gate("cargo test &"), "compound");
  });

  it("复合命令逐段判：后半段命中拒绝表就整条原样执行", () => {
    // 放开复合命令之后必须补这一组，否则「首词是 cd」会让内建表整片失效：
    // `cd x && git diff` 会被 rtk 改成 `cd x && rtk git diff`，丢 5 行 patch 头且不可 apply。
    assert.equal(gate(`${CD_PREFIX}git diff`), DENY_TABLE);
    assert.equal(gate(`${CD_PREFIX}git log`), DENY_TABLE);
    assert.equal(gate(`${CD_PREFIX}cargo clippy`), DENY_TABLE);
    assert.equal(gate(`${CD_PREFIX}ls`), DENY_TABLE);
    assert.equal(gate(`${CD_PREFIX}find . -name x`), DENY_TABLE);
    // 没命中的照常放行（逐段判不等于整条拒）。
    assert.equal(gate(`${CD_PREFIX}cargo test`), undefined);
    assert.equal(gate(`${CD_PREFIX}cargo build`), undefined);
  });

  it("详情 flag", () => {
    assert.equal(gate("cargo test -- --nocapture"), "detail-flag");
    assert.equal(gate("pytest -vv --tb=long"), "detail-flag");
  });

  it("普通命令放行", () => {
    assert.equal(gate(CARGO_TEST), undefined);
    assert.equal(gate("python -m pytest -q"), undefined);
  });
});

describe("用户拒绝前缀", () => {
  it("首词命中即拒", () => {
    assert.equal(gate(GH_PR_VIEW, { denyCommands: ["gh"] }), "user-deny");
  });

  it("只比首词，不比子串", () => {
    assert.equal(gate("git status", { denyCommands: ["gh"] }), undefined);
    assert.equal(gate("ghost foo", { denyCommands: ["gh"] }), undefined);
  });

  it("空表不拒", () => {
    assert.equal(gate(GH_PR_VIEW, { denyCommands: [] }), undefined);
  });
});

describe("内建信息损失表", () => {
  it("git log 任意形态", () => {
    assert.equal(gate("git log --oneline -20"), DENY_TABLE);
    assert.equal(gate("git log -p"), DENY_TABLE);
  });

  it("git diff 无统计 flag 拒", () => {
    assert.equal(gate("git diff"), DENY_TABLE);
    assert.equal(gate("git diff HEAD~1 -- src/a.ts"), DENY_TABLE);
  });

  it("git diff 带统计 flag 放行", () => {
    for (const flag of [
      "--stat",
      "--name-only",
      "--name-status",
      "--porcelain",
      "--numstat",
      "--shortstat",
    ]) {
      assert.equal(gate(`git diff ${flag}`), undefined, flag);
    }
  });

  it("git show <ref>:<path> 放行（逐字节保真）", () => {
    assert.equal(gate("git show HEAD:src/a.ts"), undefined);
    assert.equal(gate("git show main:docs/x.md"), undefined);
  });

  it("git show <commit-ish> 拒", () => {
    assert.equal(gate(GIT_SHOW_HEAD), DENY_TABLE);
    assert.equal(gate("git show abc1234"), DENY_TABLE);
  });

  it("列表类首命令拒", () => {
    for (const command of [
      "ls",
      "ls -la",
      "find . -name x.ts",
      "grep -rn boot src",
      "rg boot src",
    ]) {
      assert.equal(gate(command), DENY_TABLE, command);
    }
  });

  it("cargo clippy 拒（warning 全丢）", () => {
    assert.equal(gate("cargo clippy --all-targets"), DENY_TABLE);
  });

  it("aws 拒（退出码失真）", () => {
    assert.equal(gate("aws s3 ls"), DENY_TABLE);
  });

  it("显式保留的放行", () => {
    const KEPT = [
      "cargo build",
      "cargo check",
      "cargo test",
      "pytest -q",
      "ctest",
      "go test ./...",
      "go build ./...",
      "tsc --noEmit",
      "mypy src",
      "ruff check .",
      "prettier --check .",
      "docker ps",
      "kubectl get pods",
      "gh pr view",
      "terraform plan",
      "make build",
      "pnpm run build",
    ];
    for (const command of KEPT) {
      assert.equal(gate(command), undefined, command);
    }
  });
});

describe("vitest 版本门控", () => {
  beforeEach(() => {
    resetVitestMajorCache();
  });

  afterAll(() => {
    for (const dir of tempRoots) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vitest 4 放行", () => {
    const dir = makeProject(newRoot(), "v4", "4.1.12");
    assert.equal(gate(VITEST_RUN, { cwd: dir }), undefined);
  });

  it("vitest 5 拒（实测输出掉到 123B）", () => {
    const dir = makeProject(newRoot(), "v5", "5.1.0");
    assert.equal(gate(VITEST_RUN, { cwd: dir }), VITEST_VERSION);
  });

  it("vitestMaxMajor 收紧后 4 也拒", () => {
    const dir = makeProject(newRoot(), "v4tight", "4.1.12");
    assert.equal(gate("npx vitest run", { cwd: dir, vitestMaxMajor: 4 }), "vitest-version");
  });

  it("检测不到版本也拒", () => {
    const bad = makeProject(newRoot(), "bad", undefined);
    assert.equal(gate(VITEST_RUN, { cwd: bad }), VITEST_VERSION);
    const nowhere = path.join(newRoot(), "nowhere");
    mkdirSync(nowhere, { recursive: true });
    assert.equal(gate(VITEST_RUN, { cwd: nowhere }), VITEST_VERSION);
  });

  it("脚本别名同样门控", () => {
    const dir = makeProject(newRoot(), "v5alias", "5.1.0");
    assert.equal(gate("pnpm test", { cwd: dir }), VITEST_VERSION);
  });

  it("非 vitest 命令不受版本门控影响", () => {
    const dir = makeProject(newRoot(), "v5other", "5.1.0");
    assert.equal(gate(CARGO_TEST, { cwd: dir }), undefined);
  });
});

describe("resolveWorkdir", () => {
  it("宿主 workingDirectory.ensure 优先", async () => {
    const resolved = await resolveWorkdir(headerExec(HEADER_CWD), fromEnsure);
    assert.equal(resolved, FROM_ENSURE);
  });

  it("ensure 抛错退 header", async () => {
    const resolved = await resolveWorkdir(headerExec(HEADER_CWD), () => {
      throw new Error("no service");
    });
    assert.equal(resolved, HEADER_CWD);
  });

  it("ensure 返回空串退 header", async () => {
    const resolved = await resolveWorkdir(headerExec(HEADER_CWD), async () => "");
    assert.equal(resolved, HEADER_CWD);
  });

  it("header 缺席落 process.cwd", async () => {
    // ensure 一律给「没有值」：用查表未命中表达空输出（`async () => undefined` 会被
    // unicorn/no-useless-undefined 判成多余字面量，而这里要表达的是「服务没有给 cwd」）。
    const none = new Map<string, string>();
    const miss = async (): Promise<string | undefined> => none.get("absent");
    assert.equal(await resolveWorkdir({}, miss), process.cwd());
    assert.equal(await resolveWorkdir({ agent: {} }, miss), process.cwd());
    assert.equal(await resolveWorkdir(headerExec(""), miss), process.cwd());
    assert.equal(await resolveWorkdir(headerExec(42), miss), process.cwd());
  });

  it("中间层形状不对也落 process.cwd（session 不是对象）", async () => {
    // 三种脏形状各一条：session 是 null、session 是字符串、header 是 null。
    // 它们走的是 headerCwd 里逐层 typeof 判空的那几个分支——真实宿主上不会出现，
    // 但遮蔽层拿到的是 `unknown`，任何一层都可能不是对象。
    const none = new Map<string, string>();
    const miss = async (): Promise<string | undefined> => none.get("absent");
    assert.equal(await resolveWorkdir({ agent: { session: null } }, miss), process.cwd());
    assert.equal(await resolveWorkdir({ agent: { session: "x" } }, miss), process.cwd());
    assert.equal(
      await resolveWorkdir({ agent: { session: { header: null } } }, miss),
      process.cwd(),
    );
    assert.equal(await resolveWorkdir({ agent: null }, miss), process.cwd());
  });

  it("agent 缺席不调 ensure", async () => {
    let called = false;
    await resolveWorkdir({}, async () => {
      called = true;
      return "/x";
    });
    assert.equal(called, false);
  });

  // 下面四条钉的是「模型按调用传的 workdir」这一位：宿主 `tool-bash` 的 `resolveWorkdir(modelWorkdir,
  // sessionCwd)` 就是三支（缺席回会话 cwd / 绝对原样 / 相对拼在后面），插件算 cwd 时必须同口径，
  // 否则 `rtk rewrite` 与 `detectVitestMajor` 会按另一个目录判。
  it("模型传绝对 workdir 时原样采用（压过会话 cwd）", async () => {
    const fromModel = await resolveWorkdir(headerExec(HEADER_CWD), fromEnsure, "/abs/repo");
    assert.equal(fromModel, "/abs/repo");
  });

  it("模型传相对 workdir 时拼在会话 cwd 之后", async () => {
    const fromModel = await resolveWorkdir(headerExec(HEADER_CWD), fromEnsure, "sub/dir");
    assert.equal(fromModel, `/from/ensure${path.sep}sub/dir`);
  });

  it("模型没传或传了脏值时回会话 cwd（不在 cwd 上猜）", async () => {
    assert.equal(await resolveWorkdir(headerExec(HEADER_CWD), fromEnsure, undefined), FROM_ENSURE);
    assert.equal(await resolveWorkdir(headerExec(HEADER_CWD), fromEnsure, ""), FROM_ENSURE);
    assert.equal(await resolveWorkdir(headerExec(HEADER_CWD), fromEnsure, 42), FROM_ENSURE);
    assert.equal(await resolveWorkdir(headerExec(HEADER_CWD), fromEnsure, null), FROM_ENSURE);
    assert.equal(
      await resolveWorkdir(headerExec(HEADER_CWD), fromEnsure, { dir: "x" }),
      FROM_ENSURE,
    );
  });

  it("会话 cwd 全缺时相对 workdir 拼在 process.cwd 上", async () => {
    const miss = new Map<string, string>();
    const empty = async (): Promise<string | undefined> => miss.get("absent");
    const resolved = await resolveWorkdir({}, empty, "sub");
    assert.equal(resolved, `${process.cwd()}${path.sep}sub`);
  });
});
