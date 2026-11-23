// dsh-rtk 真 Loader 装载回路 —— 走宿主真实的 ES 模块命名空间入口，而不是 ctx.plugin。
//
// 为什么单独一条：cordis 的 `ctx.plugin({ inject, apply })` 直接吃我们给的命名空间，
// 永远不经过 `Loader.unwrapExports`；而本包真实的上载入入口是 ESM 命名空间导出
// （host.ts 顶层 export `inject`/`Config`/`apply`，另有一个带 inject 的 default）。
// 上游 postmortem 0001 记的正是「default 一旦赢掉命名空间，inject 跟着没，apply 里读服务
// 抛 cannot get property ... without inject」。这条用例把那一层真链路跑一遍：
// Loader 建 row → Entry._init 导入 → unwrapExports → registry.plugin → 本包 apply。
//
// 手写的只有三处，且都写清楚为什么：settings（真实现的闭包要 configEditor + profileContext）、
// workingDirectory（真实现要 SessionProjectionRegistry）、subprocess（进程面是文档允许的边界，
// 这里复用 host-stack 的假 rtk 子进程面）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { apply as applyShellEnv, inject as shellEnvInject } from "@deepseek-ai/dsh-shell-env";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { apply as applyToolBash, inject as toolBashInject } from "@deepseek-ai/dsh-tool-bash";
import {
  apply as applyNativeExecutor,
  inject as nativeExecutorInject,
} from "@deepseek-ai/dsh-tool-executor-native";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ScriptedShell, installFakeRtk } from "./host-stack.ts";

/** 补丁里那行只写的包名 —— 与 internal.import 的解析目标必须一致。 */
const PACKAGE_NAME = "@jayyuen66/dsh-rtk";

/** 补丁里那一条的 id。 */
const ENTRY_ID = "rtk";

/** cordis 的 FiberState.ACTIVE（const enum，运行时不导出，只能按值钉）。 */
const FIBER_ACTIVE = 2;

/** 什么都不做的 disposer：真实服务注销时调它。 */
const NOOP = (): void => {
  // 刻意留空。
};

/** 一次装载的结果，供断言取用。 */
interface Loaded {
  readonly ctx: Context;
  readonly state: number;
  readonly tools: readonly string[];
  readonly configureCalls: readonly unknown[];
  readonly usageText: string;
}

/** 只取本用例要读的三面；其余字段不声明，避免把 loader 的整型形状抄一遍。 */
interface LoaderFace {
  internal?: {
    version?: string;
    import: (specifier: string, parentURL?: string, attributes?: unknown) => Promise<unknown>;
  };
  create: (options: {
    id: string;
    name: string;
    config?: Record<string, unknown>;
  }) => Promise<string>;
  resolve: (id: string) => { fiber?: { state: number } & Promise<unknown> };
  await: () => Promise<void>;
}

/** settings 最小替身：只记录 configure 的入参。 */
function settingsStub(configureCalls: unknown[]): {
  describe: () => readonly { ns: string; value: unknown }[];
  configure: (presentation: unknown, owner?: unknown) => () => void;
} {
  return {
    describe: () => [],
    configure: (presentation: unknown): (() => void) => {
      configureCalls.push(presentation);
      return NOOP;
    },
  };
}

/** 真 Loader + 真宿主服务 + 三枚手写边界。 */
async function loadRtk(dataDir: string): Promise<Loaded> {
  // 命名空间只能运行时取：这条用例本身要判「Loader 认的是哪一位导出」。
  const namespace = (await import("../../host.ts")) as Record<string, unknown>;
  const ctx = new Context();
  const logs: string[] = [];
  ctx.logger.exporter({
    levels: { default: 0 },
    export: (entry: { level?: number; type?: string; args?: unknown[] }) => {
      logs.push(`${String(entry.type)} ${JSON.stringify(entry.args ?? null)}`);
    },
  });
  ctx.baseUrl = `${pathToFileURL(path.resolve(import.meta.dirname, "../..")).href}/`;
  await ctx.plugin(Loader);
  // SystemPrompt 的 `sessionProjections` 注入必须先有着落，否则 fiber 停在 PENDING。
  ctx.provide("sessionProjections", {
    register: (): (() => void) => () => {
      void 0;
    },
  });
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin({ inject: nativeExecutorInject, apply: applyNativeExecutor });
  await ctx.plugin({ inject: shellEnvInject, apply: applyShellEnv });
  await ctx.plugin(ScriptedShell, {
    reply: (): unknown => ({ kind: "foreground", exitCode: 0, stdout: { text: "ok" } }),
  });
  await ctx.plugin({ inject: toolBashInject, apply: applyToolBash });

  const configureCalls: unknown[] = [];
  ctx.provide("settings", settingsStub(configureCalls));
  const fake = installFakeRtk([dataDir], [{ exitCode: 0, stdout: "rtk 1.2.1" }]);
  ctx.provide("subprocess", fake.subprocess);
  ctx.provide("workingDirectory", {
    ensure: async (): Promise<string> => dataDir,
    get: (): string => dataDir,
    change: async (): Promise<string> => dataDir,
  });

  const loader = ctx.loader as unknown as LoaderFace;
  const internalImport = async (specifier: string): Promise<unknown> => {
    if (specifier !== PACKAGE_NAME) {
      throw new TypeError(`internal 替身只解析 ${PACKAGE_NAME}，问到的是 ${specifier}`);
    }
    return namespace;
  };
  loader.internal = { version: loader.internal?.version ?? "v2", import: internalImport };

  const id = await loader.create({
    id: ENTRY_ID,
    name: PACKAGE_NAME,
    config: { enabled: true, enabledForms: ["prefix"] },
  });
  await loader.await();
  const entry = loader.resolve(id);
  const tools = ctx.tools.schemas().map((item) => item.name);
  const assembly = await ctx.systemPrompt.assemble();
  const usageText = assembly.sections.find((section) => section.name === "rtk-usage")?.text ?? "";

  return {
    ctx,
    state: entry.fiber?.state ?? -1,
    tools,
    configureCalls,
    usageText,
  };
}

const cleanups = mkdtempSync(path.join(tmpdir(), "rtk-loader-"));

describe("真 Loader 装载本包", () => {
  afterAll(() => {
    rmSync(cleanups, { recursive: true, force: true });
  });

  it("命名空间经 Loader 解析后 inject 没丢：真服务装配完成、设置页与 usage 段都装上了", async () => {
    const savedHome = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = cleanups;
    let loaded: Loaded | undefined;
    try {
      loaded = await loadRtk(cleanups);
      expect(loaded.state).toBe(FIBER_ACTIVE);
      expect(loaded.tools).toContain("bash");
      expect(loaded.configureCalls).toStrictEqual([{ auto: false }]);
      expect(loaded.usageText.length).toBeGreaterThan(0);
    } finally {
      if (loaded !== undefined) {
        await loaded.ctx.fiber.dispose();
      }
      if (savedHome === undefined) {
        delete process.env["DSH_HOME"];
      } else {
        process.env["DSH_HOME"] = savedHome;
      }
    }
  });
});
