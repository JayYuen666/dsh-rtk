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
    floor: 40_000,
    budget: 362_427,
    note: "host 半：Config + 两形态装配 + 四库 + 记账的字节/token 双口径。宿主按包名载入，字节是真实装载成本",
  },
  {
    file: "client.js",
    floor: 25_000,
    budget: 111_039,
    note: "client 半：设置卡 + Insights 页入口（不含 ECharts）；shared card-ui 由宿主行供应，不进这里",
  },
  {
    file: "client.insights-echarts.js",
    floor: 214_966,
    budget: 672_157,
    note: "包内按需 chunk：ECharts 本体（Apache-2.0），只在选中 Insights 页时下载",
  },
];
