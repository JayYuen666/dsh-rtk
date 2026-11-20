// test/integration/agent-loop.test.ts —— L2：真 AgentLoop 下的遮蔽层装配。
//
// 为什么还要这一层：test/integration/host-stack.ts 已经把「真 Cordis + 真 ToolRuntime +
// 真 tool-bash」请进来了，但 agent/created 这个入口是**夹具自己派发**的——于是
// 「插件在真宿主里到底会不会给新建 agent 装上遮蔽」仍然只有桩在回答。这一层用官方
// agent-loop-testkit 建真 AgentLoop、真 SessionStore、真作用域，模型只有剧本，
// 一次真实回合走完 tool-bash → 遮蔽层 → post-execute 整条链。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { apply as applyShellEnv, inject as shellEnvInject } from "@deepseek-ai/dsh-shell-env";
import { apply as applyToolBash, inject as toolBashInject } from "@deepseek-ai/dsh-tool-bash";
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";

import rtkPlugin from "../../host.ts";
import { ScriptedShell, installFakeRtk } from "./host-stack.ts";

const MODEL_ROUTE = "mock";
const BASH_TOOL = "bash";
const CARGO_TEST = "cargo test";
const RTK_CARGO_TEST = "rtk cargo test";
const SESSION_ID = "sess-agent-loop";
const NOOP = (): void => {
  /* 装配契约要求给一个可调用对象；这里没有副作用。 */
};
const WAITING_STATUS = "idle";

/** 剧本里一次调用的参数（模型看到的 arguments 是 JSON 串，不是对象）。 */
const BASH_ARGS = { command: CARGO_TEST, description: "run the unit tests" };

/** 真 shell 回执：成功的一小段 cargo 输出。 */
const SHELL_STDOUT = "test result: ok. 1 passed; 0 failed\n[exit code: 0]";

/** 官方 chunk 形状的调用剧本（照 danger-guard 的 callChunks：一次响应收尾一次）。 */
function toolCallReply(callId: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  const id = callId as ToolCallId;
  const argumentsJson = JSON.stringify(args);
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id, name, argumentsDelta: argumentsJson },
    {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id, name, arguments: argumentsJson },
    },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

/** 一段收尾文本（工具调用之后模型必须再回一回合，否则 loop 停不下来）。 */
function textReply(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/** 脚本模型：每次 stream() 消耗一格剧本，并把收到的请求记下来。 */
class ScriptedModel extends LlmAdapter {
  public readonly requests: GenerateOptions[] = [];

  private readonly script: readonly (readonly StreamChunk[])[];

  public constructor(script: readonly (readonly StreamChunk[])[]) {
    super();
    this.script = script;
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- 脚本模型没有「本机有什么模型」可查
  public override async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model };
  }

  public async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const entry = this.script[this.requests.length - 1];
    if (entry === undefined) {
      throw new Error("ScriptedModel: 剧本用完（模型多跑了一回合）");
    }
    yield* entry;
  }
}

/** 发起一个回合并等它 idle（官方判据就是 agent/status，不自建轮询）。 */
async function runTurn(ctx: Context, agent: Agent, prompt: string): Promise<void> {
  // 先订阅再 followup：反过来的话快回合可能在订阅之前就 idle 掉。
  // oxlint-disable-next-line promise/avoid-new -- 事件不是 promise，宿主没有可复用的等待原语
  const idle = new Promise<void>((resolve, reject) => {
    const off = ctx.on("agent/status", ({ agent: candidate, status }) => {
      if (candidate === agent && status === WAITING_STATUS) {
        off();
        resolve();
      }
    });
    try {
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: prompt }],
          source: { kind: "user" },
        }),
      );
    } catch (error: unknown) {
      off();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await idle;
}

const cleanups = mkdtempSync(path.join(tmpdir(), "rtk-agent-loop-"));

describe("真 AgentLoop 里的遮蔽层", () => {
  afterAll(() => {
    rmSync(cleanups, { recursive: true, force: true });
  });

  it("新建 agent 的 bash 被换成本插件的遮蔽体，工具调用走真 tool-bash + post-execute", async () => {
    const savedHome = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = cleanups;
    const fake = installFakeRtk(
      [cleanups],
      [
        { exitCode: 0, stdout: "rtk 1.2.1" },
        { exitCode: 0, stdout: RTK_CARGO_TEST },
      ],
    );
    let ctx: Context | undefined;
    try {
      ctx = new Context();
      ctx.provide("settings", {
        describe: (): readonly unknown[] => [],
        configure: (): (() => void) => NOOP,
      });
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
      ctx.provide("subprocess", fake.subprocess);
      await ctx.plugin({ inject: shellEnvInject, apply: applyShellEnv });
      await ctx.plugin(ScriptedShell, {
        reply: (): unknown => ({ kind: "foreground", exitCode: 0, stdout: { text: SHELL_STDOUT } }),
      });
      await ctx.plugin({ inject: toolBashInject, apply: applyToolBash });
      const shell = ctx.get("shell") as ScriptedShell;
      await ctx.plugin(rtkPlugin, { enabled: true, enabledForms: ["prefix"] });
      const harness = await mountAgentLoopTestHarness(ctx);
      const agent = await harness.create(
        SESSION_ID as SessionId,
        { provider: MODEL_ROUTE, model: MODEL_ROUTE },
        { cwd: cleanups },
      );
      const globalBash = ctx.tools.get(BASH_TOOL);
      const agentBash = ctx.tools.get(BASH_TOOL, agent);
      assert.ok(agentBash !== undefined, "agent 视图里必须有 bash");
      assert.notEqual(agentBash, globalBash, "真 agent/created 之后 agent 视图必须换成遮蔽体");
      const model = new ScriptedModel([
        toolCallReply("call-loop-1", BASH_TOOL, BASH_ARGS),
        textReply("done"),
      ]);
      ctx.llm.registerAdapter([MODEL_ROUTE], model);
      await runTurn(ctx, agent, "run the unit tests");
      assert.equal(shell.received.length, 1, "一次调用只许执行一次");
      const executed = shell.received[0] ?? "";
      assert.ok(executed.includes(RTK_CARGO_TEST), "遮蔽层交给真 shell 的必须是改写后的命令");
      assert.ok(executed.startsWith("RTK_DB_PATH="), "账本路径必须作为命令前缀注入");
      assert.ok(fake.spawned() >= 1, "改写至少 spawn 了一次 rtk");
    } finally {
      await ctx?.fiber.dispose();
      fake.restore();
      if (savedHome === undefined) {
        delete process.env["DSH_HOME"];
      } else {
        process.env["DSH_HOME"] = savedHome;
      }
    }
  });
});
