// test/dist-size.test.ts —— 产物体积「下限 + 预算」检查。
//
// 为什么要有：`npm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人往构建切面里塞进大对象字面量或整段查表」这类回退——
// 体积不是行为，不会让任何现有用例变红，所以必须单独有一把尺子。
//
// 为什么同时卡下限：只卡「别超」时，构建异常只写出空文件或残片会让 `bytes <= budget`
// 永远成立。下限取当期实测的约 40%，正常演进不会撞到；撞到它就说明产物不是「变快了」而是「变没了」。
//
// 常量住在 test/floors.ts（单一来源）：这两条数要被变异测试抬过，写在用例里就没法只改一处。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { FLOORS } from "./floors.ts";

const pkgDir = path.join(import.meta.dirname, "..");

describe("产物体积", () => {
  // 用 it.each 而不是手写循环：两条断言形状完全相同，手写循环多一层缩进，
  // 且新增一条预算时容易忘了把它塞进某个数组的某个分支里。
  it.each(FLOORS)("$file 体积落在 $floor–$budget 字节之间", ({ file, floor, budget, note }) => {
    const target = path.join(pkgDir, file);
    // 先认「在不在」：缺产物时报的是这条门禁的话，而不是一句没有路径信息的 ENOENT 堆栈 ——
    // 后者分不清「没构建」与「构建坏了」，而这两种的下一步动作完全不同。
    assert.ok(
      existsSync(target),
      `${file} 不在包根：这道门比的是已构建产物，先跑 node build-host.mjs / node build-client.mjs`,
    );
    const bytes = readFileSync(target).byteLength;
    assert.ok(
      bytes >= floor,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，低于下限 ` +
        `${floor.toLocaleString("en-US")} B：产物像是被截断或只剩残片，先确认构建跑完了。${note}`,
    );
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表或字面量。` +
        `确属正常演进就改 test/floors.ts 里对应的 budget 并写明理由。${note}`,
    );
  });
});
