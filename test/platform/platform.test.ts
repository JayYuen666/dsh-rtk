// 跨平台语义：C 形态（遮蔽 bash + 委托 `rtk rewrite`）在 Windows 上**不装**。
//
// 这一层钉的是「保守档」，不是「Windows 上也能用」：
//   - rtk 的 Windows 分发面（`winget install rtk-ai.rtk`）没在真机验过；
//   - pwsh 的命令解析与 rtk 以 `.exe`/`.cmd` 存在的形态全部未验；
//   - 前缀形态一旦把命令写坏（rc=127），损害是「本来能跑的命令不能跑」，比 pipe 形态
//     「不压缩」严重一个量级。
// 所以判据不是「尽量猜对」，而是「平台不被认作支持时整层不装」——宿主原生 bash 原样生效，
// 插件在该平台上等于不存在。
//
// 平台值全部**显式注入**：win32 的判定在 POSIX 测试机上永远走不到，焊死 `process.platform`
// 之后那条分支只能靠放宽阈值或 ignore 注释糊过去，两样这个工作区都不做。
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";

import { prefixSupportedOn } from "../../host.ts";
import { findOnPath } from "../../lib/prefix-safety.ts";

import { installFakeRtk, makeCleanups, startPrefixHost } from "../integration/host-stack.ts";

const cleanups = makeCleanups();
const RTK_CARGO_TEST = "rtk cargo test";

describe("平台档位：前缀形态的支持面", () => {
  // 假 rtk 的临时目录按文件收尾：每条用例自己 try/finally 还 PATH，目录在这里一次性删。
  afterAll(() => {
    cleanups.drain();
  });

  it("prefixSupportedOn 只把 win32 判否，其余平台一律支持", () => {
    assert.equal(prefixSupportedOn("win32"), false);
    assert.equal(prefixSupportedOn("darwin"), true);
    assert.equal(prefixSupportedOn("linux"), true);
    assert.equal(prefixSupportedOn("freebsd"), true, "未列举的平台按支持处理，不是按不支持");
  });

  it("win32 上整层不装：连 agent/created 监听器都不注册", async () => {
    // 先造一条假 rtk 并放进 PATH：这条用例要证明「不装」的原因是平台，而不是「找不到 rtk」。
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost({ platform: "win32" });
      assert.equal(host.installed, false, "win32 上不该挂 agent/created 监听器");
      // 连带判据：连 spawn 都没发生——「装了壳再在内部早退」是另一种形状，这里要的是「没装」。
      assert.equal(rtk.spawned(), 0, "win32 上不该 spawn rtk rewrite");
    } finally {
      rtk.restore();
    }
  });

  it("同一份夹具在 POSIX 档上会装（win32 的「不装」是平台判定，不是夹具坏了）", async () => {
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost({ platform: "linux" });
      assert.equal(host.installed, true, "POSIX 档不该被平台门禁挡住");
    } finally {
      rtk.restore();
    }
  });

  it("findOnPath 的 win32 后缀档仍按 .exe / .cmd / 裸名探（平台判定与探测档位互不影响）", () => {
    // 静态钉判据函数的形状：win32 分支在 POSIX 机器上不可达，行为面由
    // test/prefix-safety.test.ts 用注入的 platform 覆盖（那里能造出真的 .exe 文件）。
    const source = readFileSync(
      path.join(import.meta.dirname, "../../lib/prefix-safety.ts"),
      "utf8",
    );
    assert.ok(source.includes('platform === "win32"'), "findOnPath 缺 win32 分支");
    assert.ok(source.includes('".exe"'), "win32 分支缺 .exe");
    assert.ok(source.includes('".cmd"'), "win32 分支缺 .cmd");
  });

  it("posix 上不追加后缀（按原样探）", () => {
    assert.ok(findOnPath("sh") !== undefined, "POSIX 上 sh 必须在 PATH 里");
  });
});
