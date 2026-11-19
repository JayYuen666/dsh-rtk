# dsh-rtk

在命令输出进入模型之前，用 [rtk](https://github.com/rtk-ai/rtk) 做语义压缩。

## 卡片改了什么

两种形态。`enabled` 未显式设置时，检测到受支持的 rtk 才默认开启；`prefix` 是默认形态，`pipe` 需要显式打开：

- **prefix** —— 插件按 agent 遮蔽 `bash`，先过一遍 `rtk rewrite`。rtk 认识这条命令的改写时跑改写后的
  形态，不认识就跑原命令。卡片上仍然显示你要的那条命令。真正跑的是改写后的那条命令（所以 rtk 自己的
  `history.db` 记的是它，不是你写的那条）。`enabledForms` 每次调用现读，所以切换形态在下一次工具
  调用就生效。这一层在 macOS、Linux、Windows 上都装配；Windows 上 `rtk` 按标准 `PATH` 搜索解析成
  `rtk.exe` / `rtk.cmd`。
- **pipe** —— `bash`/`pwsh` 调用结束后，插件把捕获到的 stdout 喂给 `rtk pipe -f <filter>`，只替换
  模型可见的那段文本。退出码、marker 与卡片投影保持 shell 工具产出的原样。

复合命令（`cd <仓库> && cargo test`）会被**逐段**处理：rtk 自己就逐段改写（`cd /tmp && cargo test` →
`cd /tmp && rtk cargo test`），插件把原命令与产物各拆成若干段，要求分隔符序列逐一相同、且每一段各自
通过校验。拆不开的构造（命令替换、重定向、后台 `&`、引号不配对）整条原样执行。过不了闸门的那一段会被
**原样放回**，其余段照样改写：`cd x && aws s3 ls && cargo test` → `cd x && aws s3 ls && rtk cargo test`。
闸门只剩一条——`aws`，因为改写会让退出码变含义（命令不存在时原生 127、经 rtk 是 1）；「输出会变短」
不再是拒绝改写的理由。

不是所有输出都会被压：小于 `minBytes`（256）的输出、以及压缩率不足 `minGainRatio`（0.95）的改写，
一律原样放行。失败用例永远保住断言原文——护栏会拒绝掉任何丢掉失败行的压缩。

日志类输出另开一扇窗。`cat 日志文件`（`.log`/`.out`/`.err`/`.jsonl`/`.ndjson`/`.trace`/`.dump`）、
`tail`、`head`、`journalctl`、`dmesg`、`docker logs`、`kubectl logs`、`ps` 只留头 `windowHeadLines`（50）行
与尾 `windowTailLines`（200）行，中段折成一行 `[+N lines omitted]` 标记。源码与正文一律不动：
`cat src/app.ts`、`head -1000 lib/guard.ts`、`cat notes.txt` 整份放行——`.txt` 故意不在日志扩展名里，
真实账本那些 `.txt` 是覆盖率报告与草稿，属于要逐字读的材料。默认值与 rtk 自己的 `cap` method 同值
（50/200）——「一份日志里有多少值得看」这个问题它已经回答过一遍。省掉的那段和其它压缩产物一样落进
spill，正文首行写出取回路径。

有一处让路要单独说：前缀层把 `cat build.log` 改写成 `rtk read build.log`，而 `rtk read` 的 `--level`
默认 `none`——实测 22,390 B 进、22,390 B 出，一个字节都没压。所以「这条命令已被改写过」不等于
「输出已经被压过」：本包只在改写确实带切窗参数时才让路，否则照样走窗口。

切窗之前还会先过一遍 rtk 自己的清理链（`rtk hook claude` 的 ansi / progress / dedup 三步）：清掉终端
颜色、把进度条折成一行、把连续相同的行折成一行加一个计数。这一步同时接管「谁都没认领的长输出」——
`./build.sh`、`make` 这类既不在 filter 表里、也不是日志目标的命令。次序是**先清理再切窗**（实测
792 行构建日志：只切窗 10,366 B，先清理再切窗 9,228 B，反过来 9,309 B）。链判断无收益时 rtk 一个字
都不发，插件照原样放行——所以它开着不等于它一定压。三处副作用都被隔离到 `$DSH_HOME/rtk/` 之下：
配置（本包生成的 `pipeline.toml`）、账本（单独一个 `hook.db`，不混进统计）、以及 `HOME` /
`USERPROFILE`（Windows 上还有 `APPDATA` / `LOCALAPPDATA`）。不隔离的话 rtk 会写平台数据目录，一次
干净加载会删掉用户自己那份 `pipeline-status.json`；Windows 上 rtk 走 Known Folder API 解析该目录，
这几个变量可能不被读取，隔离只能尽力而为，尚未在 Windows 真机验证。

`FAILURES (31):` 里那个数也要说清楚：rtk 数的是**输出行数**而不是失败测试数（15 个失败会印成 31）。
插件不改它的数字，只在题头下补一句对账——这个数怎么算的、这次真的有几次失败、下面有没有折叠没展开。

统计按形态**分开看，不合并**：prefix 报「改写了几条命令、省下多少 token」，pipe 报「压了几次结果、
省下多少」。两者贴的不是同一件事，一个节省率盖住两种也就不再说明任何问题。

设置卡留配置，顶部给一行今日摘要加两柱图（今日改写 / 结果压缩各省多少 token）。完整读数在**左侧栏
的 rtk 页**：切形态、7 / 30 / 90 天窗口、日 / 周 / 月粒度；KPI 行（调用、尝试、成功、覆盖率或成功率、
节省 token、节省率）；组合图（柱=节省 token，折线=节省率或覆盖率，双轴）；「为什么这次没压」最近一条
与窗口内的原因 Top；明细表（prefix 按被改写的那几段折出的命令家族与工作目录，pipe 按 filter、命令家族与工作目录）；
建议区（低收益 filter、已启用却从没命中、没启用但明显可压、低收益命令家族）；以及数据说明
（起始日，以及读不到账本时的具体原因）。有节省的桶不足三个就退回柱状图——用两根点连一条线画不出
趋势，只是让人误以为有趋势。退柱时页面上会另起一行把这件事说清：比率没有丢，它在上面 KPI 行与
下面的明细表里；不写这一句，只画柱子的图会被读成「比率没画出来」。

图表用 [Apache ECharts](https://echarts.apache.org/) 6.1 按需加载：它不在入口 bundle 里，只有真的
打开这一页才下载那份五十多万字节的图表代码（包内 chunk `client.insights-echarts.js`，宿主按
`require.async` 拉）。设置卡那两柱图与它共用同一份。许可与版权声明见 `THIRD_PARTY_NOTICES.md`。

## 数据与隐私

一套数据，**只记 dsh 会话里发生的事**：

- **账本在 dsh 自己的目录下**：`$DSH_HOME/rtk/history.db`（默认 `~/.dsh/rtk/history.db`；`$DSH_HOME`
  按宿主同一档解析，走官方 `dsh-home-paths`）。插件给改写后的每段 `rtk` 注入 `RTK_DB_PATH` 指向它，
  rtk 因此只往这里记账——**你在自己终端里跑的 rtk 与 `rtk gain` 不受影响，也不计入这里**。
  这么切的理由是一次真机读数：两处混在一屏时出现过「改写成功 0 次、却省了 1.7M token」的自相矛盾。
- **取回库也一并接管**：同一段注入前缀还带 `RTK_RECALL_DB`，指向 `$DSH_HOME/rtk/recall.db`。rtk 折叠
  长输出时把被省掉的中段存在那里，于是压缩行尾那串 `[+N hidden: rtk recall <hash>]` 在 dsh 自己的库
  里解析得到。不给这个变量，rtk 会写进你终端在用的全局 `recall.db`——实测干净 `HOME` 下跑一次
  `rtk ls -la` 就会建出该文件并写一行。洞察页脚会报出这个库存了多少条、占多少磁盘；「清零」
  **不动它**：清掉它等于让历史轮次里的取回指针全部失效，而那个按钮承诺的是清计数。
- **pipe 的压缩计数与两侧明细记在同一个库的 `dsh_*` 表里**（SQLite，`node:sqlite`；打不开就只丢统计，
  压缩照常）。rtk 不认这些表、也从不会删它们。保留 90 天，没有 lifetime 累计。

隐私边界：插件的 `dsh_*` 表与页面上**不存完整命令、参数或输出**——只留命令家族（`cargo test`、
`git status` 这种模板级名字）、工作目录、filter 名、原因与计数。账本里 rtk 那几张表存着 `original_cmd`
原文，插件只读它、并且只展示它的命令家族，不把原文回显到页面或统计里。

沙箱三档：`read-only` 下 prefix 的节省量读不到（账本写不进去，页面如实报「只读」，而改写计数照常可见），
pipe 统计照常；`workspace-write` 下插件把 `$DSH_HOME/rtk/` 登记成会话级可写根（登记走物理路径，
`/tmp` 这类符号链接也落得上），两面都正常；`danger-full-access` 没有额外限制。

「清零」要过一次**二次确认**，清的是 dsh 账本的两侧：rtk 的五张表（`commands` 等，删法与
`rtk gain --reset` 同口径）与插件自己的 `dsh_*` 表。清的是 `$DSH_HOME/rtk/history.db` 这一个文件——
**你的全局 `rtk gain` 历史不受影响**，弹窗里的勾选框就是把这件事说明白。旧的单份累计账本
（宿主 storage domain 里的 `rtk_stats`）在第一次打开时**一次性**迁成快照，此后不再累加。

## 模型看到什么说明

压了却不告诉模型，就是给它下套。装载时注册两样东西。

一段常驻摘要（`rtk-usage`，order 1565）进 system prompt，只带三条会改变判断的事实：读文件的命令
从不被压、被压掉的都取回得到、`rtk bypass <cmd>` 是唯一干净的保留写法。

口径全文——两档压缩、确切的不碰判据（`isReadingTarget`：读文件的命令且操作数不带日志扩展名，
所以 `cat notes.txt` 与 `head -1000 src/app.ts` 一律原样交出）、四行取回标记、数据落在哪——注册成
虚拟 skill `rtk`。它从会话第一步就出现在 skill 目录里，模型要判断「这份输出是不是残件」时按名加载。
正文不会默认进上下文。

`@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-system-prompt` 只进 `devDependencies`（运行期由宿主
提供），因此都不进 peer。`systemPrompt` 在 `inject` 里是因为摘要段必需；`skills` 不在——那个服务缺席时
少的只是可加载的正文。

## 只在装配时读一次的取值

下面这些在装配时读一次，改完要重启宿主才生效：

| 键 | 默认值 |
| --- | --- |
| `pipeTimeoutMs` | `3000` |
| `logFilterMode` | `'off'` |
| `rewriteCacheSize` | `256` |
| `rewriteTimeoutMs` | `2000` |
| `vitestMaxMajor` | `5`（只影响命令改写） |

## 它需要外部有什么

`PATH` 上有 rtk ≥ 1.0.0。安装：

```
brew install rtk            # macOS / Linux
winget install rtk-ai.rtk   # Windows
```

rtk 不在时插件照常装载，所有压缩路径都 fail-open：命令正常跑、输出原样返回、卡片告诉你该装什么。

## 更多

- `docs/DETAIL.md` — English
- `README.md` / `README.zh-CN.md` — 配置表与设计说明

## 反馈

欢迎提 issue 和 PR：[https://github.com/JayYuen666/dsh-rtk/issues](https://github.com/JayYuen666/dsh-rtk/issues)。

插件启动失败时，请附上 dsh 宿主版本、profile 安装形态和浏览器控制台原文。`missed the module table` 这一行尤其有用：它能直接说明 shared 客户端供应行有没有被物化。
