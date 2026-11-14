// 插件自己的双语常量。全文提示不在这里：那是宿主给的 SpillRef.retrievalHint，
// 插件只负责把它原样转交，不自己拼路径（v3.4 用 ref.path 拼过一次，那是硬错 1）。
//
// 查表**不在这里**：`messagesFor(catalog, locale)` 与 `MessagesCatalog` 由
// `@jayyuen66/dsh-plugin-shared/lib/locale` 提供，语言归一（`en-US` → `en`、非法值回退
// 默认语言）也在那边。本文件只声明键集与文案——抄一份二分派发会漏掉主标签归一，
// 宿主哪天加第三门语言时还会静默取不到文案而编译通过。
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/**
 * 本插件的消息键集。值域锁在 string 上由 `MessagesCatalog` 的同构映射保证。
 *
 * **键集只留真的从宿主发出去了的那几句**。之前这里还躺着一对 `notInstalled` / `versionTooOld`
 * 与一句 `cardStatsNote`，生产代码零消费（只有测试把它当存在性断言比对）：前者与卡片字典
 * `src/ui-messages.ts` 里的 `rtkMissingHint` / `rtkTooOldHint` 是同一件事的两份原文，改一处
 * 不会让另一处跟动；后者是卡片内说明文字的服务端影子rix，永远不会被渲染。死键不是「将来可能用」，
 * 它是一份会跟真文案分叉、且没人维护错的那一份。
 *
 * 卡片上要说话时，文案归 `src/ui-messages.ts`（它有语言偏好、有占位符校验、有真宿主渲染回路）；
 * 这里只留**宿主发出的**消息——它们与模型的 `UserMessage` 一路走，不经过卡片。
 */
export interface Messages {
  cargoTestWarnHint: string;
  /** 全文已存为 spill 时附在 `additionalContexts` 里的摘要（官方 `form: "notice"` 的 summary，≤120 字）。 */
  spillSummary: string;
  /**
   * 那条 notice 的**正文**：必须写出宿主给的 locator。
   *
   * `SpillRef.retrievalHint` 是一句固定指引，不含路径（实测装出来的 `dsh-spill-local`：
   * `"Use read with offset/limit, or grep this path to search within it."`）。只把它当正文发出去，
   * 模型看到的是「去读那个路径」却没有任何路径 —— 取回通道等于不存在。
   */
  spillLocation: string;
}

export const MESSAGES: MessagesCatalog<Messages> = {
  zh: {
    cargoTestWarnHint:
      "[rtk] cargo test 前缀不保留编译警告；需要看警告请直接跑 cargo build / cargo check",
    spillSummary: "压缩前的完整输出已另存为文件",
    spillLocation: "压缩前的完整输出已存为 {path}。{hint}",
  },
  en: {
    cargoTestWarnHint:
      "[rtk] cargo test prefix drops compile warnings; run cargo build / cargo check to see them",
    spillSummary: "The full pre-compression output was saved to a file",
    spillLocation: "The full pre-compression output is stored at {path}. {hint}",
  },
};
