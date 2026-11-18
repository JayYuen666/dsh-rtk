// test/unbuildable.ts —— 「这个目录建不出来」这条夹具的唯一来源。
//
// 为什么必须集中一处：早先三处用例各写了一份 `/dev/null/...`，靠的是「`/dev/null` 是字符
// 设备、在它下面 `mkdir -p` 必然 ENOTDIR」。那在 POSIX 上成立，在 Windows 上却不成立——
// `/dev/null` 只是当前盘符下的一个普通路径段，`mkdir -p` 会把它一路建出来，于是
// 「库开不出来」那条用例在 Windows 上走的是**成功**路径（断言 `effects` 为空却拿到一条）。
// CI 的 windows 格就是这样红的，而本地（macOS）永远复现不到。
//
// 现在的夹具**不依赖任何设备文件**：父级放一个普通文件，`mkdir -p` 在三个平台上都必然
// 失败，SQLite 随后报 `unable to open database file`。这一点在 macOS 上实测过
// （mkdir 得 ENOTDIR、open 得 ERR_SQLITE_ERROR）；Windows 上由「父级是文件」这一条保证，
// 与设备语义无关。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { onTestFinished } from "vitest";

/**
 * 造一个**必然建不出来**的目录路径，并在用例结束时删掉那个临时根。
 *
 * 只能在 `it` 体内调用（内部用 `onTestFinished` 挂收摊）：它造的是一个真实临时目录。
 *
 * @returns 一个父级是普通文件的目录路径
 */
export function unbuildableDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "rtk-blocked-"));
  // 收摊：`rmSync(recursive)` 会把 blocker 文件与根一起删掉；`maxRetries` 兜住「刚被
  // SQLite 试探过、句柄还没完全放开」那一瞬间。
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const blocker = path.join(root, "blocker");
  writeFileSync(blocker, "");
  return path.join(blocker, "rtk");
}
