// test/floors.ts —— 产物体积「下限 / 预算」的单一来源。
//
// 下限防的是「产物被截断或只剩残片」：只卡上限时，构建异常写出空文件会让
// `bytes <= budget` 永远成立。预算防的是「某个切面塞进了大查表或字面量」：体积不是行为，
// 不会让任何现有用例变红，所以必须单独有一把尺子。
//
// 取值口径：首轮构建实测的约 40%（下限）与实测 × 1.25 向上取整（预算）。
// 这一截是留给正常演进的——加一条规则、改一句文案不该立刻逼人来改预算；翻倍一定会顶穿。
// 确属需要突破时改这里并写明理由。
//
// 明确不做的事：**不开 minify**。压缩后产物里的跨包说明符字符串会消失，而
// test/build-host.test.ts 那几条「依赖必须外部化」的断言正是靠检索这些字符串来判的——
// 省下体积的代价是废掉两道真门禁，不划算。
export interface Floor {
  readonly file: string;
  readonly floor: number;
  readonly budget: number;
  /** 取值依据与这一档保护什么。突破预算时读它，别只看数字。 */
  readonly note: string;
}

export const FLOORS: readonly Floor[] = [
  {
    file: "host.js",
    // 首轮实测 85,176 B（含 Config 十四字段、两形态装配、四库与装饰器预转换的产物）。
    // 110,884 B 那一档涨的是「记账接宿主 tokenMeter」——账本加 token 两列（`stats-shape`
    // 的 schema 与 `summarize`）、新建定价模块 `lib/tokens.ts`、`finishCompressed` 多算两趟。
    // 现量 169,201 B，涨的是 Insights 那一轮的四件东西：`lib/sqlite-face.ts`（sqlite 最小面与
    // tombstone 助手）、`lib/insights-store.ts`（九张表的 DDL、十一条预编译 SQL 与读写面）、
    // `lib/insights-sink.ts`（延迟打开的缓冲）与 `installPrefixShadow` 里的五处埋点 + 账本路径注入。
    // 那是**新增的第四本账**，不是某处塞了查表；按体积口径它就该占位。
    // 下限不动（防截断的那把尺子按首轮 40% 给，抬高它反而会漏掉「只剩半截」）；预算按
    // 「实测 × 1.25 向上取整」重算：169,201 × 1.25 = 211,501.25 → 211,502。
    // 现量 176,977 B，涨的是 B 形态（pipe）的统计埋点：`PipeDecision` 的跳过分支、四张
    // 分母/分子记录、potential 那一支与 `skipRecordOf` 的字段拼装。与上一档同性质——账本
    // 多出一半的列，不是某处塞了查表。
    // 下限不动（防截断的那把尺子按首轮 40% 给，抬高它反而会漏掉「只剩半截」）；预算按
    // 「实测 × 1.25 向上取整」重算：176,977 × 1.25 = 221,221.25 → 221,222。
    // 现量 211,861 B，涨的是「账本目录不可建时照样注入」的拆分（`LedgerPlan` 两个事实）、
    // guard 的 `FAILURES (N)` 对账一行，以及那两条各自的注释。入账逻辑没变多，多的是判据。
    // 现量 218,004 B，涨的是 OCR 那一轮的三处：`prepareLedgerDir` 的 `writableDir` 分支与
    // `report` 双通道、账本读面（`READ_BUSY_TIMEOUT_MS` / `toRfc3339Utc` / `TOP_COMMANDS` /
    // `clearRtkCommands` 的符号链接与事务）、以及非 shell 工具不再记跳过——最后这条是**删**的，
    // 但 `downstream-value` / `downstream-block` 拆成两支补了回来。
    // 预算按「实测 × 1.25 向上取整」重算：218,004 × 1.25 = 272,505 → 272,505。
    // 再按 219,732 B 复核（那一档把 `applyPipeDecision` 的分支拆成两支后落了最后一行）：
    // 219,732 × 1.25 = 274,665。
    // 现量 221,859 B（CRC 87 条那一轮：`resetTables` 抽出、`downstream-block` 拆支、
    // `describeError` 与非 shell 不记账）。275,867 这一档仍罩得住它（221,859 × 1.25 = 277,324），
    // 所以预算不动——把尺子跟着现值一路抬上去，等于让它永远量不出增长。
    // 现量 224,634 B，涨的是服务层读面的降级壳（`guardedReadsOf` / `guardedStoreOf`：十处读
    // 各包一层 try/catch 并留一行 warn）与 `InsightsServiceDeps.warn` 的接线。
    // 现量 227,274 B，涨的是「Windows 上也要跑 C 形态」那一轮：`findOnPath` 的第三条参数
    // （可执行 policy 注入）与 `hasExecBit` 的逐位判定，替代原先焊死的 `accessSync(X_OK)`。
    // 224,634 × 1.25 = 280,792.5 已经越过上一档 275,867，按「实测 × 1.25 向上取整」重算：
    // 227,274 × 1.25 = 284,092.5 → 284,093。抬这一档是因为代码真的多了一段，不是因为
    // 上一档咬不住——把尺子跟着现值一路抬，它就永远量不出增长。
    // 再按 227,777 B 复核（同一轮末尾补的那一行：`HOST_EXECUTABLE` 在模块加载时把宿主策略
    // 钉住，见 `lib/prefix-safety.ts` 的同名注释）：227,777 × 1.25 = 284,721.25 → 284,722。
    floor: 40_000,
    budget: 284_722,
    note: "host 半：Config + 两形态装配 + 四库 + 记账的字节/token 双口径。宿主按包名载入，字节是真实装载成本",
  },
  {
    file: "client.js",
    // 首轮实测 53,930 B（卡片 + shared card-ui 随包进产物；react 外置）。
    // 45,081 B 那一档：shared 客户端行改为 external，产物只留本仓卡片与官方导航图标
    // （PNG 内联成 data URI，约 29 KB base64）；构建已开启 minify。
    // 现量 66,134 B，涨的是 Insights 那一页的入口侧：页签/窗口/粒度控件、KPI 行、三张明细表、
    // 建议区、图表的挂载器（ECharts 本身**不在**这里，它按需从 chunk 拉）与卡片上的两柱图。
    // 现量 75,544 B，涨的是设置卡统计区从「两行纯文本」改成「两格 KPI 卡片」：新增
    // `CardKpi` 组件、`cardKpiRowsOf` 的投影与那一整段卡片内格子的样式。与上一档同性质
    // ——卡片多出一块真的界面，不是某处塞了查表。
    // 现量 83,059 B，涨的是 OCR 那一轮入口侧的四件：按要求代际号重取（`generationRef`）、
    // `Picker` 的 `aria-label`、卡片与页脚改成按原因码查文案（两张 `Record` 表）、
    // 以及 `compact` 那一支的图表规格。都不大，但都在客户端。
    // 口径不变：下限按首轮 40%（25,000 不动，防截断的那把尺子不该随体积水涨），预算按
    // 「实测 × 1.25 向上取整」：83,059 × 1.25 = 103,824。
    // 现量 83,212 B（同上那一轮：`ChartBlock` 的嵌套翻译拆开、按原因码查文案）。
    // 103,887 这一档仍罩得住（83,212 × 1.25 = 104,015），理由同上：尺子不跟着现值跑。
    floor: 25_000,
    budget: 103_887,
    note: "client 半：设置卡 + Insights 页入口（不含 ECharts）；shared card-ui 由宿主行供应，不进这里",
  },
  {
    file: "client.insights-echarts.js",
    // 包内按需 chunk：ECharts 6.1.0 的 core + bar/line 两个图 + grid/tooltip/legend 三个组件 +
    // canvas 渲染器，minify 后实测 537,414 B（含 `/*!` 许可 banner）。**它不进 client.js**，
    // 用户不打开 Insights 页就一个字节都不下载——这也是这道预算该松一些的理由：它买的是
    // 「按需」而不是「每次装配」。
    // 现量 537,725 B（`compact` 那一支的 grid 与 splitNumber 多了一点代码），本轮没再涨。
    // 下限取实测的 40%（214,966 不动），预算同样 × 1.25：537,725 × 1.25 = 672,156.25 → 672,157。
    // 撞上预算时先看是不是有人把 `import * as charts` 写回来了：那会把全部图表拖进产物。
    floor: 214_966,
    budget: 672_157,
    note: "包内按需 chunk：ECharts 本体（Apache-2.0），只在选中 Insights 页时下载",
  },
];
