// test/integration/official-contract.test.ts —— 独立 oracle：期望值来自 README 的公开契约与
// 官方 tool-bash 的 output schema，不从本包实现推导。它回答的是「测试是不是照源码抄的」：
// 每一条断言都能指到一个实现之外的事实来源。
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { afterAll, assert, beforeAll, describe, it } from "vitest";

import plugin from "../../host.ts";

import {
  installFakeRtk,
  makeCleanups,
  probeRealRtk,
  realSubprocess,
  rtkTestMode,
  spillStub,
  startPipeHost,
  startPrefixHost,
} from "./host-stack.ts";

const cleanups = makeCleanups();

const mode = rtkTestMode();

/** README「设置项」表的值：这张表是给用户的公开契约，期望值照抄它，不读实现的默认分支。 */
const DOCUMENTED_DEFAULTS: Record<string, unknown> = {
  enabledForms: ["prefix"],
  denyCommands: [],
  enabledFilters: ["git-log", "git-diff", "git-status", "grep", "find", "vitest", "window", "hook"],
  minBytes: 256,
  minGainRatio: 0.95,
  stdoutCapBytes: 64_000,
  windowHeadLines: 50,
  windowTailLines: 200,
  warnHint: true,
  rewriteHostEnv: "",
  pipeTimeoutMs: 3000,
  rewriteTimeoutMs: 2000,
  rewriteCacheSize: 256,
  vitestMaxMajor: 5,
  logFilterMode: "off",
};

const valueOf = (value: unknown): unknown => {
  if (typeof value === "object" && value !== null && "get" in value) {
    const accessor = value as { get: () => unknown };
    return accessor.get();
  }
  return value;
};

const resolvedConfig = (): Record<string, unknown> => {
  const schema = plugin.Config as unknown as (
    value: Record<string, unknown>,
  ) => Record<string, unknown>;
  return schema({});
};

const rawReceipt = (): string =>
  `running 1 test\ntest result: ok. 1 passed; 0 failed\n${"log line\n".repeat(40)}[exit code: 0]`;

const outputSchemaOf = (tool: Record<string, unknown>): Record<string, unknown> => {
  const { output } = tool;
  assert.ok(typeof output === "object" && output !== null, "遮蔽体没有 output");
  const { schema } = output as Record<string, unknown>;
  assert.ok(typeof schema === "object" && schema !== null, "遮蔽体没有 output.schema");
  return schema as Record<string, unknown>;
};

describe("官方契约台架", () => {
  afterAll(() => {
    cleanups.drain();
  });

  describe("公开设置表就是真 schema 的默认值", () => {
    it("14 个有静态默认的键逐一对上公开表", () => {
      const config = resolvedConfig();
      for (const [key, expected] of Object.entries(DOCUMENTED_DEFAULTS)) {
        assert.deepEqual(valueOf(config[key]), expected, `${key} 与 README 的设置表不一致`);
      }
    });

    it("enabled 没有静态默认：未显式设置时必须是 undefined，由就绪探测决定", () => {
      assert.equal(valueOf(resolvedConfig()["enabled"]), undefined);
    });
  });

  describe("官方 tool-bash 的 output.schema 接受插件送回的值", () => {
    let rtkVersion: string | undefined;

    beforeAll(async () => {
      rtkVersion = await probeRealRtk();
      if (mode === "real" && rtkVersion === undefined) {
        throw new Error(
          "DSH_RTK_TEST_MODE=real 但 PATH 上没有 rtk：先 brew install rtk，或把开关设成 fake / auto",
        );
      }
    });

    it("pipe 接受后的 value 仍是合法 bash 回执，退出 marker 原样在末尾", async ({ skip }) => {
      if (mode === "fake" || rtkVersion === undefined) {
        skip(mode === "fake" ? "DSH_RTK_TEST_MODE=fake" : "PATH 上没有 rtk");
      }
      const fake = installFakeRtk(cleanups.dirs, [{ exitCode: 0, stdout: "rtk cargo test" }]);
      const prefixHost = await startPrefixHost({ subprocess: fake.subprocess });
      try {
        const shadow = prefixHost.withAgent("schema-agent") as unknown as Record<string, unknown>;
        const schema = outputSchemaOf(shadow);
        // 前缀门禁已经过：把假 rtk 从 PATH 上撤掉，下面这条 pipe 要用真 rtk。
        fake.restore();
        const host = startPipeHost({
          subprocess: realSubprocess(),
          spillStore: spillStub(),
          pipeTimeoutMs: 3000,
        });
        const out = await host.run(rawReceipt(), { command: "cargo test" });
        const decision = out.decision as
          | { readonly kind?: string; readonly value?: Record<string, unknown> }
          | undefined;
        assert.equal(decision?.kind, "accept");
        const value = decision?.value;
        assert.ok(typeof value === "object", "接受的 decision 没有 value");
        // 官方校验器 + 官方 schema：插件改写的 stdout 不能破坏回执形状。
        validateJsonSchemaValue(schema, value, "value");
        const stdout = value["stdout"] as Record<string, unknown>;
        const { text } = stdout;
        assert.equal(typeof text, "string");
        assert.ok((text as string).endsWith("[exit code: 0]"), "退出 marker 必须留在末尾");
        host.dispose();
      } finally {
        await prefixHost.disposeFiber();
        fake.restore();
      }
    });
  });
});
