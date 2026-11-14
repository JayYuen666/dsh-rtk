# dsh-rtk

Compresses command output with [rtk](https://github.com/rtk-ai/rtk) before it reaches the model.

## What the card changes

Two shapes, both off by default (`enabled: false`):

- **prefix** — the plugin shadows `bash` for each agent and runs the command through `rtk rewrite`
  first. When rtk knows a rewriting for that command, the rewritten form runs instead; otherwise the
  original command runs untouched. The card keeps showing the command you asked for.
  Two consequences worth knowing: the rewritten command is what actually runs (so rtk's own
  `history.db` records it, not the command you asked for), and `enabledForms` is read at
  assembly — turning this layer on or off needs a restart.
- **pipe** — after a `bash`/`pwsh` call finishes, the plugin feeds the captured stdout through
  `rtk pipe -f <filter>` and replaces only the model-facing text. The exit code, the markers and the
  card projection stay exactly as the shell tool produced them.

Nothing is compressed unless it is measurably worth it: outputs below `minBytes` (256) and rewrites
that save less than `minGainRatio` (0.95) are passed through unchanged. Failures always keep their
assertion text — the guard rejects any compression that drops the failing line.

## Restart-only values

These are read once at assembly and need a host restart to take effect:

| Key | Default |
| --- | --- |
| `enabledForms` | `['prefix']` | read at assembly; the card writes it but a change needs a restart |
| `pipeTimeoutMs` | `3000` |
| `logFilterMode` | `'off'` |
| `rewriteCacheSize` | `256` |
| `rewriteTimeoutMs` | `2000` |
| `vitestMaxMajor` | `5` |

## What it needs from outside

rtk ≥ 1.0.0 on `PATH`. Install it with:

```
brew install rtk        # macOS / Linux
winget install rtk-ai.rtk   # Windows
```

If rtk is missing the plugin stays loaded and every compression path fails open: commands run
normally, output comes through untouched, and the card tells you what to install.

## Further detail

- `docs/DETAIL.zh.md` — 中文版
- `README.md` / `README.zh-CN.md` — configuration table and design notes
