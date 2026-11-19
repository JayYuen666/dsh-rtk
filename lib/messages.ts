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
  /**
   * 「放宽放行」时写在**压缩体首行**的那一句。
   *
   * 与 `spillLocation` 分开：那条挂在 `additionalContexts` 上（官方 `form: "notice"`），模型
   * 读得到但不一定与正文一起被再读一遍；`lost-hash` / `folded-entries` 被放行的这一次，正文
   * 本身少了东西，路径必须就在正文第一行。形状照抄宿主 `dsh-spill-policy` 的 notice（省了
   * 多少 + 路径 + 指引），差别只是它进上下文附注、这份进正文。
   */
  spillRelaxed: string;
  /**
   * 压缩体超过 stdoutCapBytes、只能保留尾部时写在压缩体首行的那一句。
   *
   * 与 spillRelaxed 分开：那一句讲「护栏放行了一次有损压缩」，这一句讲「帽切掉了尾部之外的
   * 前半段」。两件事可以同时发生；更重要的是，帽截断原先没有任何正文提示，模型会把半行当成
   * 完整一行读。
   */
  spillCapped: string;
  /**
   * 常驻 systemPrompt 的摘要段：模型每轮都读它，所以只写「不照做会误判」的几条。
   *
   * 全文放 skill（`usageText`），按名加载。拆开的理由与两处各放什么见 `lib/skill.ts` 头注释。
   */
  usageSummary: string;
  /** skill 目录里那行说明（模型据此决定要不要加载全文）。 */
  skillDescription: string;
  /** 常驻摘要末尾的指路句：全文在哪、怎么加载。只在 skill 真注册上时才追加。 */
  skillPointer: string;
  /** skill 全文：压缩做了什么、什么一律不碰、想要原文怎么办、数据落在哪。 */
  usageText: string;
}

/**
 * 口径全文里两张表共用的分隔行。提成常量是因为它在一份文档里出现四次（两语 × 两张表），
 * `sonarjs(no-duplicate-string)` 会把它算成四处重复——而这四处的值**必须**逐字相同，
 * 各写一遍反而是四份会分叉的副本。
 */
const TABLE_RULE = "| --- | --- | --- |";

export const MESSAGES: MessagesCatalog<Messages> = {
  zh: {
    cargoTestWarnHint:
      "[rtk] cargo test 前缀不保留编译警告；需要看警告请直接跑 cargo build / cargo check",
    spillSummary: "压缩前的完整输出已另存为文件",
    spillLocation: "压缩前的完整输出已存为 {path}。{hint}",
    spillRelaxed: "[rtk] 这一段删掉了 {omitted}；完整原文在 {path}。{hint}",
    spillCapped:
      "[rtk] 正文超过 {cap} 字节、已省掉 {omitted}（只留尾部）；完整原文在 {path}。{hint}",
    usageSummary: [
      "本会话装着 dsh-rtk：bash 命令会被改写成 `rtk <cmd>` 前缀，命令输出会按形态被压缩。压缩只针对机器噪点，规则如下。",
      "",
      "- **你在读的东西不会被压。** 命令被改写成 `rtk read` / `rtk <filter>` 之后，输出仍按下面各档处理；但 `cat src/app.ts`、`head -1000 lib/guard.ts`、`cat notes.txt`、`cat README.md` 这类**读文件**的命令——操作数不是日志扩展名（`.log` / `.out` / `.err` / `.jsonl` / `.ndjson` / `.trace` / `.dump`）时——一律原样交出，两条压缩路都不碰它。日志文件（`cat build.log`、`tail -100 app.log`）与自身就是日志的命令（`journalctl` / `dmesg` / `docker logs` / `kubectl logs` / `ps`）才进窗口。",
      "- **被压掉的东西都在原文里。** 正文出现 `[+N lines omitted]`（本地头尾窗口切掉的中段）、`[xN]`（连续 N 行完全相同被折成一行）或 `[+N hidden: rtk recall <hash>]`（rtk 折叠的中段）时，完整原文仍在：窗口那两档的首行会写落盘路径，rtk 那档用 `rtk recall <hash>` 取回。需要逐字看清某一段时，先取回再判断，不要拿省略后的片段当全文推断。",
      "- **要对输出做精确判断时，绕开压缩。** 唯一干净的写法是给它加 `rtk bypass ` 前缀（例如 `rtk bypass git diff`）：这样前缀层不改写、结果层也不压。`--no-compact` 只有 `rtk git diff` / `rtk git log` 认，**不是 git 自己的参数**，别指望它；`RTK_DISABLED=1` 对已经被改写的命令无效。",
      "- **统计面的口径。** 洞察页与设置卡只统计这个 dsh 会话里的调用，数据在 `$DSH_HOME/rtk/history.db`；你自己终端里跑的 rtk 不进来。",
    ].join("\n"),
    skillDescription:
      "dsh-rtk 的压缩口径：哪两类压缩、什么一律不碰、被省掉的原文去哪里取回、想让某条命令原样输出时怎么办。需要判断「我读到的这份输出是不是残件」或「这条命令该不该绕开压缩」时加载。",
    skillPointer:
      "- 完整口径（两档压缩各做什么、取回通道、绕开压缩的唯一写法）见 skill `rtk`，需要时用 skill 工具按名加载。",
    usageText: [
      "# dsh-rtk：命令改写与输出压缩的口径",
      "",
      "本插件在两类位置动你的输出。知道这两类各自做什么、被省掉的部分去哪取回，比记住具体压缩率更要紧。",
      "",
      "## 一、命令改写（前缀层）",
      "",
      "模型发的 bash 命令在**执行前**被改写成 `rtk <cmd>` 的形式（`cargo test` → `rtk cargo test`、`git diff` → `rtk git diff`）。rtk 会用自己那份带压缩的输出实现跑它，退出码原样透传。",
      "",
      "- 复合命令逐段判：`cd x && git diff && cargo test` → `cd x && rtk git diff && rtk cargo test`。只有 rtk 认的段才加前缀。",
      "- 过不了闸门的段原样保留：唯一一条闸门是 `aws`（命令不存在时原生退 127、rtk 退 1，退出码换了含义）。",
      "- 带「要更多细节」旗标的命令不改写：`cargo test -- --nocapture`、`pytest -vv` 这类，细节会被压掉。",
      "- `pnpm test` / `npm test` / `yarn test` 这三种形态 rtk 改不动（它的规则要求显式 `run`）。",
      "",
      "## 二、输出压缩（结果层）",
      "",
      "执行完之后，输出按形态走四档之一：",
      "",
      "| 档 | 触发 | 做什么 |",
      TABLE_RULE,
      "| `rtk` | 命令命中 rtk 的 filter 表（cargo test / pytest / tsc / git log / git diff / git status / grep / find / vitest 五类之外的那些） | `rtk pipe -f <filter>` 按该工具的格式压 |",
      "| `strip` | `vitest run`、`pnpm test`、`npm test`、`yarn test` | 本包在内存里删掉 `✓` 通过行，失败块逐字保留；不 spawn rtk |",
      "| `hook` | 没有命中 filter 表的长输出，且不是阅读材料 | `rtk hook claude` 的清理链：清 ANSI、折进度帧、把连续 ≥3 行相同折成一行 + `[xN]` |",
      "| `window` | **日志类目标** | 留头 50 + 尾 200 行，中段折成 `[+N lines omitted]` |",
      "",
      "`hook` 与 `window` 串联：先清理再切窗（实测 792 行构建日志 32,550 B → 9,228 B，只切窗 10,366 B）。链判无收益（rtk 回 0 字节）时窗口兜底。",
      "",
      "## 三、什么一律不碰",
      "",
      "**读文件的命令 + 操作数不是日志扩展名 = 阅读材料，两条路都不动。** 判据在 `isReadingTarget`：",
      "",
      "- 不碰：`cat src/app.ts`、`cat notes.txt`、`cat README.md`、`head -1000 lib/guard.ts`、`less docs/DETAIL.zh.md`、`cat package.json`。",
      "- 会压：`cat build.log`、`tail -100 app.log`、`cat events.jsonl`、`journalctl`、`dmesg`、`docker logs`、`kubectl logs`、`ps`。",
      "",
      "日志扩展名白名单：`.log` / `.out` / `.err` / `.jsonl` / `.ndjson` / `.trace` / `.dump`（`.gz` 等压缩后缀与 `.1` 轮转编号可叠加）。`.txt` 与 `.md` **不在**其中——账本里那些 `.txt` 是要逐字读的报告与正文。",
      "",
      "源码再长也不压：这条是硬的，与「省了多少」无关。判读代码时被挖掉中段，比多看几千 token 贵得多。",
      "",
      "## 四、被省掉的东西去哪取回",
      "",
      "| 标记 | 含义 | 怎么取回 |",
      TABLE_RULE,
      "| `[+N lines omitted]` | 本地窗口按行数切掉的中段 | 正文**首行**写着落盘路径，用 read/grep 打开它 |",
      "| `[xN]` | 连续 N 行完全相同、折成了 1 行 | 那 N 行本来一样，看留下来的那行即可 |",
      "| `[+N hidden: rtk recall <hash>]` | rtk 折叠的中段，存在 dsh 自己的 recall 库里 | `rtk recall <hash>`（库在 `$DSH_HOME/rtk/recall.db`） |",
      "| `[rtk] 这一段删掉了 …；完整原文在 <path>` | 护栏判定「有损但可取回」后放行的 | 同第一行，路径就在同一行 |",
      "",
      "窗口与护栏那两档**只在原文真的落得进 spill 时**才放行；落不进就整条放弃压缩、原样交出。所以看到这些标记，取回通道一定是通的。",
      "",
      "## 五、想让某条命令原样输出",
      "",
      "给命令加 `rtk bypass ` 前缀：`rtk bypass git diff HEAD~1`。前缀层判 `already-rtk` 不改写，结果层同样不压。这是**唯一**干净的绕开写法。",
      "",
      "别用这两条：`--no-compact` 只有 `rtk git diff` / `rtk git log` 认，原生 git 不认（`git diff --no-compact` 直接报 usage）；`RTK_DISABLED=1` 对已经走 rtk 的命令无效。",
      "",
      "## 六、数据在哪",
      "",
      "- 账本：`$DSH_HOME/rtk/history.db`（默认 `~/.dsh/rtk/history.db`）。前缀层给每段 `rtk` 命令注入 `RTK_DB_PATH` 指到这里，所以你**自己终端**里跑的 rtk 不进来，这里也没有它的数。",
      "- 取回库：`$DSH_HOME/rtk/recall.db`（同一个注入带 `RTK_RECALL_DB`）。",
      "- 清理链配置：`$DSH_HOME/rtk/config/pipeline.toml`，由本插件生成，改动会被覆盖。",
      "- 统计口径只覆盖 dsh 会话；洞察页在左侧栏「rtk 统计」。",
    ].join("\n"),
  },
  en: {
    cargoTestWarnHint:
      "[rtk] cargo test prefix drops compile warnings; run cargo build / cargo check to see them",
    spillSummary: "The full pre-compression output was saved to a file",
    spillLocation: "The full pre-compression output is stored at {path}. {hint}",
    spillRelaxed: "[rtk] this excerpt dropped {omitted}; the full text is at {path}. {hint}",
    spillCapped:
      "[rtk] the body exceeded {cap} bytes; {omitted} was omitted (tail kept). The full text is at {path}. {hint}",
    usageSummary: [
      "This session has dsh-rtk loaded: bash commands are rewritten to carry an `rtk <cmd>` prefix, and command output is compressed by shape. Compression only targets machine noise; the rules:",
      "",
      "- **What you are reading is never compressed.** Reading commands — `cat src/app.ts`, `head -1000 lib/guard.ts`, `cat notes.txt`, `cat README.md` — are handed over untouched when the operands carry no log extension (`.log` / `.out` / `.err` / `.jsonl` / `.ndjson` / `.trace` / `.dump`). Both compression paths skip them. Only log files (`cat build.log`, `tail -100 app.log`) and commands that are themselves log-shaped (`journalctl` / `dmesg` / `docker logs` / `kubectl logs` / `ps`) get windowed.",
      "- **Whatever was dropped still exists.** When the body shows `[+N lines omitted]` (the middle cut by the local window), `[xN]` (N identical consecutive lines folded into one) or `[+N hidden: rtk recall <hash>]` (a section rtk folded), the full text is still there: the window paths write the spill path on the first body line, and the rtk path is retrieved with `rtk recall <hash>`. Fetch the original before reasoning over an excerpt — do not treat a cut fragment as the whole.",
      "- **To judge output exactly, bypass compression.** The only clean way is to prefix the command with `rtk bypass ` (e.g. `rtk bypass git diff`): the rewrite layer leaves it alone and the result layer does not touch it. `--no-compact` is understood only by `rtk git diff` / `rtk git log` and is **not** a git flag; `RTK_DISABLED=1` does nothing for a command that already goes through rtk.",
      "- **What the numbers cover.** The insights page and the settings card count this dsh session only, stored in `$DSH_HOME/rtk/history.db`; rtk runs in your own terminal are not included.",
    ].join("\n"),
    skillDescription:
      "dsh-rtk's compression rules: what the two layers do, what is never touched, where the dropped text can be retrieved, and how to keep one command verbatim. Load when you need to judge whether an output is an excerpt or how to bypass compression.",
    skillPointer:
      "- The full rules (what each compression layer does, the retrieval paths, the one clean way to bypass) are the skill `rtk`; load it by name with the skill tool when you need it.",
    usageText: [
      "# dsh-rtk: how command rewriting and output compression behave",
      "",
      "This plugin touches your output in two places. Knowing what each layer does and where the dropped text goes matters more than the exact savings.",
      "",
      "## 1. Command rewriting (prefix layer)",
      "",
      "A bash command is rewritten **before execution** to `rtk <cmd>` (`cargo test` → `rtk cargo test`, `git diff` → `rtk git diff`). rtk runs it through its own compressing implementation and passes the exit code through unchanged.",
      "",
      "- Compound commands are judged per segment: `cd x && git diff && cargo test` → `cd x && rtk git diff && rtk cargo test`. Only segments rtk recognises get the prefix.",
      "- Segments that fail the gate stay verbatim. There is exactly one gate left: `aws` (a missing binary exits 127 natively and 1 under rtk — the code changes meaning).",
      "- Commands carrying a detail flag are not rewritten: `cargo test -- --nocapture`, `pytest -vv`; the detail would be compressed away.",
      "- `pnpm test` / `npm test` / `yarn test` are not rewritten at all (rtk's rules require an explicit `run`).",
      "",
      "## 2. Output compression (result layer)",
      "",
      "After execution the output takes one of four paths:",
      "",
      "| Path | Trigger | What it does |",
      TABLE_RULE,
      "| `rtk` | the command matches rtk's filter table (cargo test / pytest / tsc / git log / git diff / git status / grep / find) | `rtk pipe -f <filter>` compresses by that tool's format |",
      "| `strip` | `vitest run`, `pnpm test`, `npm test`, `yarn test` | this plugin drops `✓` passing lines in memory, failing blocks stay verbatim; rtk is not spawned |",
      "| `hook` | long output that matched no filter and is not reading material | the `rtk hook claude` cleanup chain: ANSI out, progress frames folded, runs of ≥3 identical lines folded to one + `[xN]` |",
      "| `window` | **log-shaped targets** | keep the first 50 and last 200 lines, the middle becomes `[+N lines omitted]` |",
      "",
      "`hook` and `window` chain: clean first, then window (measured on a 792-line build log: 32,550 B → 9,228 B, against 10,366 B for the window alone). When the chain finds no gain (rtk emits zero bytes) the window is the fallback.",
      "",
      "## 3. What is never touched",
      "",
      "**A reading command whose operands carry no log extension is reading material; both paths leave it alone.** The test is `isReadingTarget`:",
      "",
      "- Untouched: `cat src/app.ts`, `cat notes.txt`, `cat README.md`, `head -1000 lib/guard.ts`, `less docs/DETAIL.zh.md`, `cat package.json`.",
      "- Compressed: `cat build.log`, `tail -100 app.log`, `cat events.jsonl`, `journalctl`, `dmesg`, `docker logs`, `kubectl logs`, `ps`.",
      "",
      "Log extension whitelist: `.log` / `.out` / `.err` / `.jsonl` / `.ndjson` / `.trace` / `.dump` (compression suffixes such as `.gz` and rotation numbers stack). `.txt` and `.md` are **not** on it — the `.txt` files in a real ledger are reports and prose meant to be read.",
      "",
      "Source code is never compressed no matter how long: that rule is hard and independent of how much it would save. Reading code with its middle cut out costs far more than reading a few thousand extra tokens.",
      "",
      "## 4. Where dropped text can be retrieved",
      "",
      "| Marker | Meaning | How to get it back |",
      TABLE_RULE,
      "| `[+N lines omitted]` | the middle the local window cut | the **first body line** names the spill path; open it with read/grep |",
      "| `[xN]` | N identical consecutive lines folded into one | those N lines were identical; the surviving one says it |",
      "| `[+N hidden: rtk recall <hash>]` | a section rtk folded, kept in dsh's own recall store | `rtk recall <hash>` (the store is `$DSH_HOME/rtk/recall.db`) |",
      "| `[rtk] this excerpt dropped …; the full text is at <path>` | the guard found it lossy but retrievable and let it through | same as the first row: the path is on that line |",
      "",
      "The window and the relaxed guard pass both require the original to actually reach spill; if it cannot, the whole compression is dropped and the output goes through verbatim. So when these markers appear, the retrieval path is live.",
      "",
      "## 5. Keeping one command verbatim",
      "",
      "Prefix it with `rtk bypass `: `rtk bypass git diff HEAD~1`. The rewrite layer judges `already-rtk` and leaves it alone; the result layer does not compress it either. This is the **only** clean bypass.",
      "",
      "Do not rely on these: `--no-compact` is understood only by `rtk git diff` / `rtk git log` — native git rejects it (`git diff --no-compact` prints usage); `RTK_DISABLED=1` has no effect on a command that already goes through rtk.",
      "",
      "## 6. Where the data lives",
      "",
      "- Ledger: `$DSH_HOME/rtk/history.db` (default `~/.dsh/rtk/history.db`). The prefix layer injects `RTK_DB_PATH` pointing there for every `rtk` segment, so rtk runs in **your own terminal** neither appear here nor are counted.",
      "- Retrieval store: `$DSH_HOME/rtk/recall.db` (`RTK_RECALL_DB` rides the same injection).",
      "- Cleanup chain config: `$DSH_HOME/rtk/config/pipeline.toml`, generated by this plugin; edits are overwritten.",
      '- The counters cover dsh sessions only; the insights page is "rtk 统计" in the sidebar.',
    ].join("\n"),
  },
};
