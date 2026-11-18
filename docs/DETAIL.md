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
background `&`, unbalanced quotes) run the whole command unchanged. A segment that fails the gate is
put back verbatim while the rest still gets rewritten: `cd x && aws s3 ls && cargo test` becomes
`cd x && aws s3 ls && rtk cargo test`. The gate holds one entry only — `aws`, where rewriting changes
the exit code (127 natively vs 1 through rtk when the CLI is missing); "the output would get shorter"
is not a reason to refuse a rewrite.

Nothing is compressed unless it is measurably worth it: outputs below `minBytes` (256) and rewrites
that save less than `minGainRatio` (0.95) are passed through unchanged. Failures always keep their
assertion text — the guard rejects any compression that drops the failing line.

The number inside `FAILURES (31):` is explained too: rtk counts **output lines**, not failing tests
(a 15-failure run prints 31). The plugin does not rewrite a number it has not verified; it adds one
line under the header saying what the count means, how many failing blocks the input really has, and
whether any were folded away.

Statistics are reported **per shape and never merged**: prefix reports how many commands were rewritten
and how many tokens that saved; pipe reports how many outputs were compressed and how many tokens that
saved. They are not the same quantity, and one blended savings rate would explain neither.

The settings card keeps the configuration and shows one line of today's summary plus a two-bar chart
(today's rewrite savings vs compression savings). The full readout lives on the **rtk page in the left
sidebar**: form switch, 7 / 30 / 90-day window, day / week / month granularity; a KPI row (calls,
attempts, successes, coverage or success rate, tokens saved, savings rate); a combination chart (bars =
tokens saved, line = savings or coverage, dual axis); "why this one was not compressed" for the latest
event plus the top reasons in the window; detail tables (prefix by the families of the segments that
were actually rewritten, plus working directory; pipe by filter, command family and working directory);
suggestions (low-yield filters,
enabled-but-never-hit filters, disabled-but-clearly-compressible filters, low-yield command families);
and a data note (start date, plus the concrete reason when a ledger cannot be read). Fewer than three
days of data falls back to bars — two points joined by a line cannot show a trend, only suggest one.

Charts use [Apache ECharts](https://echarts.apache.org/) 6.1, loaded on demand: it is not in the entry
bundle at all, and only opening that page downloads the half-megabyte charting code as a package-local
chunk (`client.insights-echarts.js`, pulled by the host through `require.async`). The two-bar chart on
the settings card shares the same chunk. License and copyright notices are in `THIRD_PARTY_NOTICES.md`.

## Data and privacy

One dataset, and **only what happens inside dsh sessions lands in it**:

- **The ledger lives in dsh's own directory**: `$DSH_HOME/rtk/history.db` (default
  `~/.dsh/rtk/history.db`; `$DSH_HOME` is resolved the same way the host resolves it, through the
  official `dsh-home-paths`). The plugin prefixes every rewritten `rtk` segment with `RTK_DB_PATH`
  pointing there, so rtk books its rows there and nowhere else — **the rtk you run in your own terminal,
  and `rtk gain`, are neither affected nor counted here**. The reason for that cut is one on-device
  reading: with both sources in one view, the page once showed "0 rewrites succeeded, 1.7M tokens
  saved", which contradicts itself.
- **Pipe compression counters and the per-event detail of both shapes live in `dsh_*` tables inside the
  same database** (SQLite via `node:sqlite`; if it cannot be opened only the statistics are lost,
  compression is unaffected). rtk never reads those tables and never drops them. Kept for 90 days, with
  no lifetime total.

Privacy boundary: the plugin's `dsh_*` tables and the page **never store full commands, arguments or
output** — only the command family (a template-level name like `cargo test` or `git status`), the
working directory, the filter name, the reason and the counters. rtk's tables in that ledger do hold
`original_cmd`; the plugin only reads it, and only ever shows its command family, never the raw text.

Three sandbox modes: under `read-only` the prefix savings cannot be read (the ledger is not writable, so
the page says so plainly while the rewrite counters stay visible) and pipe statistics keep working;
under `workspace-write` the plugin registers `$DSH_HOME/rtk/` as a session-scoped writable root
(through its physical path, so a symlinked `/tmp` still lands) and both faces work normally;
`danger-full-access` adds no further restriction.

"Clear" sits behind a **confirmation** and empties both sides of dsh's ledger: rtk's five tables
(`commands` and its siblings, deleted the same way `rtk gain --reset` deletes them) plus the plugin's
own `dsh_*` tables. Only `$DSH_HOME/rtk/history.db` is touched — **your global `rtk gain` history stays
put**, which is exactly what the checkbox in the dialog states. The old single accumulator (the
`rtk_stats` storage domain) is migrated **once** into a snapshot the first time it is opened, and never
accumulates again.

## Restart-only values

These are read once at assembly and need a host restart to take effect:

| Key | Default |
| --- | --- |
| `pipeTimeoutMs` | `3000` |
| `logFilterMode` | `'off'` |
| `rewriteCacheSize` | `256` |
| `rewriteTimeoutMs` | `2000` |
| `vitestMaxMajor` | `5` (command rewriting only) |

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
