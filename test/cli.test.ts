// lib/cli.ts 单测：两个子进程形态各自的 argv / env / 超时 / 失败归因。
//
// 这一层只做「跑一次、把 stdout 读回来、失败不抛」。退出码的语义留给 lib/rewrite.ts 解释，
// 压缩结果的取舍留给上层护栏——所以这里的判据都落在「进程怎么起、回执怎么折」上。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { RTK_PIPE_ENV, RTK_REWRITE_ENV, runRtkPipe, runRtkRewrite } from "../lib/cli.ts";
import type { SubprocessFace, SubprocessFaceHandle } from "../lib/cli.ts";
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";

const CARGO_TEST = "cargo test";
const RTK_CARGO_TEST = "rtk cargo test";
const TMP = "/tmp";

interface FakeOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** 造一个回固定回执的进程面；`calls` 收每次 spawn 的 spec，`terminated` 收 terminate 次数。 */
function fakeFace(
  outcome: FakeOutcome,
  text: string,
): {
  calls: SubprocessSpawnSpec[];
  terminated: { count: number };
  face: SubprocessFace;
} {
  const calls: SubprocessSpawnSpec[] = [];
  const terminated = { count: 0 };
  const face: SubprocessFace = {
    spawn: (spec) => {
      calls.push(spec);
      return {
        done: Promise.resolve(outcome),
        collected: { stdout: { readFrom: () => ({ text }) } },
        terminate: () => {
          terminated.count += 1;
        },
      };
    },
  };
  return { calls, terminated, face };
}

/** 幂等的 terminate 桩：没有返回值，也不读任何状态。 */
function noop(): void {
  // 什么都不做。
}

/**
 * spawn 起不来的那一路。真宿主的形状是 `spawn()` 正常返回 handle、`handle.done` reject
 * （见 `SubprocessHandle.done` 的注释：'rejects for spawn or provider failures'），
 * 所以桩也必须复刻这一层，而不是让 spawn 自己抛。
 */
function brokenFace(): SubprocessFace {
  return {
    spawn: (): SubprocessFaceHandle => ({
      done: Promise.reject(new Error("spawn rtk ENOENT")),
      collected: { stdout: { readFrom: () => ({ text: "" }) } },
      terminate: noop,
    }),
  };
}

/** 没请求 collect 的进程面：`collected.stdout` 缺席（读回来只能是空串）。 */
function noCollectFace(): SubprocessFace {
  return {
    spawn: () => ({
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {},
      terminate: noop,
    }),
  };
}

/** 一直不结束、直到 signal abort 才 resolve 的进程面（覆盖超时那一路）。 */
function stalledFace(): SubprocessFace {
  return {
    spawn: (spec) => {
      const { promise, resolve } = Promise.withResolvers<FakeOutcome>();
      spec.signal?.addEventListener("abort", () => {
        resolve({ exitCode: null, signal: "SIGTERM" });
      });
      return {
        done: promise,
        collected: { stdout: { readFrom: () => ({ text: "late" }) } },
        terminate: noop,
      };
    },
  };
}

function pipeOpts(face: SubprocessFace, timeoutMs = 3000): Parameters<typeof runRtkPipe>[0] {
  return { subprocess: face, filter: "cargo-test", stdin: "x", cwd: TMP, timeoutMs };
}

function rewriteOpts(
  face: SubprocessFace,
  env: Record<string, string> = {},
): Parameters<typeof runRtkRewrite>[0] {
  return {
    command: CARGO_TEST,
    cwd: TMP,
    signal: new AbortController().signal,
    timeoutMs: 2000,
    env,
    subprocess: face,
  };
}

describe("runRtkPipe", () => {
  it("argv / env 四枚 / stdin / graceMs", async () => {
    const fake = fakeFace({ exitCode: 0, signal: null }, "cargo test: 1 passed");

    const result = await runRtkPipe(pipeOpts(fake.face));

    assert.deepEqual(result, { ok: true, stdout: "cargo test: 1 passed" });
    const [spec] = fake.calls;
    assert.ok(spec !== undefined);
    assert.deepEqual(spec.argv, ["rtk", "pipe", "-f", "cargo-test"]);
    const env = spec.env ?? {};
    assert.equal(env["RTK_RECALL"], "0");
    assert.equal(env["RTK_TEE"], "0");
    assert.equal(env["RTK_NO_TOML"], "1");
    assert.equal(env["RTK_TELEMETRY_DISABLED"], "1");
    assert.deepEqual(spec.stdio.stdin, { data: "x" });
    // pipe 的宽限期一直是调用方预算（`pipeOpts` 传 3000）。
    assert.equal(spec.graceMs, 3000);
  });

  it("被信号杀掉判失败", async () => {
    const fake = fakeFace({ exitCode: null, signal: "SIGTERM" }, "");

    assert.deepEqual(await runRtkPipe(pipeOpts(fake.face)), { ok: false, stdout: "" });
  });

  it("信号优先于退出码（0 也算失败）", async () => {
    // 宿主约定「exitCode 为 null 当且仅当死于信号」，但假回执可以两边都给；
    // 判据写成 signal 先判，是为了不依赖那条约定在每家 provider 上都成立。
    const fake = fakeFace({ exitCode: 0, signal: "SIGTERM" }, "partial");

    assert.deepEqual(await runRtkPipe(pipeOpts(fake.face)), { ok: false, stdout: "" });
  });

  it("退出码非 0 判失败", async () => {
    const fake = fakeFace({ exitCode: 1, signal: null }, "garbage");

    assert.deepEqual(await runRtkPipe(pipeOpts(fake.face)), { ok: false, stdout: "" });
  });

  it("spawn reject（ENOENT）判失败", async () => {
    const face = brokenFace();

    assert.deepEqual(await runRtkPipe(pipeOpts(face)), { ok: false, stdout: "" });
  });

  it("没请求 collect 面时不崩，按空输出判", async () => {
    const face = noCollectFace();
    const piped = await runRtkPipe(pipeOpts(face));
    const rewritten = await runRtkRewrite(rewriteOpts(face));

    assert.deepEqual(piped, { ok: true, stdout: "" });
    assert.equal(rewritten?.stdout, "");
  });

  it("超时 abort 判失败", async () => {
    // abort 之后 done 照常 resolve，只是 signal 非空、exitCode 为 null——超时不是异常。
    const result = await runRtkPipe(pipeOpts(stalledFace(), 5));

    assert.deepEqual(result, { ok: false, stdout: "" });
  });
});

describe("runRtkRewrite", () => {
  it("argv / env 三枚 / 可选 RTK_REWRITE_HOST", async () => {
    const fake = fakeFace({ exitCode: 3, signal: null }, RTK_CARGO_TEST);

    const result = await runRtkRewrite(rewriteOpts(fake.face, { RTK_REWRITE_HOST: "openclaw" }));

    assert.deepEqual(result, { exitCode: 3, stdout: RTK_CARGO_TEST });
    const [spec] = fake.calls;
    assert.ok(spec !== undefined);
    assert.deepEqual(spec.argv, ["rtk", "rewrite", CARGO_TEST]);
    assert.deepEqual(spec.env, { RTK_REWRITE_HOST: "openclaw" });
  });

  it("rewrite 的宽限期等于调用方预算（不写死常量）", async () => {
    // 早先这里是常量 1000，而期限（AbortSignal.timeout(rewriteTimeoutMs)，默认 2000）归调用方：
    // 调大 rewriteTimeoutMs 只延后「放弃等待」的时刻，进程管理器仍按 1 秒余量收尾。
    const fake = fakeFace({ exitCode: 0, signal: null }, RTK_CARGO_TEST);
    await runRtkRewrite({ ...rewriteOpts(fake.face), timeoutMs: 2000 });
    const [spec] = fake.calls;
    assert.ok(spec !== undefined);
    assert.equal(spec.graceMs, 2000);
  });

  it("rewrite 的常量里没有 RTK_NO_TOML（带上会丢掉 TOML-only 那 15 条改写面）", async () => {
    const fake = fakeFace({ exitCode: 3, signal: null }, RTK_CARGO_TEST);

    await runRtkRewrite(rewriteOpts(fake.face));

    assert.equal(Object.hasOwn(RTK_REWRITE_ENV, "RTK_NO_TOML"), false);
    assert.equal(RTK_PIPE_ENV.RTK_NO_TOML, "1");
  });

  it("stdout 去尾空白", async () => {
    const fake = fakeFace({ exitCode: 3, signal: null }, `${RTK_CARGO_TEST}   \n\n`);

    assert.deepEqual(await runRtkRewrite(rewriteOpts(fake.face)), {
      exitCode: 3,
      stdout: RTK_CARGO_TEST,
    });
  });

  it("rc=1 / rc=2 原样交回（由编排层判原样）", async () => {
    const fakeOne = fakeFace({ exitCode: 1, signal: null }, "");
    const fakeTwo = fakeFace({ exitCode: 2, signal: null }, "");

    const [one, two] = await Promise.all([
      runRtkRewrite(rewriteOpts(fakeOne.face)),
      runRtkRewrite(rewriteOpts(fakeTwo.face)),
    ]);

    assert.deepEqual(one, { exitCode: 1, stdout: "" });
    assert.deepEqual(two, { exitCode: 2, stdout: "" });
  });

  it("被信号杀掉 → exitCode null", async () => {
    const fake = fakeFace({ exitCode: null, signal: "SIGTERM" }, "");

    assert.deepEqual(await runRtkRewrite(rewriteOpts(fake.face)), { exitCode: null, stdout: "" });
  });

  it("没有退出码也没有信号 → exitCode null", async () => {
    // 反常回执（provider 没观察到退出事实）：按「没有退出码」处理，不把半截 stdout 当改写。
    const fake = fakeFace({ exitCode: null, signal: null }, RTK_CARGO_TEST);

    assert.deepEqual(await runRtkRewrite(rewriteOpts(fake.face)), { exitCode: null, stdout: "" });
  });

  it("spawn 抛错 → undefined（不抛给调用方）", async () => {
    const face = brokenFace();

    assert.equal(await runRtkRewrite(rewriteOpts(face)), undefined);
  });

  it("调用方 signal 已 abort → 不发 spawn", async () => {
    const fake = fakeFace({ exitCode: 3, signal: null }, RTK_CARGO_TEST);
    const controller = new AbortController();
    controller.abort();

    const result = await runRtkRewrite({
      command: CARGO_TEST,
      cwd: TMP,
      signal: controller.signal,
      timeoutMs: 2000,
      env: {},
      subprocess: fake.face,
    });

    assert.equal(result, undefined);
    assert.equal(fake.calls.length, 0);
  });
});
