# dsh-rtk

在命令输出进入模型之前，用 [rtk](https://github.com/rtk-ai/rtk) 做语义压缩。

## 卡片改了什么

两种形态。`enabled` 未显式设置时，检测到受支持的 rtk 才默认开启；`prefix` 是默认形态，`pipe` 需要显式打开：

- **prefix** —— 插件按 agent 遮蔽 `bash`，先过一遍 `rtk rewrite`。rtk 认识这条命令的改写时跑改写后的
  形态，不认识就跑原命令。卡片上仍然显示你要的那条命令。真正跑的是改写后的那条命令（所以 rtk 自己的
  `history.db` 记的是它，不是你写的那条）。`enabledForms` 每次调用现读，所以切换形态在下一次工具
  调用就生效。
- **pipe** —— `bash`/`pwsh` 调用结束后，插件把捕获到的 stdout 喂给 `rtk pipe -f <filter>`，只替换
  模型可见的那段文本。退出码、marker 与卡片投影保持 shell 工具产出的原样。

复合命令（`cd <仓库> && cargo test`）会被**逐段**处理：rtk 自己就逐段改写（`cd /tmp && cargo test` →
`cd /tmp && rtk cargo test`），插件把原命令与产物各拆成若干段，要求分隔符序列逐一相同、且每一段各自
通过校验。拆不开的构造（命令替换、重定向、后台 `&`、引号不配对）与「任意一段命中拒绝表」这两种情况
整条原样执行。

不是所有输出都会被压：小于 `minBytes`（256）的输出、以及压缩率不足 `minGainRatio`（0.95）的改写，
一律原样放行。失败用例永远保住断言原文——护栏会拒绝掉任何丢掉失败行的压缩。

统计区是数字加一张按 filter 的 token 收益条形图（纯 `div` 与内联 CSS，不引第三方图表库）。每个
filter 记的是它省下的 token；表里的占比是「这条 filter 在这些省下的 token 里占多少」，不是它自己的
压缩率——账本里没有记每个 filter 处理过多少原文。

## 只在装配时读一次的取值

下面这些在装配时读一次，改完要重启宿主才生效：

| 键 | 默认值 |
| --- | --- |
| `pipeTimeoutMs` | `3000` |
| `logFilterMode` | `'off'` |
| `rewriteCacheSize` | `256` |
| `rewriteTimeoutMs` | `2000` |
| `vitestMaxMajor` | `5` |

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
