// src/ui-messages.ts —— 卡片文案（双语）。
//
// 键集合与 `lib/card-logic.ts` 的字段一一对应：漏一个键会在 client-entry 把 Translate
// 传给卡片的那个位置编译期红（`LocaleDictOf<typeof NS>` 要求每语键集等于本接口）。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

export interface UiMessages {
  readonly cardTitle: string;
  /** 设置页左侧一级分区的导航名（`settings.section` 的 label）。 */
  readonly navLabel: string;
  readonly statusSection: string;
  /** 今日摘要的小标题（只报今天；历史窗口在 Insights 页）。量纲不写在这里：两格各自带单位。 */
  readonly todayTitle: string;
  /** 今日摘要里改写形态那一行的标签。 */
  readonly todayPrefix: string;
  /** 今日摘要里结果压缩形态那一行的标签。 */
  readonly todayPipe: string;
  /** 今日某一形态一次都没被用上时的替换文案（不印三个 0）。 */
  readonly todayIdle: string;
  /** 次数那个数字后面的量纲词。 */
  readonly todayCommandsUnit: string;
  /** 省下的 token 那个数字后面的量纲词。 */
  readonly todaySavedUnit: string;
  readonly statsUnavailable: string;
  readonly resetStats: string;
  /**
   * 清零的二次确认。四段文案由宿主的 `RiskConfirmation` 消费：标题、正文、勾选项、
   * 确认按钮，另一枚「取消」与无障碍用的「关闭」也在这里——弹窗没有默认文案，
   * 少给一个键就是运行期缺字（类型上它们是必填的，所以漏键在这里就编译期红）。
   */
  readonly resetConfirmTitle: string;
  readonly resetConfirmDescription: string;
  readonly resetConfirmAcknowledge: string;
  readonly resetConfirmAction: string;
  readonly resetCancel: string;
  readonly resetClose: string;
  readonly switchSection: string;
  /// 小节标题旁的字段计数徽章（{count} 为字段数）。
  readonly fieldCount: string;
  readonly enabledLabel: string;
  /** 仅改写形态的总开关说明。 */
  readonly enabledHintPrefix: string;
  /** 含结果压缩形态的总开关说明（pipe / prefix+pipe）。 */
  readonly enabledHintWithPipe: string;
  readonly formsLabel: string;
  readonly formsHint: string;
  readonly formPrefix: string;
  readonly formPrefixAndPipe: string;
  readonly formPipeOnly: string;
  readonly pipeDisabledHint: string;
  readonly denyLabel: string;
  readonly denyHint: string;
  readonly filtersLabel: string;
  /** `{filters}` 是表里全部 filter 名的去重名单（不是默认三项）。 */
  readonly filtersHint: string;
  readonly minBytesLabel: string;
  readonly minBytesHint: string;
  readonly minGainLabel: string;
  readonly minGainHint: string;
  readonly stdoutCapLabel: string;
  readonly stdoutCapHint: string;
  readonly windowHeadLabel: string;
  readonly windowHeadHint: string;
  readonly windowTailLabel: string;
  readonly windowTailHint: string;
  readonly warnHintLabel: string;
  readonly warnHintHint: string;
  readonly hostEnvLabel: string;
  readonly hostEnvHint: string;
  readonly saveHint: string;
  readonly save: string;
  readonly saving: string;
  readonly revert: string;
  readonly dirtyCount: string;
  readonly statusClean: string;
  readonly statusReadOnly: string;
  readonly saveRejected: string;
  readonly saveFailed: string;
  readonly outOfRange: string;
  /** 有数字字段越界时保存条给出的原因（保存被阻止，先修正或撤销）。 */
  readonly invalidFields: string;
  readonly statsNote: string;
  /** rtk 不在 PATH：卡片顶部那条引导行（安装命令直接给出来，别让用户去翻 README）。 */
  readonly rtkMissingHint: string;
  /** 装了但版本低于下限：告诉用户探到的是哪一版、该升到几。 */
  readonly rtkTooOldHint: string;
  /** 已装且版本够：写出解析到的二进制与版本（README 承诺的「就绪行」就是这一句）。 */
  readonly rtkReadyHint: string;

  // ---- Insights 页（左侧栏一级面板）----
  /** 侧栏行与页面标题。与设置分区的 `navLabel` 分开：一个进设置列表，一个进侧栏。 */
  readonly panelLabel: string;
  /** Insights 页头标题下的那句副标题。 */
  readonly panelSub: string;
  readonly tabPrefix: string;
  readonly tabPipe: string;
  readonly range7: string;
  readonly range30: string;
  readonly range90: string;
  readonly granularityDay: string;
  readonly granularityWeek: string;
  readonly granularityMonth: string;
  readonly kpiBashCalls: string;
  readonly kpiAttemptsPrefix: string;
  readonly kpiAttemptsPipe: string;
  readonly kpiSucceededPrefix: string;
  readonly kpiSucceededPipe: string;
  readonly kpiCoveragePrefix: string;
  readonly kpiCoveragePipe: string;
  readonly kpiSaved: string;
  readonly kpiSavings: string;
  /** 时间筛选区的标题：窗口与粒度只属于时间，不该和形态页签挤在一行。 */
  readonly timeFilterLabel: string;
  /** 两个下拉各自的无障碍名称：`<select>` 不能只有 `data-field`。 */
  readonly rangeLabel: string;
  readonly granularityLabel: string;
  /** 图表加载失败时填进 `loadFailed` 的 `{reason}`：写死英文会漏进中文界面。 */
  readonly loadFailedChart: string;
  /** 窗口内该形态一次调用都没有：整页换这一句话，不摊一堆 0。`{form}` 是页签名。 */
  readonly emptyWindow: string;
  readonly chartTitle: string;
  readonly chartEmpty: string;
  /**
   * 有节省的桶少于 3 个时那句说明：只在退柱时出现。
   *
   * 它必须**同时回答两个问题**：为什么没有折线，以及「节省率去哪了」。第一版只说了前半句，
   * 于是在真实数据上（有节省的天只有 1~2 天）读者看到柱子却没有比率，第一反应是「比率没画出来」。
   * 改文案的人不要把它缩回成一句「只画柱子」。
   */
  readonly chartSparseNote: string;
  /** 「最近一次」那一块的标题：两种形态问的不是同一个问题。 */
  readonly recentTitlePrefix: string;
  readonly recentTitlePipe: string;
  readonly whyNone: string;
  /** `{status}`/`{family}`/`{reason}`/`{size}` 四个位。 */
  readonly whyLast: string;
  /** 同上但省掉 `{reason}`：status 与 reason 说同一件事的那两支（已改写 / 已压缩）用它。 */
  readonly whyLastPlain: string;
  /** 没量到字节时用这两条。改写形态量的是指令本身，落库恒为 `unknown`；照模板印出来
   *  就是「输入 unknown」——没量到就整段不印，不要拿占位词伪装成量到的值。 */
  readonly whyLastNoSize: string;
  readonly whyLastPlainNoSize: string;
  readonly lastCompressed: string;
  readonly lastSkipped: string;
  readonly lastRewritten: string;
  readonly lastFailed: string;
  /** 改写形态只报平均（日表没留峰值），压缩形态连最大值一起报。 */
  readonly latencyLabelPrefix: string;
  readonly latencyLabelPipe: string;
  readonly dataStartLabel: string;
  readonly dataStartUnknown: string;
  readonly loadFailed: string;
  readonly loadingLabel: string;
  readonly refresh: string;
  /** 页头的最近刷新时间（{time} 为 HH:mm）。 */
  readonly updatedAtLabel: string;
  /** KPI 瓦片的涨跌标注（{delta} 为 ↑12% 形态；粒度各自对应较前一日/周/月）。 */
  readonly kpiDeltaDay: string;
  readonly kpiDeltaWeek: string;
  readonly kpiDeltaMonth: string;
  readonly tableFilters: string;
  readonly tableCommands: string;
  readonly tableWorkdirs: string;
  readonly tableReasons: string;
  readonly colName: string;
  readonly colFamily: string;
  readonly colWorkdir: string;
  readonly colCommands: string;
  readonly colSaved: string;
  readonly colSavings: string;
  readonly colCoverage: string;
  readonly colReason: string;
  readonly colCount: string;
  readonly tableEmpty: string;
  /** 行数超过单表上限时表脚的说明（total=总行数，limit=展示的上限）。 */
  readonly tableTruncated: string;
  readonly reasonsEmpty: string;
  readonly suggestionsTitle: string;
  readonly suggestionsEmpty: string;
  /** 建议区的四种模板：参数由 service 给（`Suggestion.params`），句子在这里拼。
   *  服务端拼中文的后果是 en 界面整块中文——界面语言只有客户端知道。 */
  readonly suggestLowYieldFilter: string;
  readonly suggestUnusedFilter: string;
  readonly suggestPotentialFilter: string;
  readonly suggestLowYieldCommand: string;
  /** 账本/统计不可用的五个原因码。空数组时整行不出现（两个形态都可用）。 */
  readonly availPrefixReadonly: string;
  readonly availPrefixMissing: string;
  readonly availPrefixUnreadable: string;
  readonly availPrefixSchema: string;
  readonly availPipeUnavailable: string;
  /** rtk 自己那本账的对账信号（只在改写形态、账本可读、且数不为 0 时出现）。
   *  `{failures}`/`{recovered}`/`{rate}` 是解析失败数与回收率；`{oversized}` 是被 `rtk gain`
   *  排除在汇总之外的大行数；`{entries}`/`{size}` 是取回库的条数与磁盘占用。 */
  readonly rtkSelfFailures: string;
  readonly rtkSelfOversized: string;
  readonly rtkSelfRecall: string;
}

/** 本包的 locale 命名空间。必须与 `cordis.patch.yml` 的 `id` 一致（`rtk`）。 */
const LOCALE_NS_KEY = "rtk" as const;
export type LocaleNs = typeof LOCALE_NS_KEY;
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

// 把命名空间与键集合注册进官方的 locale 类型表：`ctx.locale.bind("rtk")` 因此能拿到键提示。
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    rtk: keyof UiMessages;
  }
}

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    cardTitle: "rtk 输出压缩",
    navLabel: "rtk 压缩",
    statusSection: "自记账统计",
    todayTitle: "今日",
    todayPrefix: "改写命令",
    todayPipe: "结果压缩",
    todayIdle: "今天还没有记录",
    todayCommandsUnit: "次",
    todaySavedUnit: "token",
    statsUnavailable: "统计读面未连接（压缩本身不受影响）",
    resetStats: "清零统计",
    resetConfirmTitle: "清零统计？",
    resetConfirmDescription:
      "会清掉 dsh 自己的账本（$DSH_HOME/rtk/history.db）里 commands 等五张表的全部记录，以及插件写在同一文件里的 dsh_* 统计表。这里只影响 dsh 会话的统计，你在自己终端里跑的 rtk 与它的全局账本不受影响；此操作不可撤销。",
    resetConfirmAcknowledge: "我知道这会清掉 dsh 会话的全部统计，且不可撤销",
    resetConfirmAction: "清零",
    resetCancel: "取消",
    resetClose: "关闭",
    switchSection: "开关",
    fieldCount: "{count} 字段",
    enabledLabel: "启用 rtk 压缩",
    enabledHintPrefix:
      "未手动设置时，检测到受支持的 rtk 才默认开启；手动切换会固定选择。打开后 bash 命令会先问 rtk 能否改写；问不到就原样执行。",
    enabledHintWithPipe:
      "未手动设置时，检测到受支持的 rtk 才默认开启；手动切换会固定选择。打开后按所选形态处理：改写命令，或在结果侧压缩输出；不可用或收益不足时原样放行。",
    formsLabel: "启用的形态",
    formsHint:
      "prefix = 改写命令（主路径，会 spawn `rtk rewrite`，受 rewriteTimeoutMs 管）；prefix+pipe = 额外在结果侧按 filter 压缩（B 形态）；pipe = 只压结果、不改命令（绕过拦截 bash 的护栏工具时用）。改完下一次工具调用即生效。",
    formPrefix: "仅改写命令",
    formPrefixAndPipe: "改写 + 结果压缩",
    formPipeOnly: "仅结果压缩",
    pipeDisabledHint:
      "结果压缩当前关闭：命令输出原样交给模型。打开它会按 filter 再压一遍——vitest 那一路是本包自己删掉通过行（不依赖 rtk 的解析器）。",
    denyLabel: "额外拒绝的命令（首词）",
    denyHint: "逗号分隔。命中即不改写，如 gh,npm。内置的信息损失拒绝表不受此项影响。",
    filtersLabel: "启用的结果过滤器",
    filtersHint:
      "只在包含结果压缩的形态下生效（改写 + 结果压缩 / 仅结果压缩）。可用名：{filters}。",
    minBytesLabel: "最小输入字节",
    minBytesHint: "小于它的输出不压（压了反而多出说明行）。",
    minGainLabel: "最小节省比例",
    minGainHint: "0~1。压缩后必须小于输入的这一比例才采用，否则原样。",
    stdoutCapLabel: "输出上限字节",
    stdoutCapHint: "压缩结果的硬上限，超出按字节截尾。",
    windowHeadLabel: "日志保留头行数",
    windowHeadHint:
      "只对日志类输出（cat 日志文件 / tail / journalctl / docker logs / ps）生效，读源码不动。默认 50 行，与 rtk 的 cap 同值。",
    windowTailLabel: "日志保留尾行数",
    windowTailHint:
      "同上。尾部默认留 200 行——错误几乎总压在最后几屏。省掉的中段会落进 spill，正文首行写出取回路径。",
    warnHintLabel: "cargo test 警告提示",
    warnHintHint:
      "rtk cargo test 不保留编译警告；开着会追加一行提示，指向 cargo build / cargo check。",
    hostEnvLabel: "RTK_REWRITE_HOST",
    hostEnvHint: "留空 = 不设该变量（推荐）。填 openclaw 可让 rtk 不再读 ~/.claude 的权限规则。",
    saveHint: "改完点保存。带提示的项写错会让压缩整体失效，不是纯显示问题。",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    dirtyCount: "{count} 项未保存",
    statusClean: "无改动",
    statusReadOnly: "只读（当前配置不可写）",
    saveRejected: "宿主拒绝了这次写入",
    saveFailed: "保存失败：{reason}",
    outOfRange: "超出范围",
    invalidFields: "有字段超出范围，先修正或撤销后再保存。",
    statsNote:
      "只统计 dsh 会话：改写量与压缩量的明细都记在 dsh 自己的账本（$DSH_HOME/rtk/history.db）里，rtk 由插件指到该文件，所以你终端里跑的 rtk 与 rtk gain 不受影响、也不计入这里。token 由宿主的 tokenMeter 估算（服务缺席时按 bytes/4），节省率按 token 算。",
    rtkMissingHint:
      "rtk not found：PATH 上找不到 rtk，压缩不会生效。macOS 用 brew install rtk，Windows 用 winget install rtk-ai.rtk。",
    rtkTooOldHint: "探到的 rtk 是 {version}，低于支持的 {minimum}：请升级 rtk 后再打开压缩。",
    rtkReadyHint: "就绪：{version}（{path}）",
    panelLabel: "rtk 统计",
    panelSub: "命令改写与结果压缩的效果统计",
    tabPrefix: "命令改写",
    tabPipe: "结果压缩",
    range7: "近 7 天",
    range30: "近 30 天",
    range90: "近 90 天",
    granularityDay: "按日",
    granularityWeek: "按周",
    granularityMonth: "按月",
    kpiBashCalls: "bash 调用",
    kpiAttemptsPrefix: "尝试改写",
    kpiAttemptsPipe: "命中 filter",
    kpiSucceededPrefix: "改写成功",
    kpiSucceededPipe: "压缩成功",
    kpiCoveragePrefix: "改写覆盖",
    kpiCoveragePipe: "压缩覆盖",
    kpiSaved: "节省 token",
    kpiSavings: "节省率",
    timeFilterLabel: "时间范围",
    rangeLabel: "时间范围",
    granularityLabel: "聚合粒度",
    loadFailedChart: "图表模块没有加载起来",
    emptyWindow: "近 {days} 天没有{form}记录。换一个时间范围，或先跑几条命令。",
    chartTitle: "节省量与比率",
    chartEmpty: "窗口内还没有数据。跑几条命令再回来。",
    chartSparseNote:
      "有节省的桶不足 3 个，所以只画柱子、不连折线（两个点连出来的线不是趋势，会当成走势读）。节省率没有丢：上面 KPI 行与下面的明细表里都有，只是没画成线。",
    recentTitlePrefix: "最近一次改写",
    recentTitlePipe: "最近一次压缩",
    whyNone: "窗口内还没有任何一次尝试。",
    whyLast: "{status} · {family} · {reason} · 输入 {size}",
    whyLastPlain: "{status} · {family} · 输入 {size}",
    whyLastNoSize: "{status} · {family} · {reason}",
    whyLastPlainNoSize: "{status} · {family}",
    lastCompressed: "已压缩",
    lastSkipped: "已跳过",
    lastRewritten: "已改写",
    lastFailed: "已失败",
    latencyLabelPrefix: "平均改写耗时",
    latencyLabelPipe: "平均 / 最大耗时",
    dataStartLabel: "数据起始",
    dataStartUnknown: "还没有数据",
    loadFailed: "统计读面没有响应：{reason}",
    loadingLabel: "读取中…",
    refresh: "刷新",
    updatedAtLabel: "更新于 {time}",
    kpiDeltaDay: "较前一日 {delta}",
    kpiDeltaWeek: "较前一周 {delta}",
    kpiDeltaMonth: "较前一月 {delta}",
    tableFilters: "按过滤器",
    tableCommands: "按命令",
    tableWorkdirs: "按目录",
    tableReasons: "跳过原因 Top",
    colName: "过滤器",
    colFamily: "命令",
    colWorkdir: "目录",
    colCommands: "次数",
    colSaved: "节省 token",
    colSavings: "节省率",
    colCoverage: "覆盖率",
    colReason: "原因",
    colCount: "次数",
    tableEmpty: "窗口内没有记录。",
    tableTruncated: "共 {total} 行，只展示节省最多的前 {limit} 行",
    reasonsEmpty: "窗口内没有跳过记录。",
    suggestionsTitle: "建议",
    suggestionsEmpty: "没有需要调整的项。",
    suggestLowYieldFilter:
      "filter {filter} 收益偏低：{days} 天内命中 {attempts} 次，压成 {compressed} 次，只省下 {savingsPct}%。可以关掉它，也可以留着看长尾。配置键：enabledFilters。",
    suggestUnusedFilter:
      "filter {filter} 最近 {days} 天没有一条命令命中它。不必急着关——不命中的 filter 没有代价。配置键：enabledFilters。",
    suggestPotentialFilter:
      "最近 {days} 天有 {matches} 条命令能命中 {filter}，但它没启用。配置键：enabledFilters。",
    suggestLowYieldCommand:
      "{family} 改写收益偏低：{days} 天内改写 {attempts} 次，加权节省 {savingsPct}%。要在这类命令上省时间，得先让输出本身变小。",
    availPrefixReadonly: "沙箱是只读模式：改写的节省量读不到（改写计数照常）。",
    availPrefixMissing: "还没有 dsh 的 rtk 账本：这个 host 里还没有发生过一次成功的命令改写。",
    availPrefixUnreadable: "dsh 的 rtk 账本存在但读不出来（权限、损坏，或另一个进程正占着它）。",
    availPrefixSchema: "dsh 的 rtk 账本形状不认识（rtk 大版本变了？）。",
    availPipeUnavailable:
      "统计库打不开（node:sqlite 不可用或文件损坏）：压缩统计不可用，压缩本身不受影响。",
    rtkSelfFailures:
      "rtk 自己解析失败 {failures} 次，其中 {recovered} 次回落到原命令跑成了（回收率 {rate}）。",
    rtkSelfOversized:
      "另有 {oversized} 次输入超过 rtk 的汇总上限（7500 token），`rtk gain` 会把这些整行排除在本页之外；本页不排除。",
    rtkSelfRecall:
      "被折叠的输出另存了 {entries} 条在 dsh 自己的 recall 库里（占 {size}），尾部指针指向那里。",
  },
  en: {
    cardTitle: "rtk output compression",
    navLabel: "rtk compression",
    statusSection: "Self-accounted stats",
    todayTitle: "Today",
    todayPrefix: "Command rewrite",
    todayPipe: "Output compression",
    todayIdle: "Nothing recorded today",
    todayCommandsUnit: "runs",
    todaySavedUnit: "tokens",
    statsUnavailable: "Stats channel unavailable (compression itself is unaffected)",
    resetStats: "Reset stats",
    resetConfirmTitle: "Reset the statistics?",
    resetConfirmDescription:
      "This deletes every row from the five rtk tables in dsh's own ledger ($DSH_HOME/rtk/history.db — commands and its siblings), plus the dsh_* tables the plugin keeps in the same file. Only dsh sessions are affected: the rtk you run in your own terminal and its global ledger are untouched. There is no undo.",
    resetConfirmAcknowledge: "I understand this clears all dsh session statistics, with no undo",
    resetConfirmAction: "Reset",
    resetCancel: "Cancel",
    resetClose: "Close",
    switchSection: "Switches",
    fieldCount: "{count} fields",
    enabledLabel: "Enable rtk compression",
    enabledHintPrefix:
      "Until set explicitly, this follows rtk readiness: on only when a supported rtk is detected; a manual toggle pins the choice. When on, bash commands are first offered to rtk; if rtk declines, the command runs unchanged.",
    enabledHintWithPipe:
      "Until set explicitly, this follows rtk readiness: on only when a supported rtk is detected; a manual toggle pins the choice. When on, the selected form rewrites commands and/or compresses their output; unavailable or low-gain results pass through unchanged.",
    formsLabel: "Enabled forms",
    formsHint:
      "prefix = rewrite the command (main path; spawns `rtk rewrite`, bounded by rewriteTimeoutMs); prefix+pipe = also compress output by filter (form B); pipe = compress output only, never rewrite (for setups that block command rewriting). A change takes effect on the next tool call.",
    formPrefix: "Rewrite only",
    formPrefixAndPipe: "Rewrite + output compression",
    formPipeOnly: "Output compression only",
    pipeDisabledHint:
      "Output compression is currently off: command output reaches the model untouched. Turning it on compresses by filter — the vitest path drops passing lines in this plugin itself, without depending on rtk's parser.",
    denyLabel: "Extra denied commands (first word)",
    denyHint:
      "Comma separated. A match skips rewriting, e.g. gh,npm. The built-in information-loss table is not affected.",
    filtersLabel: "Enabled output filters",
    filtersHint:
      "Used by every form that includes output compression (rewrite + output compression / output compression only). Available: {filters}.",
    minBytesLabel: "Minimum input bytes",
    minBytesHint: "Output smaller than this is left alone (compressing it adds lines).",
    minGainLabel: "Minimum gain ratio",
    minGainHint:
      "0-1. The compressed result must be below this fraction of the input, else the original is kept.",
    stdoutCapLabel: "Output cap bytes",
    stdoutCapHint: "Hard cap on the compressed result; overflow is trimmed from the tail by bytes.",
    windowHeadLabel: "Log head lines kept",
    windowHeadHint:
      "Applies to log-shaped output only (cat of a log file / tail / journalctl / docker logs / ps); reading source files is never touched. Default 50, the same value rtk's cap uses.",
    windowTailLabel: "Log tail lines kept",
    windowTailHint:
      "Same scope. The tail defaults to 200 lines because failures almost always sit in the last few screens. The omitted middle goes to spill and the first body line names the retrieval path.",
    warnHintLabel: "cargo test warning hint",
    warnHintHint:
      "rtk cargo test drops compile warnings; when on, one hint line points at cargo build / cargo check.",
    hostEnvLabel: "RTK_REWRITE_HOST",
    hostEnvHint:
      "Empty = leave the variable unset (recommended). Set openclaw so rtk stops reading ~/.claude permission rules.",
    saveHint:
      "Save when done. Items marked with a warning can disable compression entirely if mistyped - they are not cosmetic.",
    save: "Save",
    saving: "Saving...",
    revert: "Revert",
    dirtyCount: "{count} unsaved",
    statusClean: "No changes",
    statusReadOnly: "Read-only (configuration not writable)",
    saveRejected: "The host rejected this write",
    saveFailed: "Save failed: {reason}",
    outOfRange: "out of range",
    invalidFields: "Some fields are out of range; fix them or revert before saving.",
    statsNote:
      "Dsh sessions only: rewrite and compression details both live in dsh's own ledger ($DSH_HOME/rtk/history.db), and the plugin points rtk at that file, so the rtk you run in your own terminal and `rtk gain` are neither affected nor counted here. Tokens are estimated by the host tokenMeter (bytes/4 when that service is absent) and the savings rate is computed on tokens.",
    rtkMissingHint:
      "rtk not found on PATH, so compression cannot run. macOS: brew install rtk. Windows: winget install rtk-ai.rtk.",
    rtkTooOldHint:
      "Found rtk {version}, below the supported {minimum}: upgrade rtk before enabling compression.",
    rtkReadyHint: "Ready: {version} ({path})",
    panelLabel: "rtk stats",
    panelSub: "Effectiveness stats for command rewriting and output compression",
    tabPrefix: "Command rewrite",
    tabPipe: "Output compression",
    range7: "Last 7 days",
    range30: "Last 30 days",
    range90: "Last 90 days",
    granularityDay: "By day",
    granularityWeek: "By week",
    granularityMonth: "By month",
    kpiBashCalls: "bash calls",
    kpiAttemptsPrefix: "Rewrite attempts",
    kpiAttemptsPipe: "Filter hits",
    kpiSucceededPrefix: "Rewritten",
    kpiSucceededPipe: "Compressed",
    kpiCoveragePrefix: "Rewrite coverage",
    kpiCoveragePipe: "Compression coverage",
    kpiSaved: "Tokens saved",
    kpiSavings: "Savings",
    timeFilterLabel: "Time range",
    rangeLabel: "Time range",
    granularityLabel: "Granularity",
    loadFailedChart: "the chart module did not load",
    emptyWindow:
      "No {form} activity in the last {days} days. Try another range, or run a few commands first.",
    chartTitle: "Tokens saved and rate",
    chartEmpty: "No data in this window yet. Run a few commands and come back.",
    chartSparseNote:
      "Fewer than 3 buckets have savings, so this is bars only — a line through two points reads as a trend that is not there. The rate is not missing: it is in the KPI row above and in the tables below, just not drawn as a line.",
    recentTitlePrefix: "Latest rewrite",
    recentTitlePipe: "Latest compression",
    whyNone: "No attempt in this window yet.",
    whyLast: "{status} · {family} · {reason} · input {size}",
    whyLastPlain: "{status} · {family} · input {size}",
    whyLastNoSize: "{status} · {family} · {reason}",
    whyLastPlainNoSize: "{status} · {family}",
    lastCompressed: "compressed",
    lastSkipped: "skipped",
    lastRewritten: "rewritten",
    lastFailed: "failed",
    latencyLabelPrefix: "Avg rewrite latency",
    latencyLabelPipe: "Avg / max latency",
    dataStartLabel: "Data starts",
    dataStartUnknown: "no data yet",
    loadFailed: "The stats channel did not respond: {reason}",
    loadingLabel: "Loading...",
    refresh: "Refresh",
    updatedAtLabel: "Updated {time}",
    kpiDeltaDay: "vs prior day {delta}",
    kpiDeltaWeek: "vs prior week {delta}",
    kpiDeltaMonth: "vs prior month {delta}",
    tableFilters: "By filter",
    tableCommands: "By command",
    tableWorkdirs: "By directory",
    tableReasons: "Top skip reasons",
    colName: "Filter",
    colFamily: "Command",
    colWorkdir: "Directory",
    colCommands: "Calls",
    colSaved: "Tokens saved",
    colSavings: "Savings",
    colCoverage: "Coverage",
    colReason: "Reason",
    colCount: "Count",
    tableEmpty: "No records in this window.",
    tableTruncated: "{total} rows total; showing the top {limit} by savings",
    reasonsEmpty: "No skips recorded in this window.",
    suggestionsTitle: "Suggestions",
    suggestionsEmpty: "Nothing to adjust.",
    suggestLowYieldFilter:
      "Filter {filter} yields little: {attempts} hits in {days} days, {compressed} actually compressed, only {savingsPct}% saved. Turn it off, or keep it for the long tail. Config key: enabledFilters.",
    suggestUnusedFilter:
      "Filter {filter} was enabled but nothing matched it in the last {days} days. No rush to disable it — a filter that never matches costs nothing. Config key: enabledFilters.",
    suggestPotentialFilter:
      "{matches} commands in the last {days} days could match {filter}, which is not enabled. Config key: enabledFilters.",
    suggestLowYieldCommand:
      "Rewriting {family} yields little: {attempts} rewrites in {days} days, {savingsPct}% weighted savings. To save time on these, the output itself has to get smaller.",
    availPrefixReadonly:
      "The sandbox is read-only, so rewrite savings cannot be read (counts still work).",
    availPrefixMissing:
      "No rtk ledger for dsh yet: no successful rewrite has happened in this host.",
    availPrefixUnreadable:
      "The rtk ledger for dsh exists but cannot be read (permissions, corruption, or another process holding it).",
    availPrefixSchema: "The rtk ledger for dsh has an unrecognised shape (did rtk change majors?).",
    availPipeUnavailable:
      "The stats database cannot be opened (node:sqlite missing or file corrupt): compression stats are unavailable, compression itself is unaffected.",
    rtkSelfFailures:
      "rtk itself failed to parse {failures} commands and fell back to running {recovered} of them as-is (recovery rate {rate}).",
    rtkSelfOversized:
      "Another {oversized} calls had inputs above rtk's summary cap (7500 tokens); `rtk gain` excludes those rows entirely, this page does not.",
    rtkSelfRecall:
      "Folded output is kept in dsh's own recall database: {entries} entries, {size} on disk. The trailing pointers refer to it.",
  },
};
