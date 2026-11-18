// test/prefix-integration.test.ts —— C 形态（per-agent 遮蔽 bash）的装配序。
//
// 全部用例直驱 `installPrefixShadow` 装配出来的那个工具体，不经过 apply 与 cordis 的配置投影：
// 本函数的设计就是只吃已解析的值，于是这里能精确控制每一步门禁、并断言「最后转调的是哪条命令」。
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  installFakeRtk,
  makeCleanups,
  recordingSubprocess,
  startPrefixHost,
} from "./integration/host-stack.ts";
import { unbuildableDir } from "./unbuildable.ts";
import { forceShadowPlatform } from "./platform/host-platform.ts";

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

/** 库文件的两个名字：与 `lib/rtk-paths.ts` 的取值同形（这里不 import，避免测被测的表）。 */
const LEDGER_DIR = "rtk";
const LEDGER_FILE = "history.db";

/**
 * 账本库在某个 root 下的路径。
 *
 * 提成函数而不是就地写字面量：同一个形状在几条用例里出现（建得出来 / 建不出来 / 故障播报），
 * 而 `sonarjs(no-duplicate-string)` 数到三次就红——更重要的是，路径形状本身就是被测约定
 * （`$DSH_HOME/rtk/history.db`），写在一个地方才改得动。
 * @param root - 假 home
 * @returns 库文件路径
 */
const ledgerPathUnder = (root: string): string => path.join(root, LEDGER_DIR, LEDGER_FILE);

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
 * C 形态的装配与行为判据在**三个平台**上都要跑。原先这里整片 `skipIf(!POSIX_ONLY)`，理由是
 * 两条——两条现在都不再成立：
 *
 *   1. **实现侧**：`prefixSupportedOn("win32")` 判否，`installPrefixShadow` 在平台门禁处直接
 *      return。那条**产品决定**不变（rtk 的 Windows 分发面与 pwsh 命令形态没在真机验过），
 *      由 `test/platform/platform.test.ts` 显式注入 win32 断言「整层不装」。但本文件验的是
 *      门禁**之后**的逻辑（装配序、埋点时机、argv 形状、sandbox 登记），与宿主是不是 Windows
 *      无关，所以用 `forceShadowPlatform()` 把宿主平台值换成受支持档——判据不变形，只是不再
 *      因为宿主 OS 而缺席。
 *   2. **夹具侧**：假 rtk 早先是「PATH 上一个 0755 的 node 脚本、靠裸名被 `spawn` 找到」。
 *      现在 `installFakeRtk` 把它拆成两件事：PATH 上那个文件只过装配期门禁（win32 档的
 *      裸名候选足够），真正的子进程面是内存桩（`lib/cli.ts` 的 `spawn({argv})` 在 Windows 上
 *      不做 PATHEXT 解析，造不出跨平台可执行的假 rtk——细节见 `installFakeRtk` 的注释）。
 */
const restorePlatform = forceShadowPlatform();

describe("c 形态", () => {
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
      // 这一条钉的是「装配期不判总开关」：`enabled` 显式关着（未显式设置时跟随 rtk 就绪状态），
      // 而用户是在卡片上打开它的。
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
      // 用户真实路径：装好插件（`enabled` 还没打开）→ 在卡片上打开 → 下一次 cargo test 被改写。
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

    it("enabledForms 不含 prefix 时仍装遮蔽层，运行期切到 prefix 后立刻改写", async () => {
      // 热切换判据：装配期不再按 forms 决定装不装；层常驻，execute 每次现读 forms。
      // 先关着跑一次必须原样转调（不 spawn 改写），再把 forms 改成含 prefix，
      // 同一条遮蔽体下一次调用就必须改写——不重新 apply、不重启宿主。
      let forms: readonly string[] = [];
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const host = await startPrefixHost({ options: { forms: () => forms } });
        assert.equal(host.installed, true);
        const shadow = host.withAgent();
        await shadow.execute({ command: CARGO_TEST }, exec({ callId: "call-forms-off" }));
        assert.equal(rtk.spawned(), 0);
        assert.deepEqual(host.fake.received, [CARGO_TEST]);
        forms = ["prefix"];
        await shadow.execute({ command: CARGO_TEST }, exec({ callId: "call-forms-on" }));
        assert.equal(rtk.spawned(), 1);
        assert.deepEqual(host.fake.received, [CARGO_TEST, RTK_CARGO_TEST]);
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

    it("复合命令逐段改写：只换承载输出的那一段，前面那段原样留在命令里", async () => {
      // 早期版本在这里断言「复合命令不进 spawn」——那是 `COMPOUND` 一律整条拒的年代。改判之后
      // 这一格必须反过来验：`cd /tmp && cargo test` 会真的去 spawn `rtk rewrite`，产物的形态是
      // `cd /tmp && rtk cargo test`（rtk 自己逐段改写，见 discover/registry.rs 的 rewrite_compound），
      // 校验层按段核对通过后，转调原工具时携带的也是这个形态。
      const compound = "cd /tmp && cargo test";
      const rewritten = "cd /tmp && rtk cargo test";
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: rewritten }]);
      try {
        const host = await startPrefixHost();
        await host
          .withAgent()
          .execute({ command: compound }, exec({ arguments: { command: compound } }));
        assert.equal(rtk.spawned(), 1);
        assert.deepEqual(host.fake.received, [rewritten]);
      } finally {
        rtk.restore();
      }
    });

    it("复合命令里有一段过不了闸门时：只还原那一段，其余段照样改写", async () => {
      // 用户裁定（2026-11）：默认形态是「rtk 支持什么就改写什么」，所以 `git diff` 这类
      // 被放进改写范围；但 `aws` 仍要拦（命令不存在时退出码 127 变 1，结论会变错）。
      //
      // `rtk rewrite` 自己是逐段改写的，它会把 `aws s3 ls` 也加上前缀（实测两段都加），
      // 所以「整条交出去」之后必须由 `restoreGatedSegments` 把那一段收回原文——这一格钉的
      // 就是那个还原：转调出去的命令是 `aws s3 ls && rtk cargo test`，不是 rtk 的原文。
      const compound = "aws s3 ls && cargo test";
      const rtkSays = "rtk aws s3 ls && rtk cargo test";
      const restored = "aws s3 ls && rtk cargo test";
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: rtkSays }]);
      try {
        const host = await startPrefixHost();
        await host
          .withAgent()
          .execute({ command: compound }, exec({ arguments: { command: compound } }));
        assert.equal(rtk.spawned(), 1);
        assert.deepEqual(host.fake.received, [restored]);
      } finally {
        rtk.restore();
      }
    });

    it("复合命令的改写被拆开/换分隔符时不采用（校验层按段拦）", async () => {
      // 反向判据：产物把两段并成一段（`not-segmentable`）时，命令必须原样执行——
      // 「按段校验」这个改动的全部意义就在这一格。
      const compound = "cd /tmp && cargo test";
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: "rtk cargo test" }]);
      try {
        const host = await startPrefixHost();
        await host
          .withAgent()
          .execute({ command: compound }, exec({ arguments: { command: compound } }));
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
        // 相对 workdir 是**原样追加**，不重写它内部的分隔符：宿主 `dsh-tool-bash` 的
        // `resolveWorkdir(modelWorkdir, sessionCwd)` 只有一句 `${sessionCwd}${sep}${modelWorkdir}`
        // （`packages/shell/tool-bash/src/index.ts:177-183`），模型传 `pkgs/app` 它也只补中间那一个
        // sep。早先这条断言写成了两个 sep 都被替换，于是**只在 Windows 上红**——POSIX 下 `/` 恰好
        // 等于 sep，两种写法同形，把那处不一致盖住了（`test/post-execute.test.ts:664` 同一轮里
        // 已经踩过一次并修好，这里是第二处）。
        assert.equal(subprocess.calls[0]?.cwd, `${WORKSPACE_CWD}${path.sep}pkgs/app`);
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

  describe("c 形态：另一个实例先到时让路", () => {
    it("解析出来的 bash 已经是本插件的遮蔽体 → 不再注册、只留一行日志", async () => {
      // 真机现场：market 的热挂子树用 `file://…/host.js` 直连产物，与 bundle 层的裸包名解析到
      // **同一个模块实例**，但两条层条目各起一个 fiber、各跑一次 apply。第一份注册完，第二份的
      // `get("bash", agent)` 拿到的就是那份遮蔽体；照旧 register 会让宿主抛
      // `tool "bash" is already registered in this scope`，把整条插件打成 failed。
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      try {
        const first = await startPrefixHost({ reply: cargoReply(CLEAN_TEXT) });
        const shadow = first.withAgent();
        // 第二份装配：把第一份的遮蔽体当作「解析到的 bash」交给它。
        const logs: string[] = [];
        const second = await startPrefixHost({
          bash: shadow,
          log: (line) => {
            logs.push(line);
          },
        });
        // 第二份的遮蔽体只在 agent 出现时才装（`agent/created`），所以让路也发生在那一下。
        assert.throws(
          () => {
            second.withAgent();
          },
          /遮蔽层没有注册任何工具体/u,
          "同层已被本插件遮蔽体占据时不该再注册一次",
        );
        assert.equal(second.registrations.length, 0, "注册表里一条都不该有");
        assert.equal(
          logs.includes("[rtk] prefix: another instance already installed the shadow; skipping"),
          true,
          "让路必须留一行可查的日志：不然「功能没了但一切正常」没有线索",
        );
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

  describe("c 形态：账本注入与沙箱登记", () => {
    /**
     * 这一组钉两件事：**命令前面挂上 `RTK_DB_PATH`** 与**目录被登记成可写根**。
     *
     * 为什么非有不可：注入是「只统计 dsh 会话」的机制本体——漏了它，rtk 会把行记进用户的全局
     * 账本，页面上就会混进用户自己终端跑的命令（真机症状：改写成功 0 次却省了 1.7M token）。
     * 沙箱登记漏了则是记账 EACCES 静默失败，Insights 页永远空、日志里一个字都没有。
     */
    it("账本目录建得出来时，命令带 RTK_DB_PATH 转发，且目录被登记成可写根", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      const root = mkdtempSync(path.join(tmpdir(), "rtk-ledger-home-"));
      cleanups.push(root);
      // 父目录还不存在正是真实装配的形状：第一次跑永远没有 `$DSH_HOME/rtk`。
      const dbPath = ledgerPathUnder(root);
      const registered: string[] = [];
      try {
        const host = await startPrefixHost({
          reply: cargoReply(CLEAN_TEXT),
          options: { trackingDbPath: dbPath },
          sandboxPolicy: {
            registerWritableRoot: (_session: unknown, dir: string): (() => void) => {
              registered.push(dir);
              return noop;
            },
          },
        });
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        // 命令带着注入的赋值转发：改写出来的 `rtk cargo test` 因此只往 dsh 自己的库记账。
        assert.deepEqual(host.fake.received, [`RTK_DB_PATH='${dbPath}' ${RTK_CARGO_TEST}`]);
        // 登记的是**目录**而不是那个 .db 文件：`registerWritableRoot` 拒收非目录。
        // 期望值按物理路径写：宿主拿 `realpathSync` 的结果与原文比，macOS 上 tmpdir 的
        // `/var/...` 物理路径是 `/private/var/...`，登记原文会被判成符号链接而抛错。
        assert.deepEqual(registered, [realpathSync.native(path.dirname(dbPath))]);
      } finally {
        rtk.restore();
      }
    });

    it("账本目录建不出来时：照样注入、不登记、日志点名", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      // 父级放一个普通文件：`mkdirSync(recursive)` 在三个平台上都必然失败。早先这里写的是
      // `/dev/null`，靠「字符设备下面建不了目录」——那条只在 POSIX 成立，Windows 上
      // `/dev/null` 是个普通路径段，`mkdir -p` 会把它建出来，于是这条用例在 windows CI 上
      // 走的是**建得出来**那一支（实测红）。
      const dbPath = ledgerPathUnder(unbuildableDir());
      const lines: string[] = [];
      const registered: string[] = [];
      try {
        const host = await startPrefixHost({
          reply: cargoReply(CLEAN_TEXT),
          options: {
            trackingDbPath: dbPath,
            log: (line) => {
              lines.push(line);
            },
          },
          sandboxPolicy: {
            registerWritableRoot: (_session: unknown, dir: string): (() => void) => {
              registered.push(dir);
              return noop;
            },
          },
        });
        assert.equal(host.installed, true, "建不出目录不该让整层不装");
        await host.withAgent().execute({ command: CARGO_TEST }, exec());
        // 判据三件：**照样注入**、不登记、日志里有一句能查的话。
        //
        // 「照样注入」是这一条真正的牙齿，而且方向与直觉相反：早先那一版在目录建不出来时
        // 清空注入路径，理由写的是「让它落回全局账本，总比命令跑不起来好」——那句理由是错的。
        // rtk 拿不到 `RTK_DB_PATH` 时会退回它自己 `get_db_path()` 的默认，把 dsh 会话的每一行
        // 写进**用户终端那份全局账本**（实测：`HOME=<空目录> rtk git status` 会在
        // `~/Library/Application Support/rtk/history.db` 建库并写 1 行）。有了变量但目录写不进去时，
        // rtk 是**静默丢掉那一行**（exit 0、stdout 正常、stderr 零字节）：少记一行只是「统计不可用」，
        // 记进别人的账本则是污染用户数据。两者不在一个量级，所以这里必须继续注入。
        assert.deepEqual(host.fake.received, [`RTK_DB_PATH='${dbPath}' ${RTK_CARGO_TEST}`]);
        assert.deepEqual(registered, []);
        // 两行：装配期那句「建不出来」在前，执行期那句 `rewrite: a -> b` 在后。
        // 不能只断言 `lines.length === 1`——那会把「诊断日志还开着」这件既有行为判成缺陷。
        assert.equal(lines.length, 2);
        assert.match(lines[0] ?? "", /cannot prepare .* statistics will report themselves/u);
      } finally {
        rtk.restore();
      }
    });

    /**
     * `warn` 是**默认就能看到**的那条播报口，与 `log`（`logFilterMode: 'on'` 才有）分开。
     *
     * 为什么非有不可：默认配置下 `log` 是 `undefined`，如果故障只往那里写，症状就只剩
     * 「Insights 页永远空白」——用户分不出「没采到」与「没数据」。这一条把两条故障都走一遍：
     * 目录建不出来、以及沙箱不给登记。
     */
    it("故障播报走 warn：目录建不出来时不留白，沙箱拒绝登记时也留一句", async () => {
      const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
      const warns: string[] = [];
      try {
        // 一、目录建不出来：父级是普通文件，三个平台都必然失败。只给 `warn`、不给 `log`。
        const brokenHost = await startPrefixHost({
          reply: cargoReply(CLEAN_TEXT),
          options: {
            trackingDbPath: ledgerPathUnder(unbuildableDir()),
            warn: (line) => {
              warns.push(line);
            },
          },
        });
        assert.equal(brokenHost.installed, true);
        assert.equal(warns.length, 1);
        assert.match(warns[0] ?? "", /cannot prepare .* statistics will report themselves/u);

        // 二、目录建得出来，但沙箱拒绝登记：同样是「记账这条链断了」，同样要留痕。
        const root = mkdtempSync(path.join(tmpdir(), "rtk-ledger-warn-"));
        cleanups.push(root);
        warns.length = 0;
        const refusedHost = await startPrefixHost({
          reply: cargoReply(CLEAN_TEXT),
          options: { trackingDbPath: ledgerPathUnder(root) },
          sandboxPolicy: {
            registerWritableRoot: (): (() => void) => {
              throw new Error("SANDBOX_INVALID_ROOT");
            },
          },
          warn: (line) => {
            warns.push(line);
          },
        });
        // 登记失败不让整层失效：命令照旧带注入转发。
        await refusedHost.withAgent().execute({ command: CARGO_TEST }, exec());
        assert.equal(refusedHost.fake.received.length, 1);
        assert.equal(warns.length, 1);
        assert.match(warns[0] ?? "", /cannot grant .* bookkeeping will fail silently/u);
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

// 与上面同一个理由：晚装载验的也是 C 形态的装配路径，宿主平台值已由 `forceShadowPlatform()`
// 换成受支持档，所以这一组在三个 runner 上都跑。
//
// 收摊挂在这一组上，因为它**是文件里最后一个 describe**：describe 的 hook 在该 describe 跑完
// 时触发，注册顺序即执行顺序。早先 `afterAll` 挂在第一个 describe 上，于是「晚装载」这组拿到
// 的是已经还原的平台值——win32 模拟下整层不装、断言 0 !== 1（实测症状）。`afterAll` 又不许
// 写在顶层（`vitest(no-top-level-after-all)`），所以位置只有一个。
describe("晚装载：装配时已经存在的 agent 也要被遮蔽", () => {
  afterAll(() => {
    restorePlatform();
    cleanups.drain();
  });

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
