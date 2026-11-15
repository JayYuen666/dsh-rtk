<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-rtk@main/icon.svg" width="96" height="96" alt="dsh-rtk logo" />
</p>

<h1 align="center">dsh-rtk</h1>

<p align="center"><em>在命令输出进入模型之前，用本机的 rtk CLI 压缩 bash/pwsh 结果：改写命令前缀、post-execute 的 pipe 兜底，以及一张报告省了多少的设置卡。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-rtk"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-rtk?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-rtk"><img src="https://img.shields.io/npm/d18m/@jayyuen66/dsh-rtk?style=flat-square" alt="npm downloads (total)" /></a>
  <a href="https://github.com/JayYuen666/dsh-rtk/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-rtk/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D24.9-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.2--rc.2-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

---

**一个把本机 `rtk` 二进制放到 shell 工具与模型之间的 [dsh](https://github.com/deepseek-ai/deepseek-harness) 插件。rtk 本身留在你的机器上；插件只负责调度它。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [它做什么](#-它做什么)
- [安装](#-安装)
- [验证它真的生效了](#-验证它真的生效了)
- [它不提供什么](#-它不提供什么)
- [在 dsh 里启用](#-在-dsh-里启用)
- [两种形态](#-两种形态)
- [设置项](#-设置项)
- [支持面](#-支持面)
- [外部依赖](#-外部依赖)
- [数据与隐私](#-数据与隐私)
- [已知边界](#-已知边界)
- [开发](#-开发)
- [许可证](#-许可证)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- **两种压缩形态；总开关跟随 rtk 就绪状态。** `prefix` 按 agent 遮蔽 `bash`、先过一遍 `rtk rewrite`；`pipe` 把已完成的 shell 结果喂给 `rtk pipe -f <filter>`，只替换模型可见的那段文本。未显式设置 `enabled` 时，检测到受支持的 rtk 才默认开启；`prefix` 是默认形态，`pipe` 需要显式打开。
- **复合命令逐段改写。** `cd <仓库> && cargo test` 这种多仓开发时最常见的形状会被拆成独立段，只换掉承载输出的那一段（`cd <仓库> && rtk cargo test`）；拆不开的构造（命令替换、重定向、后台 `&`、引号不配对）仍然整条原样执行。
- **不值得压的一律不压。** 小于 `minBytes`（256）的输出、压缩率不足 `minGainRatio`（0.95）的改写，全部原样放行。插件不报它没做到的节省。
- **失败用例保住原文。** 护栏会拒绝任何丢掉失败断言、file:line 或退出码 marker 的压缩——一条看不出为什么挂的失败比不压缩更糟。
- **处处 fail-open。** rtk 没装、rtk 太旧、改写会破坏语义、命令不适合改写：原命令照跑、原文照样送达、什么都不丢。
- **一张设置卡。** 命令数、省下的 token 与节省率，外加一张按 filter 的 token 收益条形图，经官方 Typert Remote 命名空间从宿主 storage domain 读出。

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-rtk
```

撤除用 `dsh plugin --profile web remove @jayyuen66/dsh-rtk`。包在公共 npm 上，不需要凭据，也不需要 scoped registry 那行。

- **Node.js `>= 24.9`**（纯 ESM；这个地板正是 `require()` 一个 ESM 入口能成立的前提，所以 `engines.node` 写它）。
- **宿主 `dsh` 在 `0.2.x` 这条线上、且不低于 `0.2.2-rc.2`。** 宿主读 `engines.dsh`（`^0.2.2-rc.2`）且**单独决定**——该字段在场时兼容性先于 `peerDependencies` 判定，prerelease 参与比较。`0.2.x` 里凡不低于 `0.2.2-rc.2` 的都通过宿主装载门；`0.2.2-rc.1` 及更早的不通过。npm 的严格 peer 解析同样不接受低于 `0.2.2-rc.2` 的版本，且 prerelease 一侧只收 `0.2.2` 这一元组的（`0.2.2-rc.2` 起）——更高小版本的预发布（如 `0.2.3-rc.1`）要等它的正式版。`0.3.0` 及以上需要风险授权 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <确切版本> --accept-risk`。支持窗口是滚动的：本包在发布时把窗口内的每个已发布宿主版本逐版取证（判据是宿主 `--dump-config` 里本包的层行；设置卡与它的命名空间调用另在发布基线上全量取证一次），窗口滚动后重新取证，不把这一句里的版本号当长期承诺。
- **`dependencies` 里没有 `@deepseek-ai/*`，这是契约**（`test/publish-manifest.test.ts`）。profile 用 `nodeLinker: hoisted` + `autoInstallPeers: false` 安装，放进去的宿主包会变成实打实的第二份副本；`@deepseek-ai/dsh-tools` 用普通 `Symbol` 给调度器做键，于是那个 profile 里**每次原生工具调用都会抛**，而 build、typecheck、覆盖率全绿。`@deepseek-ai/dsh*` peer 携带同一个支持窗口（`^0.2.2-rc.2`），而 `devDependencies` 里的精确钉版是编译期纪律，不是「宿主会读它」的声明。
- **`PATH` 上要有 `rtk >= 1.0.0`。** 这是 npm 之外唯一的运行时依赖：macOS/Linux 用 `brew install rtk`，Windows 用 `winget install rtk-ai.rtk`。没有它插件照常装载，所有压缩路径 fail-open。
- **随包发布的内容**：`host.js`、`client.js`、`cordis.patch.yml`、`icon.svg`、双份 README、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`locale/zh.json` + `locale/en.json`，以及 `docs/`（两份 DETAIL）。产物由 `prepack` 重建，从不入库。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 验证它真的生效了

1. **层进了栈。** `dsh --profile web --dump-config` 末尾有 `# == @jayyuen66/dsh-rtk` 与 `- id: rtk`。这条命令是唯一被接受的判据，且**不是只读的**——层行要从 stdout 读，同时**另外**检查 stderr；`# == <层>` 与 `# == <层>, patched by <路径>` 两种形状都要认。
2. **rtk 被找到了。** 卡片的就绪行会写出解析到的二进制与它的版本。那里显示 `rtk not found` 说明宿主进程的 `PATH` 与你的 shell 不同。
3. **某条命令被压了。** `enabled: true` 且卡片计数为零时，让模型跑一次构建或测试套件：下一次卡片刷新里会出现那条调用与字节差。
4. **卡片画得出来。** 设置页会列出「rtk 输出压缩」（或它的英文标题）；改一个值 + **保存** 回 200 且脏态清空。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

- **没有自己的 HTTP 路由。** 卡片的数据面是官方 Typert Remote 命名空间，经宿主 `/api` 网关；认证、Host/DNS 重绑定/Origin 判据、body 上限都由网关承担。
- **没有 CLI 子命令。** `dsh rtk …` 不存在。
- **不捆绑 rtk 代码。** 插件把 `rtk` 命令当子进程调用、消费它的 stdout。用的是 rtk 的 Apache-2.0 面；BUSL engine 里没有任何东西被链接或再分发。
- **不改写工具入参。** dsh 刻意禁止 `tools/pre-execute` 改写工具调用的参数（参数已经被记录与渲染）。所以 `prefix` 形态靠按 agent 遮蔽 `bash` 实现，而不是去改一次已发生的调用。
- 需要的服务面：`settings` / `tools` / `subprocess`（都在 `inject` 里）。`spillStore` 与 `storageDomain` 经 `ctx.get()` 现读，缺席时优雅降级。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- `dsh.bundle.patch` 指向 `cordis.patch.yml`，它的 `insert:` 块只有一条 `- id: rtk`，`name: "@jayyuen66/dsh-rtk"`——**裸包名**才让宿主去扫客户端那一半。卡片组件打包进 `client.js`（只有 `react` / `zod` 留在宿主模块表外）。
- 缺任何一个注入面都会让 cordis 不激活该条目（启动诊断：`pending (waiting for service: …)`）；ctx 形状不对则应用 apply 时抛 `required services … missing`。
- 部署默认值写在注册行的 `config:` 上；优先级是卡片运行值 > 注册行 config > schema `.default()`。`enabled` 没有静态 `.default()`：未设置时按 rtk 版本探测结果兜底。
- **总开关跟随 rtk 就绪状态。** 未显式设置 `enabled` 时，rtk 缺失或低于支持下限就保持关闭，检测到受支持版本才默认开启。`prefix` 是默认形态；手动关掉或打开会固定你的选择。开关与形态选择都在下一次工具调用时生效。

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 两种形态

| | **prefix** | **pipe** |
| --- | --- | --- |
| 时机 | 命令执行之前 | shell 结果已存在之后 |
| 做法 | 按 agent 遮蔽 `bash`，问 `rtk rewrite`，跑改写后的形态 | 把捕获到的 stdout 喂给 `rtk pipe -f <filter>` |
| 模型看到什么 | 改写后命令的压缩输出 | 压缩输出，原始 marker 与退出码保持不变 |
| 失败形态 | 改写被拒 → 原命令执行 | filter 不可用 → 原文送达 |
| 复合命令 | 逐段改写：只换承载输出的那一段 | 整条命令的输出一起压 |
| 默认 | `enabled` 打开时启用 | 关闭（等 rtk 覆盖更多形态） |

`prefix` 的复合命令处理值得单独说一句：rtk 自己就是逐段改写的（`discover/registry.rs` 的 `rewrite_compound`），实测 `cd /tmp && cargo test` 的产物是 `cd /tmp && rtk cargo test`。插件把原命令与产物各拆成若干段，要求**分隔符序列逐一相同**、并让每一段各自通过 P1~P4 校验（没被动过的段逐字符不变，被动过的那段只允许「在开头多一个 `rtk `」）。改成别的形状一律拒绝、原命令执行。

## <img src="https://api.iconify.design/lucide/settings.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | 未设置 | 总开关；未设置时检测到受支持的 rtk 才默认开启 |
| `enabledForms` | `['prefix']` | 允许生效的形态；下一次工具调用即生效 |
| `denyCommands` | `[]` | 额外永不被改写的命令模式 |
| `enabledFilters` | `['cargo-test','pytest','ctest']` | 允许生效的 pipe filter |
| `minBytes` | `256` | 小于它的输出永不压缩 |
| `minGainRatio` | `0.95` | 压缩后仍占 ≥95% 字节的，丢弃 |
| `stdoutCapBytes` | `64000` | filter 回执的字节上限：压缩后的正文截尾到这个字节数（退出标记保留） |
| `warnHint` | `true` | `cargo test` 之后追加编译警告提示行 |
| `rewriteHostEnv` | `''` | 写进 `RTK_REWRITE_HOST` 的值；空串表示不设 |
| `pipeTimeoutMs` | `3000` | 重启生效 |
| `rewriteTimeoutMs` | `2000` | 重启生效 |
| `rewriteCacheSize` | `256` | 重启生效 |
| `vitestMaxMajor` | `5` | 重启生效；vitest 达到该主版本就不压 |
| `logFilterMode` | `'off'` | 重启生效 |

配置 schema 共 14 个字段；其中 13 个带内置默认值，`enabled` 在显式设置前跟随 rtk 就绪状态。其中卡上那 9 枚是 volatile —— 设置卡写它们，下一次工具调用就生效，`enabledForms` 也在其中。剩下的**非 volatile 部署值**，共 5 枚，在装配时读一次，改完要重启。前缀形态会写 rtk 自己的 `history.db`——真正跑的是改写后的那条命令。

## <img src="https://api.iconify.design/lucide/monitor.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 支持面

`engines.dsh` 与 `@deepseek-ai/dsh*` peer 是 `^0.2.2-rc.2`（单条线，无并集）；`@deepseek-ai/schemastery` peer 是 `^3.19.0`；`engines.node` 是 `>=24.9.0`。

## <img src="https://api.iconify.design/lucide/cpu.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 外部依赖

本仓里每一条结论都是在 rtk 1.2.0 上量出来的。插件要求 `>= 1.0.0`；低于它时插件报出读到的版本，什么都不做。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

- **命令文本只以 argv 的形式离开宿主进程，交给你自己那个 `rtk` 二进制。** 本插件不发起任何网络请求。
- **计数存在宿主的 storage domain 里**（`<DSH_HOME>/storages/`），每个 filter 一条记录加一条汇总；记录里有命令数、前后字节、前后 token。别的什么都不落盘。
- **token 由宿主的 `tokenMeter` 估算**（服务缺席时按 `bytes / 4`，与 rtk 官方 `estimate_tokens_from_len` 同一口径）。改写形态看不到原始输出，它省下的量只能看 `rtk gain`；统计卡里的数字全部来自结果压缩形态。
- **被压缩的原文可能落进宿主的 spill 区**——当它超过内联预算时，走的是宿主每个工具都在用的那套机制，同样的按会话分区。

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

- **`rtk rewrite` 分不清某个 flag 是不是在要更多细节。** 它把 `cargo test -- --nocapture` 和 `pytest -vv` 跟安静形态一样改写，细节随后被压掉。插件拒绝改写任何带详情 flag 的命令；真压的时候，损失由护栏兜住，不由 rtk 兜。
- **`npm run <script>` 永不被改写。** rtk 把脚本名映射成工具名（`npm run lint` → `rtk lint`），那会跑 ESLint 而不是你的脚本。插件会丢掉任何「从原命令里拿掉了某个词」的改写。
- **listing 类命令会折叠。** `ls`、`find`、`grep`/`rg` 可能把长列表换成 `+N more` 标记；护栏识别这一族标记并拒绝压缩，所以折叠后的列表不会经本插件到达模型。
- **审批看到的是你请求的命令，不是改写后的命令。** 遮蔽层在 `execute` 里改 `args.command`，而 `execute` 跑在管线的 `tools/pre-execute` **之后**。所以通用命令审批（auto-review、danger-guard、Claude Code 风格的 hooks）求值的是冻结的原始参数（`cargo test`），实际跑的是改写形态（`rtk cargo test`）。沙箱升档审批在 `orig.execute` **之内**，原样保留——插件从不自己 spawn 命令。补在这道缝前面的三样减法由插件负责：信息损失拒绝表（`git diff` / `git log` / `git show <ref>` / `ls` / `find` / `grep` / `rg` / `cargo clippy` / `aws`）、P1~P4 改写校验（只允许剥前缀、不许丢脚本运行词）、以及 vitest 主版本门控。危险命令（`rm -rf`、`git push --force`）根本不在 rtk 的改写面里，因此原样执行、原样受审——danger-guard 没有被绕过。
- **复合命令里任意一段命中拒绝表，整条都原样执行。** 拒绝表（`git diff` / `git log` / `ls` / `find` / `grep` / `rg` / `cargo clippy` / `aws` 等）与 vitest 主版本门控都按**段**判，因为 `cd x && git diff` 的首词是 `cd`——按整条判会让整张表失效。但命中之后不拆开执行：用户敲 `cd X && git status` 时预期是一次完整执行，替他把前半段交出去、后半段自己拼不是插件该做的事。
- **`rtk pipe` 处理失败的 pytest 时保住用例名，但不一定保住断言正文。** 护栏检查「有没有成功声明」与「失败行还在不在」；一个两者都过、却仍然丢了细节的 filter 输出，是 filter 的已知边界，不是护栏的。

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install --ignore-scripts
pnpm run check          # typecheck + lint + build + test + fmt:check
```

在伞工作区里跑 `pnpm run smoke @jayyuen66/dsh-rtk` 会把包装进沙箱 `DSH_HOME`；被接受的判据是 `--dump-config` 的层行。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可证

本插件 MIT。rtk 的命令行与命令过滤器是本插件使用的部分，为 Apache-2.0；见 `THIRD_PARTY_NOTICES.md`。
