// test/prefix-integration.test.ts —— C 形态（per-agent 遮蔽 bash）的装配序。
//
// 全部用例直驱 `installPrefixShadow` 装配出来的那个工具体，不经过 apply 与 cordis 的配置投影：
// 本函数的设计就是只吃已解析的值，于是这里能精确控制每一步门禁、并断言「最后转调的是哪条命令」。
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  installFakeRtk,
  makeCleanups,
  recordingSubprocess,
  startPrefixHost,
} from "./integration/host-stack.ts";

const cleanups = makeCleanups();

const CARGO_TEST = "cargo test";
const RTK_CARGO_TEST = "rtk cargo test";
const NPM_RUN_LINT = "npm run lint";

/** 干净回执：五条用例共用同一份「一行摘要 + marker」，重复写字面量会被 no-duplicate-string 判红。 */
const CLEAN_TEXT = "test result: ok.\n[exit code: 0]";

/** 会话 cwd 的两种固定回答：多处用例共用一份，避免同一字面量散落多处被 no-duplicate-string 判红。 */
const SESSION_CWD = "/tmp/host-ensured-cwd";
const WORKSPACE_CWD = "/tmp/workspace";
/** 模型按调用指定的绝对 workdir：与上面两个会话 cwd 都不同，才能证明前者压过后两者。 */
const MODEL_CWD = "/tmp/model-picked";

/** 具名 noop：`() => () => undefined` 会撞 `unicorn(no-useless-undefined)`，具名一份两边都过。 */
const noop = (): void => undefined;

/** 假 bash 的回执形状：三条用例共用，放模块作用域而不是 describe 里（它不捕获任何东西）。 */
const cargoReply = (text: string) => (): Record<string, unknown> => ({
  kind: "foreground",
  exitCode: 0,
  stdout: { text },
});

/** 一次 bash 调用的最小 exec：`callId` 是去重账本的键，`signal` 要能被 AbortSignal.any 合并。 */
const exec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  callId: "call-1",
  name: "bash",
  arguments: { command: CARGO_TEST },
  signal: new AbortController().signal,
  ...extra,
});

/** 被遮蔽的工具体回什么形状由假 bash 决定；这里只取断言要看的那几位。 */
const asResult = (
  value: unknown,
): { readonly stdout: { readonly text: string }; readonly exitCode: number } =>
  value as { readonly stdout: { readonly text: string }; readonly exitCode: number };

/**
 * C 形态只在 POSIX 上存在，这个文件的用例因此是 POSIX-only。
 *
 * 两条都成立，缺一条这个文件就会在 Windows CI 上整片红：
 *   1. **实现侧**：`prefixSupportedOn("win32")` 判否，`installPrefixShadow` 在平台门禁处
 *      直接 return——整层不装，`agent/created` 不挂，`withAgent()` 抛「遮蔽层没有注册任何工具体」。
 *      这是 spec §7.2 的设计（rtk 的 Windows 分发面与 pwsh 命令形态都没在真机验过，而前缀形态
 *      写坏命令的代价是「本来能跑的命令不能跑」），不是缺陷。
 *   2. **夹具侧**：假 rtk 是个 `#!/usr/bin/env node` 的 0755 脚本，靠 PATH 上的裸名被
 *      `spawn("rtk")` 找到；Windows 既没有执行位，也要 `.exe`/`.cmd` 后缀才能 spawn。所以
 *      连「注入 `platform: "linux"` 假装在 POSIX 上跑」这条退路也不通。
 * 平台判定本身由 `test/platform/platform.test.ts` 覆盖（那里显式注入 win32 断言整层不装）。
 */
const POSIX_ONLY = process.platform !== "win32";

describe.skipIf(!POSIX_ONLY)("c 形态", () => {
  // 临时目录按文件收尾：每条用例自己 try/finally 还 PATH 与假 rtk，目录在这里一次性删。
  afterAll(() => {
    cleanups.drain();
  });

  describe("c 形态：装配期门禁", () => {
    it("rtk 不在 PATH 时整层不装（连监听器都不注册）", async () => {
      // 把 PATH 指到一个空目录，保证「找不到 rtk」是这条用例的前提而不是本机状态。
      const empty = mkdtempSync(path.join(tmpdir(), "rtk-empty-"));
      cleanups.push(empty);
      const saved = process.env["PATH"];
      process.env["PATH"] = empty;
      try {
        const host = await startPrefixHost();
        // 门禁第三条就是 findOnPath('rtk')：PATH 上没有它时函数直接 return，agent/created 一条也不挂。
        assert.equal(host.installed, false);
      } finally {
        process.env["PATH"] = saved;
      }
    });

    it("enabled 为假时**仍然装**，只是执行期原样转调", async () => {
      // 这一条钉的是「装配期不判总开关」：`enabled` 默认 false，而用户是在卡片上打开它的。
      // 早先装配期有这样一道早退，于是默认路径整条不通——装好插件、打开开关、下一次调用 bash
      // 什么都没发生，因为遮蔽层在装配那一刻就没装、之后没有任何东西会去补装。
      // 判据分两半：装配必须发生（`installed === true`），行为必须是原样的（不 spawn 改写）。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ options: { enabled: () => false } });
        assert.equal(host.installed, true);
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        assert.equal(rtk.spawned(), 0);
        assert.deepEqual(host.fake.received, [CARGO_TEST]);
      } finally {
        rtk.restore();
      }
    });

    it("装配期关着、之后打开总开关 → 不改装配也能改写", async () => {
      // 用户真实路径：装好插件（`enabled` 默认 false）→ 在卡片上打开 → 下一次 cargo test 被改写。
      // `enabled` 是 volatile，宿主把卡片上的改动写进配置之后 `apply` 早已跑完，所以只有
      // 「装配期不判它」能让这条路走得通。
      let enabled = false;
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ options: { enabled: () => enabled } });
        const shadow = host.withAgent();
        enabled = true;
        await shadow.execute({ command: CARGO_TEST }, exec({ callId: "call-after-enable" }));
        assert.equal(rtk.spawned(), 1);
        assert.deepEqual(host.fake.received, [RTK_CARGO_TEST]);
      } finally {
        rtk.restore();
      }
    });

    it("enabledForms 不含 prefix 时整层不装", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ options: { forms: [] } });
        assert.equal(host.installed, false);
      } finally {
        rtk.restore();
      }
    });

    it("bash 只在 agent 作用域注册时照样装上（取定义必须带 scope）", async () => {
      // 真机回归：web-app 那套 profile 把 `tool-bash` 交给 **agent preset** 注册，
      // 全局那份 `include:tool-bash` 是 disabled。宿主 `ToolsService.get(name, scope)` 的
      // `scope` 缺省 = 只看全局视图，于是「不传 scope」在这里取不到 bash、遮蔽层静默不装。
      // 症状是「`enabledForms: [prefix]` 配好、插件 active，但裸 git status 仍是原生输出」。
      //
      // 这条用例是本仓唯一能在单测里钉住它的判据：夹具带 `bashNeedsScope` 时，
      // 无 scope 的 `get` 回 undefined、带 scope 才回 bash。改成不传 scope 就会红。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ bashNeedsScope: true });
        assert.equal(host.installed, true);
        const shadow = host.withAgent();
        await shadow.execute({ command: CARGO_TEST }, exec());
        assert.equal(rtk.spawned(), 1);
        assert.deepEqual(host.fake.received, [RTK_CARGO_TEST]);
      } finally {
        rtk.restore();
      }
    });

    it("取不到 bash 时记一行日志（遮蔽层失效不许无声）", async () => {
      // 遮蔽层不装是「功能没了、一切看起来正常」的形态，日志是唯一线索。
      // 默认 `logFilterMode: off` ⇒ `options.log` 是 undefined，所以这行默认不吵。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      const lines: string[] = [];
      try {
        const host = await startPrefixHost({
          bash: null,
          log: (line) => {
            lines.push(line);
          },
        });
        assert.throws(() => host.withAgent(), /没有注册任何工具体/u);
        assert.deepEqual(lines, [
          "[rtk] prefix: this agent has no executable bash tool; shadow not installed",
        ]);
      } finally {
        rtk.restore();
      }
    });
  });

  describe("c 形态：改写与转调", () => {
    it("rtk 命中且改写通过校验 → 转调改写后的命令", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost();
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        assert.deepEqual(host.fake.received, [RTK_CARGO_TEST]);
        assert.equal(rtk.spawned(), 1);
      } finally {
        rtk.restore();
      }
    });

    it("探到 rtk 低于下限 → 原样转调，绝不改写（README 承诺的 does nothing）", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ options: { supported: () => false } });
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        assert.deepEqual(host.fake.received, [CARGO_TEST]);
        assert.equal(rtk.spawned(), 0);
      } finally {
        rtk.restore();
      }
    });

    it("版本还在探（supported 为 undefined）→ 放行：探不到不等于太低", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        // 探不到（`undefined`）= 还在探或探不到版本：放行，绝不因为「不知道」就停手。
        const probed: { ready?: boolean } = {};
        const host = await startPrefixHost({ options: { supported: () => probed.ready } });
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        assert.deepEqual(host.fake.received, [RTK_CARGO_TEST]);
      } finally {
        rtk.restore();
      }
    });

    it("logFilterMode 打开时，改写在诊断日志里留一行（含改写前后的命令）", async () => {
      // 这一条守的是 `logFilterMode` 那位部署开关：它早先是死字段（schema 里有、全仓零消费者），
      // 用户翻成 on 之后什么都没发生。现在它装配成 `options.log`，改写成功时记一行。
      const lines: string[] = [];
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({
          log: (line) => {
            lines.push(line);
          },
        });
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        assert.equal(lines.length, 1);
        assert.ok(
          String(lines[0]).includes(`rewrite: ${CARGO_TEST} -> ${RTK_CARGO_TEST}`),
          String(lines[0]),
        );
      } finally {
        rtk.restore();
      }
    });

    it("改写被 P4 拒（npm run lint → rtk lint）→ 原样转调", async () => {
      // 真机上最危险的官方坏改写：rtk lint 会跳过用户自己的 npm run lint 脚本。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: "rtk lint" }]);
      try {
        const host = await startPrefixHost();
        await host
          .withAgent()
          .execute({ command: NPM_RUN_LINT }, exec({ arguments: { command: NPM_RUN_LINT } }));
        assert.deepEqual(host.fake.received, [NPM_RUN_LINT]);
      } finally {
        rtk.restore();
      }
    });

    it("rc=1（无等价改写）→ 原样转调", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
      try {
        const host = await startPrefixHost();
        await host
          .withAgent()
          .execute({ command: "fd ." }, exec({ arguments: { command: "fd ." } }));
        assert.deepEqual(host.fake.received, ["fd ."]);
      } finally {
        rtk.restore();
      }
    });

    it("rc=2（~/.claude deny）→ 原样转调，绝不拦截命令", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 2, stdout: "" }]);
      try {
        const host = await startPrefixHost();
        const result = asResult(await host.withAgent().execute({ command: CARGO_TEST }, exec()));
        assert.deepEqual(host.fake.received, [CARGO_TEST]);
        assert.equal(result.exitCode, 0);
      } finally {
        rtk.restore();
      }
    });

    it("复合命令不进 spawn（shouldSkipRewrite 先拒）", async () => {
      const compound = "cd /tmp && cargo test";
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost();
        await host
          .withAgent()
          .execute({ command: compound }, exec({ arguments: { command: compound } }));
        assert.equal(rtk.spawned(), 0);
        assert.deepEqual(host.fake.received, [compound]);
      } finally {
        rtk.restore();
      }
    });

    it("详情 flag 命令不进 spawn（--nocapture 会丢掉测试输出）", async () => {
      const detailed = "cargo test -- --nocapture";
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost();
        await host
          .withAgent()
          .execute({ command: detailed }, exec({ arguments: { command: detailed } }));
        assert.equal(rtk.spawned(), 0);
        assert.deepEqual(host.fake.received, [detailed]);
      } finally {
        rtk.restore();
      }
    });

    it("调用方 signal 已 abort → 原样转调且不 spawn", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost();
        const controller = new AbortController();
        controller.abort();
        await host
          .withAgent()
          .execute({ command: CARGO_TEST }, exec({ signal: controller.signal }));
        assert.equal(rtk.spawned(), 0);
        assert.deepEqual(host.fake.received, [CARGO_TEST]);
      } finally {
        rtk.restore();
      }
    });

    it("rewrite 超时 → 原样转调，且不把命令拖满整个超时", async () => {
      // 半栈默认预算 5000ms，这条压到 300ms；假 rtk 拖 5s。
      const rtk = installFakeRtk(cleanups.dirs, [
        { exitCode: 3, stdout: RTK_CARGO_TEST, delayMs: 5000 },
      ]);
      try {
        const host = await startPrefixHost({ options: { rewriteTimeoutMs: 300 } });
        const started = Date.now();
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        const elapsed = Date.now() - started;
        assert.deepEqual(host.fake.received, [CARGO_TEST]);
        assert.ok(elapsed < 4000, `超时未生效，实际 ${elapsed}ms`);
      } finally {
        rtk.restore();
      }
    });

    it("改写用的 cwd 来自宿主 workingDirectory.ensure，不是 process.cwd()", async () => {
      // 判据落在 spawn 的 spec.cwd 上：遮蔽层若图省事直接用 process.cwd()，这里就会是仓库根。
      //
      // 假 rtk 是**装配期门禁的前提**，不是这条用例的被测面：`findOnPath('rtk')` 交不出路径时
      // `installPrefixShadow` 直接 return，用例会在 `withAgent()` 处炸成「遮蔽层没有注册任何
      // 工具体」而不是断言失败。开发者机器上有 /opt/homebrew/bin/rtk，CI 上没有，于是这类
      // 用例只在 CI 红——这正是它们早先漏掉 `installFakeRtk` 却一直显示绿的原因。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
      try {
        const subprocess = recordingSubprocess();
        const host = await startPrefixHost({
          subprocess,
          ensure: async () => SESSION_CWD,
        });
        // 必须带 agent：resolveWorkdir 的三级真源都以「这条调用属于哪个会话」为前提，
        // 没有 agent 时它落 process.cwd() 是设计如此。
        await host.withAgent().execute({ command: CARGO_TEST }, exec({ agent: { id: "s1" } }));
        assert.equal(subprocess.calls.length, 1);
        assert.equal(subprocess.calls[0]?.cwd, SESSION_CWD);
        // 记录桩固定回 rc=1（没有等价改写），所以最终转调的是原命令。
        assert.deepEqual(host.fake.received, [CARGO_TEST]);
      } finally {
        rtk.restore();
      }
    });

    it("exec.agent 不是 agent 形状时不去问 ensure，退到 header.cwd", async () => {
      // resolveWorkdir 的第二级真源：宿主给过来的 agent 若不是带字符串 id 的那个形状，
      // 就不该拿去问 workingDirectory.ensure（那是个有副作用的服务调用，问错了会脏别人的状态）。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
      try {
        const subprocess = recordingSubprocess();
        const host = await startPrefixHost({ subprocess });
        const exec0 = exec({ agent: { id: 7, session: { header: { cwd: "/tmp/from-header" } } } });
        await host.withAgent().execute({ command: CARGO_TEST }, exec0);
        assert.equal(subprocess.calls.length, 1);
        assert.equal(subprocess.calls[0]?.cwd, "/tmp/from-header");
      } finally {
        rtk.restore();
      }
    });

    it("模型传的 workdir 压过会话 cwd：rewrite 在模型指定的目录里跑", async () => {
      // 宿主 `tool-bash` 按 `args.workdir` 跑命令（相对路径拼在会话 cwd 上），插件算 cwd
      // 时不读它就会与「命令实际跑在哪个目录」分叉：`rtk rewrite` 的退出码取决于从 cwd
      // 向上找到的 `.claude/settings*`，`detectVitestMajor` 也从 cwd 向上找 `node_modules/vitest`。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
      try {
        const subprocess = recordingSubprocess();
        const host = await startPrefixHost({
          subprocess,
          ensure: async () => SESSION_CWD,
        });
        await host.withAgent().execute({ command: CARGO_TEST, workdir: MODEL_CWD }, exec());
        assert.equal(subprocess.calls.length, 1);
        assert.equal(subprocess.calls[0]?.cwd, MODEL_CWD);
      } finally {
        rtk.restore();
      }
    });

    it("模型传相对 workdir 时拼在会话 cwd 之后（与宿主同口径）", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
      try {
        const subprocess = recordingSubprocess();
        const host = await startPrefixHost({
          subprocess,
          ensure: async () => WORKSPACE_CWD,
        });
        // 必须带 agent：会话 cwd 的两级真源都以「这条调用属于哪个会话」为前提。
        await host
          .withAgent()
          .execute({ command: CARGO_TEST, workdir: "pkgs/app" }, exec({ agent: { id: "s1" } }));
        assert.equal(subprocess.calls.length, 1);
        assert.equal(subprocess.calls[0]?.cwd, `${WORKSPACE_CWD}${path.sep}pkgs${path.sep}app`);
      } finally {
        rtk.restore();
      }
    });

    it("模型传的 workdir 是脏值时按会话 cwd 走（不拿它拼目录）", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
      try {
        const subprocess = recordingSubprocess();
        const host = await startPrefixHost({
          subprocess,
          ensure: async () => WORKSPACE_CWD,
        });
        await host
          .withAgent()
          .execute({ command: CARGO_TEST, workdir: 42 }, exec({ agent: { id: "s1" } }));
        assert.equal(subprocess.calls.length, 1);
        assert.equal(subprocess.calls[0]?.cwd, WORKSPACE_CWD);
      } finally {
        rtk.restore();
      }
    });

    it("记账先于转调：bash 执行的那一刻，账本已经记下这条 callId", async () => {
      // 判据必须在执行体内部取——从外面看，两种顺序的结果一模一样。
      // background bash 会立即返回、结果稍后到，post-execute 可能就落在那段窗口里，
      // 所以「先记账」不是风格问题，是双形态不重复压缩的前提。
      let seenInsideExecute: boolean | undefined;
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({
          onExecute: () => {
            seenInsideExecute = host.deps.rewrittenCalls.consume("call-1");
          },
        });
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        assert.equal(seenInsideExecute, true);
      } finally {
        rtk.restore();
      }
    });

    it("参数缺 command 时原样转调，不 spawn", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost();
        await host.withAgent().execute({}, exec({ arguments: {} }));
        assert.equal(rtk.spawned(), 0);
        assert.equal(host.fake.received.length, 1);
      } finally {
        rtk.restore();
      }
    });

    it("遮蔽体继承被遮蔽工具的全部字段（不手抄 description / output）", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 1, stdout: "" }]);
      try {
        const host = await startPrefixHost();
        const shadow = host.withAgent() as unknown as Record<string, unknown>;
        assert.equal(shadow["name"], "bash");
        assert.equal(shadow["description"], "fake bash");
        assert.equal(typeof shadow["parameters"], "object");
        assert.equal(typeof shadow["output"], "object");
      } finally {
        rtk.restore();
      }
    });

    it("装配后用户关掉开关 → 执行期复查生效，原样转调且不 spawn", async () => {
      // 装配期门禁已经过了（否则整层不装），这一条测的是 execute 内部那次复查：
      // 用户关开关不必重启宿主，下一条命令就该恢复原样。
      let enabled = true;
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ options: { enabled: () => enabled } });
        const shadow = host.withAgent();
        enabled = false;
        await shadow.execute({ command: CARGO_TEST }, exec({ callId: "call-2" }));
        assert.equal(rtk.spawned(), 0);
        assert.deepEqual(host.fake.received, [CARGO_TEST]);
      } finally {
        rtk.restore();
      }
    });

    it("该 profile 没装 bash 时跳过（不注册任何东西）", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        // 监听器照常挂着（门禁三关都过了），但 agent 创建时发现没有 bash 可遮蔽。
        const host = await startPrefixHost({ bash: null });
        assert.equal(host.installed, true);
        assert.throws(() => host.withAgent(), /没有注册任何工具体/u);
        assert.equal(rtk.spawned(), 0);
      } finally {
        rtk.restore();
      }
    });

    it("同名工具有 execute 但 output.render 不是函数时也跳过（宿主 register 会当场抛）", async () => {
      // 判据取的是宿主 `register` 自己那道校验（`output` 必须是对象且 `render` 是函数），
      // 因为遮蔽体在 `agent/created` 回调里注册——那条回调里抛出的错误不会有人接。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({
          bash: { name: "bash", description: "no render", execute: () => "x", output: {} },
        });
        assert.throws(() => host.withAgent(), /没有注册任何工具体/u);
        assert.equal(rtk.spawned(), 0);
      } finally {
        rtk.restore();
      }
    });

    it("同名工具没有 execute 时跳过（不装半成品）", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ bash: { name: "bash", description: "no execute" } });
        assert.throws(() => host.withAgent(), /没有注册任何工具体/u);
        assert.equal(rtk.spawned(), 0);
      } finally {
        rtk.restore();
      }
    });
  });

  describe("c 形态：rewrite 的 env 面", () => {
    it("rewriteHostEnv 为空时不设 RTK_REWRITE_HOST，且仍带三枚行为开关", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const subprocess = recordingSubprocess();
        const host = await startPrefixHost({ subprocess });
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        const [spawned] = subprocess.calls;
        assert.ok(spawned !== undefined);
        // 三枚行为开关在：折叠提示要能被 recall 取回、TOML 过滤保持启用、不上报遥测。
        assert.equal(spawned.env["RTK_RECALL"], "0");
        assert.equal(spawned.env["RTK_TEE"], "0");
        assert.equal(spawned.env["RTK_TELEMETRY_DISABLED"], "1");
        // NO_TOML 会关掉 TOML-only 命令的改写，rewrite 层刻意不带它。
        assert.equal(spawned.env["RTK_NO_TOML"], undefined);
        assert.equal(spawned.env["RTK_REWRITE_HOST"], undefined);
      } finally {
        rtk.restore();
      }
    });

    it("rewriteHostEnv 非空时塞进 RTK_REWRITE_HOST", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const subprocess = recordingSubprocess();
        const host = await startPrefixHost({
          subprocess,
          options: { rewriteHostEnv: () => "openclaw" },
        });
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        assert.equal(subprocess.calls[0]?.env["RTK_REWRITE_HOST"], "openclaw");
      } finally {
        rtk.restore();
      }
    });

    it("args 不是对象时原样转调，不 spawn", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost();
        await host.withAgent().execute("not-an-object", exec({ arguments: "not-an-object" }));
        assert.equal(rtk.spawned(), 0);
        assert.equal(host.fake.received.length, 1);
      } finally {
        rtk.restore();
      }
    });

    it("command 不是字符串时原样转调，不 spawn", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost();
        await host.withAgent().execute({ command: 42 }, exec({ arguments: { command: 42 } }));
        assert.equal(rtk.spawned(), 0);
        assert.equal(host.fake.received.length, 1);
      } finally {
        rtk.restore();
      }
    });
  });

  describe("c 形态：warnHint", () => {
    it("cargo test 改写后无 warning → 追加提示行，且提示插在 marker 之前", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({
          reply: cargoReply("test result: ok. 1 passed\n[exit code: 0]"),
        });
        const result = asResult(await host.withAgent().execute({ command: CARGO_TEST }, exec()));
        assert.ok(result.stdout.text.includes("cargo build / cargo check"));
        assert.equal(result.exitCode, 0);
        assert.ok(result.stdout.text.endsWith("[exit code: 0]"));
      } finally {
        rtk.restore();
      }
    });

    it("已有 warning 时不加（否则是噪音）", async () => {
      const text = "warning: unused import\n[exit code: 0]";
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ reply: cargoReply(text) });
        const result = asResult(await host.withAgent().execute({ command: CARGO_TEST }, exec()));
        assert.equal(result.stdout.text, text);
      } finally {
        rtk.restore();
      }
    });

    it("warnHint=false 时不加", async () => {
      const text = CLEAN_TEXT;
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({
          options: { warnHint: () => false },
          reply: cargoReply(text),
        });
        const result = asResult(await host.withAgent().execute({ command: CARGO_TEST }, exec()));
        assert.equal(result.stdout.text, text);
      } finally {
        rtk.restore();
      }
    });

    it("非 cargo test 改写后不加", async () => {
      const text = "1 passed\n[exit code: 0]";
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: "rtk pytest -q" }]);
      try {
        const host = await startPrefixHost({ reply: cargoReply(text) });
        const command = "python -m pytest -q";
        const result = asResult(
          await host.withAgent().execute({ command }, exec({ arguments: { command } })),
        );
        assert.equal(result.stdout.text, text);
      } finally {
        rtk.restore();
      }
    });
  });

  describe("c 形态：volatile 配置项逐次现读", () => {
    /**
     * 这一组钉的是「卡片上改完，下一次调用就生效」。
     *
     * 早先 `apply` 把 volatile 的 `.get()` 结果一次性快照进 `PrefixOptions`/`PipeOptions`，
     * 而 `apply` 只跑一次——于是卡片上改的值、存的值、刷新后还在的值，与运行中的行为是两件
     * 互不相干的事。判据必须是「同一台 host，两次调用之间改值」，否则测不出快照与现读的区别。
     */
    it("denyCommands 运行期现读：中途追加一条拒绝前缀，下一次立刻不再改写", async () => {
      let deny: readonly string[] = [];
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({
          options: { denyCommands: () => deny },
          reply: cargoReply(CLEAN_TEXT),
        });
        const shadow = host.withAgent();
        await shadow.execute({ command: CARGO_TEST }, exec({ callId: "call-a" }));
        assert.equal(rtk.spawned(), 1, "对照组：denyCommands 为空时应当改写");
        // 用户在卡片上把 `cargo` 加进拒绝前缀。
        deny = ["cargo"];
        await shadow.execute({ command: CARGO_TEST }, exec({ callId: "call-b" }));
        assert.equal(rtk.spawned(), 1, "改完 denyCommands 之后又 spawn 了 rewrite");
        assert.deepEqual(host.fake.received, [RTK_CARGO_TEST, CARGO_TEST]);
      } finally {
        rtk.restore();
      }
    });

    it("rewriteHostEnv 运行期现读：中途填上 openclaw，下一次 spawn 就带 RTK_REWRITE_HOST", async () => {
      // 两条**不同**的命令：改写结论按 `cwd + 命令` 缓存，同一命令第二次不会 spawn，
      // 拿它当第二次调用就测不到 env 了（那测的是缓存不是现读）。
      let hostEnv = "";
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const subprocess = recordingSubprocess();
        const host = await startPrefixHost({
          subprocess,
          options: { rewriteHostEnv: () => hostEnv },
        });
        const shadow = host.withAgent();
        await shadow.execute({ command: CARGO_TEST }, exec({ callId: "call-a" }));
        hostEnv = "openclaw";
        await shadow.execute(
          { command: "cargo build" },
          exec({ callId: "call-b", arguments: { command: "cargo build" } }),
        );
        assert.equal(subprocess.calls.length, 2);
        assert.equal(subprocess.calls[0]?.env["RTK_REWRITE_HOST"], undefined);
        assert.equal(subprocess.calls[1]?.env["RTK_REWRITE_HOST"], "openclaw");
      } finally {
        rtk.restore();
      }
    });
  });
});

// 与上面同一个理由：晚装载验的也是 C 形态的装配路径，win32 上整层不装。
describe.skipIf(!POSIX_ONLY)("晚装载：装配时已经存在的 agent 也要被遮蔽", () => {
  it("agents.list() 里的 agent 在装配那一刻就拿到遮蔽体", async () => {
    // 根因：`agent/created` 只对之后新建的 agent 触发。插件在已经跑着的宿主里装上
    // （HMR / plugin add 之后不重启）时，那些已有 agent 永远拿不到遮蔽层——用户以为开了、
    // 实际模型照旧走原生 bash。宿主 `AgentRegistry.list()` 就是这份全集。
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost({
        liveAgentIds: ["live-1"],
        reply: cargoReply(CLEAN_TEXT),
      });
      const registered = host.registrations.filter((each) => each.agentId === "live-1");
      assert.equal(registered.length, 1, "装配时已存在的 agent 没被遮蔽");
    } finally {
      rtk.restore();
    }
  });

  it("同一次装配里 created 与 list() 撞到同一个 agent 时只注册一次", async () => {
    // 重复注册同名工具在宿主那里是硬错误（`tools.register` 的 JSDoc：'duplicates within
    // one layer … fail'），所以两个入口必须按 `Agent.id` 去重。
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost({
        liveAgentIds: ["same-1"],
        reply: cargoReply(CLEAN_TEXT),
      });
      // 同一个 id 再走一次事件入口：不该产生第二份注册。
      host.withAgent("same-1");
      assert.equal(host.registrations.length, 1);
    } finally {
      rtk.restore();
    }
  });

  it("agents 服务面判不过时退回「只听 agent/created」，不抛", async () => {
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      // `listedAgents` 直接决定 `list()` 的回答：非数组（null / 字符串 / 数字）一律当空表。
      // 四个形态并发装起来再逐个断言：串行 `await` 在循环里会被 no-await-in-loop 判红，
      // 而这几份半栈彼此没有共享状态，并发与串行等价。
      const shapes: readonly (readonly unknown[])[] = [[], [null], ["nope"], [42]];
      const hosts = await Promise.all(
        shapes.map((listedAgents) =>
          startPrefixHost({ listedAgents, reply: cargoReply(CLEAN_TEXT) }),
        ),
      );
      for (const host of hosts) {
        assert.equal(host.installed, true, "服务面答得不好不该让整层不装");
        assert.equal(host.registrations.length, 0);
        // 事件入口照旧可用。
        host.withAgent();
        assert.equal(host.registrations.length, 1);
      }
    } finally {
      rtk.restore();
    }
  });

  it("list() 交回来的根本不是数组 → 当空表，退回只听 agent/created", async () => {
    // `AgentRegistry.list()` 的返回类型是 `Agent[]`，但那是编译期承诺：服务被别的实现替掉
    // （或版本线之间形状变了）时运行期可以给任何东西。非数组时**不能**去 `for...of`——
    // 那会抛 TypeError，而抛点在 `installPrefixShadow` 装配期，整层会随之不装。
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost({
        agentsListReply: { not: "an array" },
        reply: cargoReply(CLEAN_TEXT),
      });
      assert.equal(host.installed, true, "服务面答得不好不该让整层不装");
      assert.equal(host.registrations.length, 0);
      // 事件入口照旧可用。
      host.withAgent();
      assert.equal(host.registrations.length, 1);
    } finally {
      rtk.restore();
    }
  });

  it("list() 里的元素形状不对时逐个跳过，留下能用的那些", async () => {
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    // 这里的 agent 是**原样对象**（不是半栈按 id 造的），所以注册走它们自己的 `register`：
    // 由用例自己记账，判据才落在「谁真的被注册了」而不是半栈的内部表。
    const registeredInto: string[] = [];
    const okAgent = (id: string): unknown => ({
      id,
      ctx: {
        tools: {
          register: (): (() => void) => {
            registeredInto.push(id);
            return noop;
          },
        },
      },
    });
    try {
      await startPrefixHost({
        listedAgents: [okAgent("ok-1"), null, "string", { id: 42 }, okAgent("ok-2")],
        reply: cargoReply(CLEAN_TEXT),
      });
      assert.deepEqual(registeredInto, ["ok-1", "ok-2"]);
    } finally {
      rtk.restore();
    }
  });
});
