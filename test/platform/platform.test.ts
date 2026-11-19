// 跨平台语义：C 形态（遮蔽 bash + 委托 rtk rewrite）在三个平台上都装。
//
// 这一层钉的是装配期的唯一门禁与名称档位：
//   · `findOnPath` 按宿主平台取候选（win32 试 `.exe`/`.cmd`/裸名，POSIX 只看裸名）；
//   · rtk 在 PATH 上就装，不再有平台分支。
// 装配之后的行为面由 `test/prefix-integration.test.ts` 与 `test/prefix-insights.test.ts` 覆盖。
//
// 平台值不注入：同一份夹具在三个 runner 上跑真实宿主平台；win32 上 `installFakeRtk` 另写
// 一份 `rtk.cmd`，POSIX 上那份 `rtk` 带 shebang 与执行位。
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";

import { findOnPath } from "../../lib/prefix-safety.ts";

import { installFakeRtk, makeCleanups, startPrefixHost } from "../integration/host-stack.ts";

const cleanups = makeCleanups();
const RTK_CARGO_TEST = "rtk cargo test";

describe("平台档位：前缀形态的装配门禁", () => {
  afterAll(() => {
    cleanups.drain();
  });

  it("假 rtk 在 PATH 上时按宿主平台找到", () => {
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const found = findOnPath("rtk");
      assert.ok(found !== undefined, "同一份夹具在三个平台都要能被 findOnPath 找到");
      assert.ok(found.startsWith(rtk.dir), `找到的不是夹具里的 rtk：${found}`);
    } finally {
      rtk.restore();
    }
  });

  it("宿主平台（含 win32 runner）上会装遮蔽层", async () => {
    const rtk = installFakeRtk(cleanups.dirs, [{ exitCode: 3, stdout: RTK_CARGO_TEST }]);
    try {
      const host = await startPrefixHost();
      assert.equal(host.installed, true, "平台不再是装配期门禁");
      const shadow = host.withAgent();
      assert.equal(typeof shadow.execute, "function", "agent 视图里必须拿到遮蔽体");
    } finally {
      rtk.restore();
    }
  });

  it("findOnPath 的 win32 后缀档按 .exe / .cmd / 裸名探（平台判定与探测档位互不影响）", () => {
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

  it("宿主 PATH 上的 sh 能被找到（POSIX 档的原样探测）", () => {
    assert.ok(findOnPath("sh") !== undefined, "宿主 PATH 上 sh 必须能找到");
  });
});
