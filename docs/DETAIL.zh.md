# dsh-rtk

在命令输出进入模型之前，用 [rtk](https://github.com/rtk-ai/rtk) 做语义压缩。

## 卡片改了什么

两种形态，都默认关闭（`enabled: false`）：

- **prefix** —— 插件按 agent 遮蔽 `bash`，先过一遍 `rtk rewrite`。rtk 认识这条命令的改写时跑改写后的
  形态，不认识就跑原命令。卡片上仍然显示你要的那条命令。两个值得知道的后果：真正跑的是改写后的
  那条命令（所以 rtk 自己的 `history.db` 记的是它，不是你写的那条），以及 `enabledForms` 在装配期
  读一次 —— 开关这一层要重启。
- **pipe** —— `bash`/`pwsh` 调用结束后，插件把捕获到的 stdout 喂给 `rtk pipe -f <filter>`，只替换
  模型可见的那段文本。退出码、marker 与卡片投影保持 shell 工具产出的原样。

不是所有输出都会被压：小于 `minBytes`（256）的输出、以及压缩率不足 `minGainRatio`（0.95）的改写，
一律原样放行。失败用例永远保住断言原文——护栏会拒绝掉任何丢掉失败行的压缩。

## 只在装配时读一次的取值

下面这些在装配时读一次，改完要重启宿主才生效：

| 键 | 默认值 |
| --- | --- |
| `enabledForms` | `['prefix']` | 装配期读一次：卡片能写，但改完要重启 |
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
