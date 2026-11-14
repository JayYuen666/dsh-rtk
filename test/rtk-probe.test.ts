// test/rtk-probe.test.ts —— `readRtkVersion` 的回执归一。
//
// 它只服务设置卡的 readiness 行（「解析到的二进制 + 版本」），不参与任何门禁；因此这里测的是
// 「探测失败不该让装配失败」这条契约：超时、非零退出、被信号杀、spawn 抛错、空回执，全部给
// `undefined` 而不是抛。子进程面整个桩掉，不 spawn 真的 rtk。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import type { HostContext, SubprocessFace } from "../host.ts";
import { readRtkVersion } from "../host.ts";

/** 一条受控回执。`hang` 时永不自己结束、只等 signal abort（用来测 2000ms 探测预算）。 */
interface ProbeReply {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly signal?: string | null;
  readonly hang?: boolean;
  readonly throws?: boolean;
  /** 宿主契约里 stdout 面是可选的：这一位造出「进程跑完了但读不到 stdout」的形态。 */
  readonly noStdout?: boolean;
}

/** 造一个只回一条 `rtk --version` 回执的子进程面，并记录 terminate 被调了几次。 */
function probeSubprocess(reply: ProbeReply): SubprocessFace & { readonly terminated: number[] } {
  const terminated: number[] = [];
  return {
    terminated,
    spawn(spec) {
      if (reply.throws === true) {
        throw new Error("spawn failed");
      }
      const { promise, resolve } = Promise.withResolvers<{
        readonly exitCode: number | null;
        readonly signal: string | null;
      }>();
      if (reply.hang === true) {
        spec.signal?.addEventListener(
          "abort",
          () => {
            resolve({ exitCode: null, signal: "SIGTERM" });
          },
          { once: true },
        );
      } else {
        resolve({ exitCode: reply.exitCode, signal: reply.signal ?? null });
      }
      return {
        done: promise,
        collected:
          reply.noStdout === true ? {} : { stdout: { readFrom: () => ({ text: reply.stdout }) } },
        terminate: () => {
          terminated.push(1);
        },
      } as never;
    },
  };
}

/** `readRtkVersion` 只碰 subprocess 那一句；其余三处给占位即可，它不会读。 */
function hostWith(subprocess: SubprocessFace): HostContext {
  return {
    tools: {
      get: (): undefined => undefined,
    },
    subprocess,
    workingDirectory: { ensure: async () => process.cwd() },
    on: (): void => {
      // readRtkVersion 不订阅任何事件。
    },
  };
}

describe("readRtkVersion", () => {
  it("rc=0 时回 trim 过的原文", async () => {
    const subprocess = probeSubprocess({ exitCode: 0, stdout: "rtk 1.2.0\n" });
    assert.equal(await readRtkVersion(hostWith(subprocess)), "rtk 1.2.0");
  });

  it("rc=0 但回执是空白时 undefined（探到个空串不算探到版本）", async () => {
    const subprocess = probeSubprocess({ exitCode: 0, stdout: "   \n" });
    assert.equal(await readRtkVersion(hostWith(subprocess)), undefined);
  });

  it("stdout 面整个缺席时 undefined（不是抛错）", async () => {
    const subprocess = probeSubprocess({ exitCode: 0, noStdout: true, stdout: "" });
    assert.equal(await readRtkVersion(hostWith(subprocess)), undefined);
  });

  it("非零退出时 undefined", async () => {
    const subprocess = probeSubprocess({ exitCode: 1, stdout: "boom" });
    assert.equal(await readRtkVersion(hostWith(subprocess)), undefined);
  });

  it("被信号杀时 undefined", async () => {
    const subprocess = probeSubprocess({ exitCode: null, stdout: "partial", signal: "SIGTERM" });
    assert.equal(await readRtkVersion(hostWith(subprocess)), undefined);
  });

  it("spawn 抛错时 undefined（ENOENT 不该让装配失败）", async () => {
    const subprocess = probeSubprocess({ throws: true, exitCode: 0, stdout: "" });
    assert.equal(await readRtkVersion(hostWith(subprocess)), undefined);
  });

  it("进程不结束时按 2000ms 预算放弃，且 terminate 照常调用", async () => {
    const subprocess = probeSubprocess({ exitCode: null, stdout: "", hang: true });
    const started = Date.now();
    const version = await readRtkVersion(hostWith(subprocess));
    const elapsed = Date.now() - started;
    assert.equal(version, undefined);
    assert.ok(elapsed >= 1800, `预算没跑满就返回了：${elapsed}ms`);
    assert.ok(elapsed < 4000, `预算没生效：${elapsed}ms`);
    assert.equal(subprocess.terminated.length, 1);
  }, 10_000);

  it("成功路径也调用 terminate（finally 里无条件收尾，幂等）", async () => {
    const subprocess = probeSubprocess({ exitCode: 0, stdout: "rtk 1.2.0\n" });
    await readRtkVersion(hostWith(subprocess));
    assert.equal(subprocess.terminated.length, 1);
  });
});
