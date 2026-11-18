#!/usr/bin/env node
// @ts-check
/// <reference types="node" />
// 模型可见面四格（spec §9.5）：**真的把插件监听器驱动一遍**，再看模型会看到什么文本。
//
// 与 plan 里那版形状示意的区别：这里不走「raw 命令 vs final 命令」两次 spawn 的对比
// （那需要把包装进真 profile 并拿到凭据，沙箱里没有），而是把**同一条已知回执**喂进
// `installPostExecuteListener` 挂上的真实监听器，比较「喂进去的 value」与「拿回来的
// value」——模型看到的就是后者。中间那层 `rtk pipe` 走真的二进制，不 mock：
// mock 掉它，这一格就退化成「桩返回了什么」，正是本仓在 B 形态测试里刻意避免的。
//
// 缺 rtk 时打印 SKIP 并 exit 0：这台机器没装的东西不该让 CI 红。
import { spawnSync } from "node:child_process";
import path from "node:path";

const PKG_DIR = path.resolve(import.meta.dirname, "..");

/** 挂上来的 post-execute 监听器。 */
/**
 * @typedef {(
 *   exec: unknown,
 *   result: unknown,
 *   next: () => Promise<unknown>,
 * ) => Promise<unknown>} MountedListener
 */

/** 本脚本用到的 `ctx.subprocess.spawn` 入参。 */
/**
 * @typedef {{
 *   readonly argv: readonly string[],
 *   readonly cwd: string,
 *   readonly stdio: { readonly stdin?: { readonly data?: string } | undefined },
 *   readonly env?: Record<string, string | undefined> | undefined,
 * }} SpawnSpec
 */

/** 一格的结果。 */
/**
 * @typedef {{
 *   name: string,
 *   ok: boolean,
 *   detail: string,
 * }} Cell
 */

/**
 * 是不是一个普通对象（拿它替掉 `as` 断言：断言在 checkJs 下会被判成不安全收窄）。
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 监听器就是函数，别的一律不认。
 *
 * @param {unknown} value
 * @returns {value is MountedListener}
 */
function isMountedListener(value) {
  return typeof value === "function";
}

/**
 * 模型可见文本的度量口径：UTF-8 字节（与护栏、spill 上限同一把尺子）。
 *
 * @param {string} text
 * @returns {number}
 */
function bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 探针用的 token 定价：`ceil(字节 / 4)`。
 *
 * 真装配走 `ctx.tokenMeter`（见 lib/tokens.ts），两者密度一致、实现无关；探针只验「压不压」，
 * 不验 token 数——所以这里给确定值，不假装能复现宿主的估计。
 *
 * @param {string} text
 * @returns {number}
 */
function tokenCount(text) {
  return Math.ceil(bytes(text) / 4);
}

/**
 * 造一格（不用 class：只有一个构造函数的类会被 `no-extraneous-class` 判红）。
 *
 * @param {string} name
 * @returns {Cell}
 */
function makeCell(name) {
  return { name, ok: false, detail: "" };
}

/**
 * 二进制在不在（`command -v`）。这条路刻意同步：`node/no-sync` 在 scripts 覆盖里是关的，
 * 而这一步本来就不该跟子进程生命周期纠缠。
 *
 * @param {string} bin
 * @returns {boolean}
 */
function have(bin) {
  return spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}

/**
 * 真子进程面：形状对齐宿主的 `ctx.subprocess`（只回本插件用到的那两样）。
 *
 * 这里用同步执行：调用方拿到句柄后立刻 await `done`，中间没有别的事可做，同步跑完不会
 * 改变任何行为，却省掉一整层「子进程事件 + 手工拼 Promise」——那层东西测试夹具里有过，
 * 探针没必要再抄一遍。
 *
 * @param {SpawnSpec} spec
 * @returns {unknown}
 */
function realSpawn(spec) {
  const [bin = "", ...args] = spec.argv;
  const ran = spawnSync(bin, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    input: spec.stdio.stdin?.data ?? "",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = ran.stdout;
  return {
    done: Promise.resolve({ exitCode: ran.status, signal: ran.signal }),
    collected: { stdout: { readFrom: () => ({ text }) } },
    terminate: () => undefined,
  };
}

/** 四格里用到的固定回执（都是真跑出来的输出，改断言前先重跑一遍取新的）。 */
const FIXTURES = {
  /**
   * `cargo test` 的失败态（真跑 `cargo test` 抓的）：1 passed / 1 failed，
   * stdout 里有 `DEBUG-VISIBLE-MARKER`（`println!` 在失败用例里被 libtest 收进段内）。
   */
  cargoFail: [
    "running 2 tests",
    "test tests::adds ... ok",
    "test tests::fails_loudly ... FAILED",
    "",
    "failures:",
    "",
    "---- tests::fails_loudly stdout ----",
    "DEBUG-VISIBLE-MARKER: captured stdout line",
    "",
    "thread 'tests::fails_loudly' panicked at src/lib.rs:11:9:",
    "assertion `left == right` failed",
    "  left: 4",
    " right: 5",
    "",
    "failures:",
    "    tests::fails_loudly",
    "",
    "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  ].join("\n"),
  /** 同一份输出再叠一段够长的日志尾巴：让「压缩」这件事有确定的收益空间。 */
  logTail: Array.from({ length: 60 }, (_item, index) => `   Compiling dep-${index} v0.1.0`).join(
    "\n",
  ),
};

/**
 * 从 accept 决定里读出最终 stdout 文本；读不到就退回原文本（= 这一条没被改写）。
 *
 * 读不到不算错：`pipe` 层原样放行时本来就交回下游决定，那时模型看到的正是原文本。
 *
 * @param {unknown} decision
 * @param {string} fallback
 * @returns {string}
 */
function finalText(decision, fallback) {
  if (!isRecord(decision)) {
    return fallback;
  }
  // 先收窄再解构：`noPropertyAccessFromIndexSignature` 不许 `decision.kind`，
  // 而 `dot-notation` 又不许 `decision["kind"]`，解构是唯一同时满足两边的写法。
  const { kind, value } = decision;
  if (kind !== "accept" || !isRecord(value)) {
    return fallback;
  }
  const { stdout } = value;
  if (!isRecord(stdout)) {
    return fallback;
  }
  const { text } = stdout;
  return typeof text === "string" ? text : fallback;
}

/**
 * 装一层 B 形态监听器，返回「喂一条回执、拿最终模型可见文本」的函数。
 *
 * 用的都是生产件：`installPostExecuteListener`（`host.js` 里的真实现）、真的
 * `rtk pipe` 子进程、真的护栏与 spill。桩只有三样：设置面（本格不读文案）、
 * 统计面（本格不看重）、以及工作目录服务（回包根）。
 *
 * @param {{ readonly spill: boolean }} options
 * @returns {Promise<{
 *   readonly run: (command: string, stdout: string, stderr?: string, exitCode?: number) => Promise<{
 *     readonly decision: unknown,
 *     readonly raw: string,
 *     readonly final: string,
 *   }>,
 * }>}
 */
async function startListener(options) {
  const { installPostExecuteListener } = await import(path.join(PKG_DIR, "host.js"));
  const { createRewrittenCalls } = await import(path.join(PKG_DIR, "lib/dedup.ts"));

  /** @type {MountedListener | undefined} */
  let handler;
  const spillStore = {
    /**
     * @param {unknown} input
     * @returns {Promise<{
     *   readonly locator: string,
     *   readonly bytes: number,
     *   readonly retrievalHint: string,
     * }>}
     */
    saveText: (input) =>
      Promise.resolve({
        locator: "spill:probe",
        bytes: isRecord(input) ? 1 : 0,
        retrievalHint: "完整输出已存为 spill:probe",
      }),
  };
  const ctx = {
    /**
     * @param {string} name
     * @param {unknown} listener
     */
    on: (name, listener) => {
      if (name === "tools/post-execute" && isMountedListener(listener)) {
        handler = listener;
      }
    },
    subprocess: { spawn: realSpawn },
    workingDirectory: { ensure: () => Promise.resolve(PKG_DIR) },
    /**
     * @param {string} name
     * @returns {unknown}
     */
    get: (name) => (options.spill && name === "spillStore" ? spillStore : undefined),
  };
  // 两个入参各用 JSDoc 标成 `host.ts` 的同名类型。这不是装饰：本脚本 import 的是**编译产物**
  // `host.js`，那里没有类型信息，`tsc --checkJs` 看不到这条连接——于是 `PipeOptions` / `PipeDeps`
  // 新增必填字段时这里会静静地漂掉。真实发生过两次：`supported` 缺席让 `decide` 里
  // `input.options.supported()` 抛 TypeError 被 catch 吞成「什么都没压」（四格里三格静默退化成
  // 2040B → 2040B）；`deps.log` 缺席让「原文没落成库」那条 warn 抛同样的错。标上类型之后，
  // 缺字段是 tsc 的编译错，不再是跑出来的假绿。
  /** @type {import("../host.ts").PipeOptions} */
  const listenerOptions = {
    // 总开关现读：这个探针只验「压不压」，所以恒定打开。
    enabled: () => true,
    // 版本门也是现读：探针不验版本，恒给 true。
    supported: () => true,
    // 诊断日志默认关（与部署默认一致）。
    log: undefined,
    forms: () => ["pipe"],
    // 四处 volatile 配置项在 `PipeOptions` 里是取值函数（卡片改完下一次调用即生效）。
    enabledFilters: () => ["cargo-test"],
    minBytes: () => 16,
    minGainRatio: () => 0.95,
    stdoutCapBytes: () => 64_000,
    pipeTimeoutMs: 5000,
    vitestMaxMajor: 5,
  };
  /** @type {import("../host.ts").PipeDeps} */
  const listenerDeps = {
    messages: () => ({
      cargoTestWarnHint: "",
      spillSummary: "压缩前的完整输出已存",
      spillLocation: "压缩前的完整输出已存为 {path}。{hint}",
    }),
    rewrittenCalls: createRewrittenCalls(8),
    // 定价口径见上面的 `tokenCount`（真装配走 `ctx.tokenMeter`）。
    tokensOf: tokenCount,
    // 旧累计账本已退成「只读一次的迁移输入」，组装里不再有写面收件箱；埋点走 `insights`。
    fs: { readFile: () => Promise.resolve("") },
    // 统计埋点的收件箱：本探针只验「压不压」，一笔账都不落。这一位同样是**必填**
    // （`PipeDeps` 里没有可选形态），缺席的表现与上面 `log` 那次同形——`safeRecordPipe`
    // 把异常吞进 catch，压缩照常成功，于是探针会绿着说谎。所以这里靠类型钉住而不是靠跑。
    insights: { recordPipe: () => undefined },
    // 具名 logger 的两位：本探针不看日志，但**这一位是必填**（`finishCompressed` 在原文没落成
    // 库时会调 `deps.log.warn`）——缺席的后果与 `supported` 那次同形，见上面的注释。
    log: { info: () => undefined, warn: () => undefined },
  };
  installPostExecuteListener(ctx, listenerOptions, listenerDeps);
  if (handler === undefined) {
    throw new Error(
      "监听器没挂上：host.js 的 installPostExecuteListener 没有注册 tools/post-execute",
    );
  }
  const mounted = handler;
  return {
    /**
     * @param {string} command
     * @param {string} stdout
     * @param {string} [stderr]
     * @param {number} [exitCode]
     * @returns {Promise<{
     *   readonly decision: unknown,
     *   readonly raw: string,
     *   readonly final: string,
     * }>}
     */
    async run(command, stdout, stderr = "", exitCode = 0) {
      const withStderr = stderr === "" ? stdout : `${stdout}\n[stderr]\n${stderr}`;
      const raw = exitCode === 0 ? withStderr : `${withStderr}\n[exit code: ${exitCode}]`;
      const result = {
        isError: false,
        value: {
          kind: "foreground",
          cwd: PKG_DIR,
          exitCode,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 120_000,
          stdout: { text: raw, truncated: false },
          stderr: { text: "", truncated: false },
        },
      };
      const exec = {
        callId: "probe-call",
        name: "bash",
        arguments: { command },
        agent: { id: "probe-session" },
      };
      const decision = await mounted(exec, result, () => Promise.resolve({ kind: "accept" }));
      return { decision, raw, final: finalText(decision, raw) };
    },
  };
}

/**
 * 打印一格（`console.log` 在 scripts 里也是红的，用 stdout 直写）。
 *
 * @param {Cell} cell
 * @param {number} rawBytes
 * @param {number} finalBytes
 * @returns {void}
 */
function report(cell, rawBytes, finalBytes) {
  const mark = cell.ok ? "PASS" : "FAIL";
  process.stdout.write(`${mark} ${cell.name}: ${rawBytes}B → ${finalBytes}B ${cell.detail}\n`);
}

/**
 * 跑完四格，返回失败格名（空数组 = 全过；`"skip"` = 缺件，一格没跑）。
 *
 * @returns {Promise<string[] | "skip">}
 */
async function main() {
  if (!have("rtk")) {
    // 缺件是 SKIP，不是 PASS。早先这里 `return []` 之后主流程照常打 `PASS: 4/4 格`，
    // 于是「本机没装 rtk」与「四格全过」在输出里长得一模一样——一条拿不出证据的绿。
    process.stdout.write("SKIP: PATH 上没有 rtk（这台机器没装，不是失败；四格一格都没跑）\n");
    return "skip";
  }
  const listener = await startListener({ spill: true });
  /** @type {Cell[]} */
  const cells = [];
  const dense = `${FIXTURES.logTail}\n${FIXTURES.cargoFail}`;

  // 格 1：失败态被压小，且失败证据与退出码都还在。
  // 判据是**方向**（变小）而不是具体字节数——那个数随 rtk 版本漂移，方向不漂。
  const compress = makeCell("cargo-test-prefix");
  const flowed = await listener.run("cargo test", dense, "", 101);
  compress.ok =
    bytes(flowed.final) < bytes(flowed.raw) &&
    flowed.final.includes("fails_loudly") &&
    !flowed.final.includes("[RTK:PASSTHROUGH]");
  compress.detail = compress.ok ? "" : "(压缩没变小，或失败用例名丢了)";
  report(compress, bytes(flowed.raw), bytes(flowed.final));
  cells.push(compress);

  // 格 2：stderr 段原样保留（宿主与模型都按 `[stderr]` 前缀分流）。
  // 两件事一起判：stderr 段保住了，**而且这一条真的被压过**。只判前者会在「什么都没压」
  // 时白绿——原样输出本来就带 stderr 段，那等于没验到回填逻辑。
  const stderr = makeCell("pipe-stderr-kept");
  const withErr = await listener.run(
    "cargo test",
    dense,
    "error: test failed, to rerun pass `--lib`",
    101,
  );
  stderr.ok =
    bytes(withErr.final) < bytes(withErr.raw) &&
    withErr.final.includes("\n[stderr]\nerror: test failed");
  stderr.detail = stderr.ok ? "" : "(这一条没变小，或 stderr 段没保住)";
  report(stderr, bytes(withErr.raw), bytes(withErr.final));
  cells.push(stderr);

  // 格 3：详情 flag 必须**一点都不压**——这是「不许变小」的负例（§4.2 共用拒绝层）。
  const detail = makeCell("detail-flag-fidelity");
  const verbose = await listener.run("cargo test -- --nocapture", dense, "", 101);
  detail.ok = verbose.final === verbose.raw && verbose.final.includes("DEBUG-VISIBLE-MARKER");
  detail.detail = detail.ok ? "" : "(带 --nocapture 的输出被压了、或 marker 丢了)";
  report(detail, bytes(verbose.raw), bytes(verbose.final));
  cells.push(detail);

  // 格 4：退出码 marker 留在末行（客户端 `parseExitStatus` 锚 `$` 解析它）。
  // **用被压缩过的那条**：未压缩的输出本来就带着原样的 marker，拿它来验等于什么都没验；
  // 要被验的是「压缩把正文换掉之后，marker 有没有被重新拼回末行」。
  const marker = makeCell("marker-last-line");
  // 同样要「确实压过」：未压缩的输出本来就以 marker 结尾，只判结尾会白绿。
  marker.ok =
    bytes(flowed.final) < bytes(flowed.raw) && flowed.final.trimEnd().endsWith("[exit code: 101]");
  marker.detail = marker.ok ? "" : "(这一条没变小，或压缩后 marker 不在末行)";
  report(marker, bytes(flowed.raw), bytes(flowed.final));
  cells.push(marker);

  return cells.filter((cell) => !cell.ok).map((cell) => cell.name);
}

const failed = await main();
if (failed === "skip") {
  // 什么都不再打：SKIP 那一行已经说明白了，再加一句「全过」就是自相矛盾的绿。
  process.exitCode = 0;
} else if (failed.length > 0) {
  process.stderr.write(`FAIL: ${failed.length}/4 格不符：${failed.join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("PASS: 4/4 格\n");
}
