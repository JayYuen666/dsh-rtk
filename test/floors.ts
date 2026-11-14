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
    // 现量 110,884 B：涨的是「记账接宿主 tokenMeter」那一轮——账本加 token 两列（`stats-shape`
    // 的 schema 与 `summarize`）、新建定价模块 `lib/tokens.ts`、`finishCompressed` 多算两趟。
    // 下限不动（防截断的那把尺子按首轮 40% 给，抬高它反而会漏掉「只剩半截」）；预算按
    // 「实测 × 1.25 向上取整」重算。
    floor: 40_000,
    budget: 140_000,
    note: "host 半：Config + 两形态装配 + 四库 + 记账的字节/token 双口径。宿主按包名载入，字节是真实装载成本",
  },
  {
    file: "client.js",
    // 首轮实测 53,930 B（卡片 + shared card-ui 随包进产物；react 外置）。
    // 现量 87,700 B：涨的是设置页导航图标那一轮——图形是 rtk **官方标记**的 PNG 内联成
    // data URI（约 29 KB base64），用户明确要求「直接使用 rtk 官方的…不要压缩，压缩之后
    // 太丑啦」，所以这一档体积是为「图标不失真」付的价，不是可以随手省掉的余量。
    // 下限不动（防截断的那把尺子按首轮 40% 给）；预算按「实测 × 1.25 向上取整」重算。
    floor: 25_000,
    budget: 110_000,
    note: "client 半：卡片 + shared card-ui + 官方导航图标（data URI）随包进产物；react 外置，不进这里",
  },
];
