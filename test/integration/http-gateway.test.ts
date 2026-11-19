// test/integration/http-gateway.test.ts —— L2：真 HTTP 网关，不是手搓的 ctx.on。
//
// 这条回路起的是发布形态的宿主：DSH_HOME 沙箱里造一个 web profile、把本仓 link 进去，
// 真起 dsh web，再用真 HTTP 走 /api/rtkStats/*。鉴权按宿主契约走两次：先拿启动 URL 上的
// launch token 换 /connect 的 v2 签名 cookie，再带着这枚 cookie 调网关。响应形状按
// lib/stats-shape.ts / lib/insights-shape.ts 的公开契约断言，不从本包实现反推。
//
// 计时与外部依赖：需要 PATH 上有 dsh（CI 没有，自动跳过）且 host.js 已构建；DSH_RTK_TEST_MODE=fake
// 时也跳过。整条回路约十秒量级。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "vitest";

import { rtkTestMode } from "./host-stack.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const mode = rtkTestMode();

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runProcess = (
  argv: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<RunResult> =>
  // oxlint-disable-next-line promise/avoid-new -- spawn 只能靠事件回调收束，没有内置 Promise 形态
  new Promise((resolve, reject) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });

const dshProbe = await runProcess(["dsh", "--version"], { cwd: repoRoot }).catch(() => null);
const dshAvailable = dshProbe?.status === 0;
const enabled =
  dshAvailable &&
  mode !== "fake" &&
  process.env["CI"] === undefined &&
  existsSync(path.join(repoRoot, "host.js"));

const profile = "rtk-gateway";

interface RpcResult {
  readonly ok?: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface RpcEnvelope {
  readonly type?: string;
  readonly rpcId?: string;
  readonly result?: RpcResult;
}

interface Gateway {
  readonly origin: string;
  readonly token: string;
  readonly cookie: string;
  readonly child: ReturnType<typeof spawn>;
}

const stopHost = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  // oxlint-disable-next-line promise/avoid-new -- 退出事件只能靠回调收束
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const startHost = async (sandbox: string): Promise<Gateway> => {
  const created = await runProcess(
    ["dsh", "--profile", profile, "--from-default-profile", "web", "--dump-config"],
    { cwd: repoRoot, env: { ...process.env, DSH_HOME: sandbox } },
  );
  assert.equal(created.status, 0, `造 web profile 失败：${created.stderr}`);
  const added = await runProcess(["dsh", "plugin", "--profile", profile, "add", repoRoot], {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: sandbox },
  });
  assert.equal(added.status, 0, `link 本仓到 profile 失败：${added.stderr}`);

  const child = spawn("dsh", ["--profile", profile, "--no-open", "--port", "0"], {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: sandbox },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // oxlint-disable-next-line promise/avoid-new -- 启动 URL 只能从子进程输出里等
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`dsh web 60s 内没有打印启动行；输出：${output}`));
    }, 60_000);
    const inspect = (chunk: string): void => {
      output += chunk;
      const match = /dsh web: (?<url>http:\/\/127\.0\.0\.1:\d+\/?\?token=[\w-]+)/u.exec(output);
      const launched = match?.groups?.["url"];
      if (launched !== undefined) {
        clearTimeout(timer);
        resolve(launched);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dsh web 提前退出（exit ${String(code)}）；输出：${output}`));
    });
  });
  child.stdout.removeAllListeners("data");
  child.stderr.removeAllListeners("data");
  child.removeAllListeners("exit");

  const webUrl = new URL(url);
  const token = webUrl.searchParams.get("token");
  assert.ok(token !== null && token.length > 0, "启动 URL 上没有 launch token");
  const connect = new URL("/connect", webUrl);
  connect.searchParams.set("token", token);
  connect.searchParams.set("interactions", "none");
  const exchanged = await fetch(connect, { redirect: "manual" });
  assert.equal(exchanged.status, 302, "/connect 应回 302");
  const setCookie =
    exchanged.headers.getSetCookie()[0] ?? exchanged.headers.get("set-cookie") ?? "";
  assert.ok(setCookie.length > 0, "/connect 没有下发 cookie");
  const cookie = setCookie.split(";")[0] ?? "";
  assert.ok(cookie.length > 0, "cookie 没有名值对");
  return { origin: webUrl.origin, token, cookie, child };
};

const rpc = async (
  gateway: Gateway,
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: RpcEnvelope }> => {
  const response = await fetch(new URL(`/api/${endpoint}`, gateway.origin), {
    method: "POST",
    headers: { cookie: gateway.cookie, "content-type": "application/json", origin: gateway.origin },
    body: JSON.stringify({
      type: "client-request",
      rpcId: `test-${endpoint}`,
      method: endpoint,
      payload,
    }),
  });
  return { status: response.status, body: (await response.json()) as RpcEnvelope };
};

describe.skipIf(!enabled)("真 HTTP 网关：dsh web 沙箱 + Typert Remote", () => {
  it("launch token 换 cookie 后 /api/rtkStats/{overview,status,insights,reset} 都回真形状", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "rtk-gateway-"));
    const gateway = await startHost(sandbox);
    try {
      const overview = await rpc(gateway, "rtkStats/overview", { args: {} });
      assert.equal(overview.status, 200);
      assert.equal(overview.body.type, "server-response");
      assert.equal(
        overview.body.result?.ok,
        true,
        `overview 失败：${JSON.stringify(overview.body.result?.error)}`,
      );
      const value = overview.body.result?.value;
      assert.ok(value !== undefined, "overview 没有 value");
      assert.equal(typeof value["today"], "object");
      assert.equal(typeof value["availability"], "object");

      const status = await rpc(gateway, "rtkStats/status", { args: {} });
      assert.equal(status.status, 200);
      assert.equal(
        status.body.result?.ok,
        true,
        `status 失败：${JSON.stringify(status.body.result?.error)}`,
      );
      const statusValue = status.body.result?.value;
      assert.ok(statusValue !== undefined, "status 没有 value");
      assert.equal(typeof statusValue["rtkPath"], "string");
      assert.equal(typeof statusValue["supported"], "boolean");
      assert.ok(Array.isArray(statusValue["forms"]), "status.forms 应是数组");
      assert.ok(
        (statusValue["forms"] as readonly string[]).includes("prefix"),
        "默认应开 prefix 形态",
      );

      const insights = await rpc(gateway, "rtkStats/insights", {
        args: { request: { form: "pipe", rangeDays: 30, granularity: "day" } },
      });
      assert.equal(insights.status, 200);
      assert.equal(
        insights.body.result?.ok,
        true,
        `insights 失败：${JSON.stringify(insights.body.result?.error)}`,
      );
      const insightsValue = insights.body.result?.value;
      assert.ok(insightsValue !== undefined, "insights 没有 value");
      assert.equal(insightsValue["form"], "pipe");
      assert.equal(insightsValue["rangeDays"], 30);
      assert.equal(typeof insightsValue["totals"], "object");
      assert.ok(Array.isArray(insightsValue["series"]), "insights.series 应是数组");

      const reset = await rpc(gateway, "rtkStats/reset", { args: {} });
      assert.equal(reset.status, 200);
      assert.equal(
        reset.body.result?.ok,
        true,
        `reset 失败：${JSON.stringify(reset.body.result?.error)}`,
      );
      assert.equal(typeof reset.body.result?.value?.["today"], "object");

      const bad = await rpc(gateway, "rtkStats/insights", {
        args: { request: { form: "pipe", rangeDays: 100_000, granularity: "day" } },
      });
      assert.equal(bad.status, 200);
      assert.equal(bad.body.result?.ok, false, "网关必须拒掉超出契约的窗口天数");
    } finally {
      await stopHost(gateway.child);
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 180_000);
});
