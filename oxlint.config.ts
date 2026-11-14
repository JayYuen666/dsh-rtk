import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 本包真实用到的同步 API —— node/no-sync 的例外，按文件声明（基线只放只读那一组，
  // 其余谁用谁点名文件；名单不外溢，别处再写同一个 API 照样报）。
  // 测试那组是门禁/集成用例要在临时目录里造夹具：写文件、改权限、造软链。
  // lib/prefix-safety.ts 的 accessSync 与 statSync 是只读的**可执行位/文件类型探测**
  // （判 PATH 上的 rtk 是不是真的能跑、是不是文件而不是同名目录），两者同属一次 O(1)
  // 查询，没有 readFileSync 那种把大文件整段读进内存的代价；共享基线的只读豁免表恰好
  // 没收录它们，所以要在这里点名。
  syncIoScopes: [
    {
      files: ["test/**"],
      apis: ["mkdirSync", "mkdtempSync", "rmSync", "writeFileSync", "chmodSync", "accessSync"],
    },
    { files: ["lib/prefix-safety.ts"], apis: ["accessSync", "statSync"] },
  ],
  // 标题前缀免检（`vitest/prefer-lowercase-title` 的 allowedPrefixes）：P1~P4 是
  // 本仓四条后置校验判据的正式编号，不是随手的大写。除此之外只留真正的技术缩写。
  titlePrefixes: ["JSON", "RTK", "TTL", "RtkCard", "P1", "P2", "P3", "P4"],
});
