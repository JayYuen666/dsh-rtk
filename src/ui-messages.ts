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
  readonly statsCommands: string;
  readonly statsSaved: string;
  /** 按形态分账那行：改写（prefix）与结果压缩（pipe）各自的命令数（spec §6）。 */
  readonly statsByForm: string;
  readonly statsSavings: string;
  /** 图表标题：按 filter 的 token 收益排行。 */
  readonly statsChartTitle: string;
  /** 图表口径说明：柱长相对最大项、百分比是占全部节省 token 的比例。 */
  readonly statsChartHint: string;
  /** 一条柱子的说明：这张 filter 省了多少 token、占全部省下量的百分之几。 */
  readonly statsChartRow: string;
  /** 还没有任何 pipe 记账时的空态（不是错误）。 */
  readonly statsChartEmpty: string;
  readonly statsUnavailable: string;
  readonly resetStats: string;
  readonly switchSection: string;
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
    statsCommands: "已压缩命令",
    statsSaved: "节省 token",
    statsByForm: "按形态分账（改写 / 结果压缩）",
    statsSavings: "节省率",
    statsChartTitle: "按过滤器省下的 token",
    statsChartHint: "柱长相对最大项；百分比是这条过滤器在全部节省 token 里占的份额。",
    statsChartRow: "{filter} · {tokens} 个 token · 占全部节省 {share}%",
    statsChartEmpty: "还没有按过滤器记账的数据（改写形态看不到输出，这里只会统计结果压缩）",
    statsUnavailable: "统计读面未连接（压缩本身不受影响）",
    resetStats: "清零统计",
    switchSection: "开关",
    enabledLabel: "启用 rtk 压缩",
    enabledHintPrefix:
      "未手动设置时，检测到受支持的 rtk 才默认开启；手动切换会固定选择。打开后 bash 命令会先问 rtk 能否改写；问不到就原样执行。",
    enabledHintWithPipe:
      "未手动设置时，检测到受支持的 rtk 才默认开启；手动切换会固定选择。打开后按所选形态处理：改写命令，或在结果侧压缩输出；不可用或收益不足时原样放行。",
    formsLabel: "启用的形态",
    formsHint:
      "prefix = 改写命令（主路径，会 spawn `rtk rewrite`，受 rewriteTimeoutMs 管；Windows 上不装配 prefix）；prefix+pipe = 额外在结果侧按 filter 压缩（B 形态）；pipe = 只压结果、不改命令（绕过拦截 bash 的护栏工具时用）。改完下一次工具调用即生效。",
    formPrefix: "仅改写命令",
    formPrefixAndPipe: "改写 + 结果压缩",
    formPipeOnly: "仅结果压缩",
    pipeDisabledHint:
      "结果压缩当前关闭：rtk 的 vitest filter 在 5.x 上只剩一行 passthrough，等官方修好再开。",
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
      "统计由插件自记账（rtk pipe 不写 rtk gain）。token 由宿主的 tokenMeter 估算（服务缺席时按 bytes/4），节省率按 token 算；改写形态看不到原始输出，它省下的量请看 rtk gain。",
    rtkMissingHint:
      "rtk not found：PATH 上找不到 rtk，压缩不会生效。macOS 用 brew install rtk，Windows 用 winget install rtk-ai.rtk。",
    rtkTooOldHint: "探到的 rtk 是 {version}，低于支持的 {minimum}：请升级 rtk 后再打开压缩。",
    rtkReadyHint: "就绪：{version}（{path}）",
  },
  en: {
    cardTitle: "rtk output compression",
    navLabel: "rtk compression",
    statusSection: "Self-accounted stats",
    statsCommands: "Compressed commands",
    statsSaved: "Tokens saved",
    statsByForm: "Per form (rewrite / output compression)",
    statsSavings: "Savings",
    statsChartTitle: "Tokens saved per filter",
    statsChartHint:
      "Bar length is relative to the largest filter; the percentage is that filter's share of all tokens saved.",
    statsChartRow: "{filter} · {tokens} tokens · {share}% of total saved",
    statsChartEmpty:
      "No per-filter records yet (the rewrite form cannot see output, so only output compression is counted here)",
    statsUnavailable: "Stats channel unavailable (compression itself is unaffected)",
    resetStats: "Reset stats",
    switchSection: "Switches",
    enabledLabel: "Enable rtk compression",
    enabledHintPrefix:
      "Until set explicitly, this follows rtk readiness: on only when a supported rtk is detected; a manual toggle pins the choice. When on, bash commands are first offered to rtk; if rtk declines, the command runs unchanged.",
    enabledHintWithPipe:
      "Until set explicitly, this follows rtk readiness: on only when a supported rtk is detected; a manual toggle pins the choice. When on, the selected form rewrites commands and/or compresses their output; unavailable or low-gain results pass through unchanged.",
    formsLabel: "Enabled forms",
    formsHint:
      "prefix = rewrite the command (main path; spawns `rtk rewrite`, bounded by rewriteTimeoutMs, not assembled on Windows); prefix+pipe = also compress output by filter (form B); pipe = compress output only, never rewrite (for setups that block command rewriting). A change takes effect on the next tool call.",
    formPrefix: "Rewrite only",
    formPrefixAndPipe: "Rewrite + output compression",
    formPipeOnly: "Output compression only",
    pipeDisabledHint:
      "Output compression is currently off: rtk's vitest filter collapses to one passthrough line on 5.x. Re-enable once upstream fixes it.",
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
      "Stats are self-accounted by this plugin (rtk pipe does not write rtk gain). Tokens are estimated by the host tokenMeter (bytes/4 when that service is absent) and the savings rate is computed on tokens; the rewrite form never sees the original output — read `rtk gain` for that saving.",
    rtkMissingHint:
      "rtk not found on PATH, so compression cannot run. macOS: brew install rtk. Windows: winget install rtk-ai.rtk.",
    rtkTooOldHint:
      "Found rtk {version}, below the supported {minimum}: upgrade rtk before enabling compression.",
    rtkReadyHint: "Ready: {version} ({path})",
  },
};
