import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";
import { viteDecorators } from "@jayyuen66/dsh-plugin-shared/lib/decorator-lowering";
import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共配置（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 唯一来源；这里只留本包差异。
const base = definePackageConfig({
  coverageInclude: [
    "host.ts",
    "lib/**/*.ts",
    // 卡片侧两个可单测的源文件（字典与远程读取器）一并入覆盖率门禁；
    // src/client-entry.ts 刻意排除：纯浏览器入口（document/React 渲染，node 环境无 document），
    // 它的冒烟由 test/build-client.test.ts 对构建产物求值，真渲染走「已发布产物」那条回路。
    "src/ui-messages.ts",
    "src/stats-reader.ts",
    "lib/card-logic.ts",
  ],
});

// ⚠ 装饰器预转换必须**合并**进去，而不是当成 `definePackageConfig` 的一个入参：那个工厂只读
// `coverageInclude` 与 `test` 两个键，多传的顶层键会被**静默丢掉**（实测过：传进去之后测试
// 依旧报 `SyntaxError: Invalid or unexpected token`）。
//
// 为什么非有它不可：官方 Typert Remote 只能用标准装饰器声明，而流水线的解析器（oxc）不降级
// 它 —— 少了这一步，`lib/stats-remote.ts` 连加载都过不去。
//
// tsc 入口在这里解析：shared 只收注入的入口（它是 provider，不替消费方解析 typescript）。
// tsc 入口先算成变量：一行里套四层调用会撞 `unicorn(max-nested-calls)`，而这几个调用
// 各自的语义（解析 manifest → 取目录 → 拼 bin/tsc）本来也值得分行写清。
const typescriptManifest = createRequire(import.meta.url).resolve("typescript/package.json");
const tscEntry = path.join(path.dirname(typescriptManifest), "bin", "tsc");

export default defineConfig({
  ...base,
  plugins: [...(base.plugins ?? []), viteDecorators({ tscEntry })],
});
