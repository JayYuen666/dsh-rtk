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
    // lib/rtk-ledger.ts 的 ensureRtkDir：装配期要立刻知道「账本目录能不能用」，异步版本会让
    // 注册写许可与第一次 spawn 抢同一段时间窗。mkdirSync 建目录、lstatSync 判它是不是符号链接
    // （是链接时 `$DSH_HOME` 下这份账本其实落在别处，而 reset 会照着它删）——两者都是一次
    // O(1) 元数据操作，不读文件内容。
    { files: ["lib/rtk-ledger.ts"], apis: ["mkdirSync", "lstatSync"] },
  ],
  // 标题前缀免检（`vitest/prefer-lowercase-title` 的 allowedPrefixes）：P1~P4 是
  // 本仓四条后置校验判据的正式编号，不是随手的大写。除此之外只留真正的技术缩写。
  titlePrefixes: ["JSON", "RTK", "TTL", "RtkCard", "P1", "P2", "P3", "P4"],
  // 构建产物不该被当源码扫。基线的忽略表只钉了 `client.js` / `host.js` 两个固定名，
  // 而本包多了包内按需 chunk（`client.insights-echarts.js`）——ECharts 打进来之后是
  // 五十多万字节的第三方代码，扫它既没有收益（不是我们的源码），又会把 `lint` 变成一个
  // 九万条噪声的仓库（实测）。模式按宿主的 chunk 命名规则写，将来再加 chunk 也不必回来改。
  extraIgnorePatterns: ["client.*.js"],
});
