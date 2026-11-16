# dsh-rtk

Compresses command output with [rtk](https://github.com/rtk-ai/rtk) before it reaches the model.

## What the card changes

Two shapes. Until `enabled` is set explicitly, it is on only when a supported rtk is detected; `prefix` is the default form and `pipe` is opt-in:

- **prefix** — the plugin shadows `bash` for each agent and runs the command through `rtk rewrite`
  first. When rtk knows a rewriting for that command, the rewritten form runs instead; otherwise the
  original command runs untouched. The card keeps showing the command you asked for.
  The rewritten command is what actually runs, so rtk's own `history.db` records it, not the command
  you asked for. `enabledForms` is read on every call, so toggling this layer takes effect on the
  next tool call.
- **pipe** — after a `bash`/`pwsh` call finishes, the plugin feeds the captured stdout through
  `rtk pipe -f <filter>` and replaces only the model-facing text. The exit code, the markers and the
  card projection stay exactly as the shell tool produced them.

Compound commands (`cd <repo> && cargo test`) are handled **segment by segment**: rtk itself rewrites
per segment (`cd /tmp && cargo test` → `cd /tmp && rtk cargo test`), so the plugin splits both the
original command and the product, requires the separator sequence to match one for one, and verifies
each segment on its own. Constructs that cannot be split (command substitution, redirection,
background `&`, unbalanced quotes) and the case where any segment hits the deny list both run the
whole command unchanged.

Nothing is compressed unless it is measurably worth it: outputs below `minBytes` (256) and rewrites
that save less than `minGainRatio` (0.95) are passed through unchanged. Failures always keep their
assertion text — the guard rejects any compression that drops the failing line.

The stats area is numbers plus a per-filter bar chart of token savings (plain `div`s and inline CSS,
no third-party chart library). Each filter records the tokens it saved; the share shown is "how much
of the tokens saved overall this filter accounts for", not that filter's own compression ratio —
the ledger does not record how much original text each filter saw.

## Restart-only values

These are read once at assembly and need a host restart to take effect:

| Key | Default |
| --- | --- |
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

## Feedback

Issues and pull requests are welcome: [https://github.com/JayYuen666/dsh-rtk/issues](https://github.com/JayYuen666/dsh-rtk/issues).

If a plugin fails to boot, include the dsh host version, the profile install shape, and the browser console line. The `missed the module table` line is especially useful: it tells us whether the shared client row was materialized.
