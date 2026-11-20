# dsh-rtk

Compresses command output with [rtk](https://github.com/rtk-ai/rtk) before it reaches the model.

## What the card changes

Two shapes. Until `enabled` is set explicitly, it is on only when a supported rtk is detected; `prefix` is the default form and `pipe` is opt-in:

- **prefix** — the plugin shadows `bash` for each agent and runs the command through `rtk rewrite`
  first. When rtk knows a rewriting for that command, the rewritten form runs instead; otherwise the
  original command runs untouched. The card keeps showing the command you asked for.
  The rewritten command is what actually runs, so rtk's own `history.db` records it, not the command
  you asked for. `enabledForms` is read on every call, so toggling this layer takes effect on the
  next tool call. The layer assembles on macOS, Linux and Windows; on Windows `rtk` is resolved as
  `rtk.exe` / `rtk.cmd` through the standard `PATH` search.
- **pipe** — after a `bash`/`pwsh` call finishes, the plugin feeds the captured stdout through
  `rtk pipe -f <filter>` and replaces only the model-facing text. The exit code, the markers and the
  card projection stay exactly as the shell tool produced them.

Compound commands (`cd <repo> && cargo test`) are handled **segment by segment**: rtk itself rewrites
per segment (`cd /tmp && cargo test` → `cd /tmp && rtk cargo test`), so the plugin splits both the
original command and the product, requires the separator sequence to match one for one, and verifies
each segment on its own. Constructs that cannot be split (command substitution, redirection,
background `&`, unbalanced quotes, shell comments, a trailing lone `\`) run the whole command
unchanged. A segment that fails the gate is
put back verbatim while the rest still gets rewritten: `cd x && aws s3 ls && cargo test` becomes
`cd x && aws s3 ls && rtk cargo test`. The gate holds one entry only — `aws`, where rewriting changes
the exit code (127 natively vs 1 through rtk when the CLI is missing); "the output would get shorter"
is not a reason to refuse a rewrite.

Nothing is compressed unless it is measurably worth it: outputs below `minBytes` (256) and rewrites
that save less than `minGainRatio` (0.95) are passed through unchanged. Failures always keep their
assertion text — the guard rejects any compression that drops the failing line.

Log-shaped output gets a window of its own. `cat <log file>` (`.log`/`.out`/`.err`/`.jsonl`/`.ndjson`/
`.trace`/`.dump`), `tail`, `head`, `journalctl`, `dmesg`, `docker logs`, `kubectl logs` and `ps` keep the
first `windowHeadLines` (50) and the last `windowTailLines` (200) lines; the middle collapses to one
`[+N lines omitted]` marker. Source files and prose are never touched: `cat src/app.ts`,
`head -1000 lib/guard.ts` and `cat notes.txt` pass through whole — `.txt` is deliberately *not* a log
extension, because the real ledger's `.txt` rows are coverage reports and drafts, i.e. material meant to
be read word for word. The predicate is judged **per segment**, not by the first word of the whole
command: `cd /repo && cat build.log` is windowed (its last segment is a log) while
`cd /repo && cat src/app.ts` is left alone (its last segment is prose); shapes that cannot be split
(`$(...)`, real redirection, a trailing `&`, a shell comment) fall back to being judged as one
command. That matters
more than it sounds: before the split, a `cd` prefix made both predicates answer false, so a 900-line
build log went through untouched (55,213 B) and a source file with 200 identical lines got folded to
`[x200]` (8,044 B → 360 B) — reading material, mangled, which is the one thing this rule exists to
prevent. The defaults match rtk's own `cap` method (50/200), because the same question —
how much of a log is worth reading — was already answered there. The omitted stretch goes to spill like
any other compressed output, and the first body line names the path to it.

One handoff needs a word of its own: prefix rewriting turns `cat build.log` into `rtk read build.log`,
and `rtk read`'s `--level` defaults to `none` — measured, 22,390 B in and 22,390 B out, nothing
compressed at all. So "this command was rewritten" does not mean "this output is already compressed":
the plugin only stands down when the rewrite actually carries windowing flags, and otherwise still
windows the result.

The number inside `FAILURES (31):` is explained too: rtk counts **output lines**, not failing tests
(a 15-failure run prints 31). The plugin does not rewrite a number it has not verified; it adds one
line under the header saying what the count means, how many failing blocks the input really has, and
whether any were folded away.

The filter table has its own per-segment semantics too: it skips only leading segments that write nothing to stdout — `cd` / `export` / `set` / `unset` / `true` / `:`. The reason is that the filter receives the **stdout of the whole compound command**, and anything that writes into that same stream before the target makes parsing it as libtest (or pytest) output a real defect. So `cd /repo && cargo test` now matches (a bare `cd` used to keep the entire command out of the table — on a real ledger 257 `cd`-family pipe rows in one day, 444,666 B, reached the pipe layer with nothing claiming them), while `ls -la && cargo test` still does not. `pushd` / `popd` are deliberately not on the silent list: measured, they write the directory stack to stdout. Shapes that cannot be split (`$(...)`, real redirection, background `&`, a shell comment) fall back to being judged as one command, which fails closed.

Before the window is cut, output goes through rtk's own cleanup chain (the `ansi` / `progress` / `dedup`
steps of `rtk hook claude`): terminal colours are stripped, progress frames collapse into one line, and
runs of identical lines collapse into one line plus a count. That step also takes the long output nothing
else claims — `./build.sh`, `make`, and the like, which are neither in the filter table nor log targets.
The order is **clean, then window** (measured on a 792-line build log: window alone 10,366 B, clean then
window 9,228 B, the other way round 9,309 B). When the chain finds no gain rtk emits nothing at all and
the plugin passes the original through, so having it on does not mean it always compresses. The three
side effects are isolated under `$DSH_HOME/rtk/` rather than tolerated: the config (the `pipeline.toml`
this plugin generates), the ledger (a **separate** `hook.db`, so those rows never reach the statistics),
and `HOME` / `USERPROFILE` (plus `APPDATA` / `LOCALAPPDATA` on Windows). Without isolating them rtk
writes into the platform data directory, and one clean load **deletes** the user's own
`pipeline-status.json`; on Windows rtk resolves that directory through the Known Folder API, so the
redirect is best-effort there and not yet verified on a real machine.

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
buckets with savings fall back to bars — two points joined by a line cannot show a trend, only suggest
one. That fallback prints an explicit note of its own, because the rate is still quoted in the KPI row
and in the tables: without saying so, the bars-only chart reads as "the rate is missing".

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
- **The recall store is taken over too**: the same injected prefix carries `RTK_RECALL_DB` at
  `$DSH_HOME/rtk/recall.db`. That is where rtk keeps the middle of an output it folded, so the
  `[+N hidden: rtk recall <hash>]` pointers in a compressed line resolve inside dsh. Without the
  variable rtk writes that store into the global `recall.db` your own terminal uses — measured: a single
  `rtk ls -la` under a clean `HOME` creates the file and writes one row. The Insights footer reports how
  many entries it holds and how much disk it takes; "clear" does not touch it, because the pointers in
  earlier turns would stop resolving while what the button promises is to clear counters.
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

## What the model is told

Compression the model cannot reason about is a trap. Two registrations happen at load time.

A resident summary (`rtk-usage`, order 1565) is added to the system prompt. It carries the three
facts that change a decision: reading commands are never compressed, anything dropped is retrievable,
and `rtk bypass <cmd>` is the one clean way to keep a command verbatim.

The full rules — both layers, the exact never-touched predicate (`isReadingTarget`: a file-reading
command whose operands carry no log extension, so `cat notes.txt` and `head -1000 src/app.ts` pass
through untouched), the four retrieval markers, and where the data lives — are registered as the
virtual skill `rtk`. It appears in the skill catalog from the first step of every session; the model
loads it by name when it needs to judge whether an output is an excerpt. The body is not pushed into
the context by default.

`@deepseek-ai/dsh-skill` and `@deepseek-ai/dsh-system-prompt` are `devDependencies` only (host-provided
at runtime), so neither is a peer. `systemPrompt` is in the plugin's `inject` list because the summary
is required; `skills` is not — without that service only the loadable body is missing.

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

rtk ≥ 1.2.1 on `PATH`. Install it with:

```
brew install rtk        # macOS / Linux
winget install rtk-ai.rtk   # Windows
```

If rtk is missing the plugin stays loaded and every compression path fails open: commands run
normally, output comes through untouched, and the card tells you what to install.

Once a supported rtk is found, assembly also asks `rtk pipeline validate` about the `pipeline.toml`
it just wrote. rtk falls back to its built-in pipeline silently when that file has errors
(`rtk hook` still exits 0), so a rejection is surfaced as one warn line carrying the loader's
`E000` / `W025` diagnostics instead of leaving only a note in `pipeline-status.json`. The check
never blocks assembly and is skipped entirely when rtk is absent or below the floor.

## Further detail

- `docs/DETAIL.zh.md` — 中文版
- `README.md` / `README.zh-CN.md` — configuration table and design notes

## Feedback

Issues and pull requests are welcome: [https://github.com/JayYuen666/dsh-rtk/issues](https://github.com/JayYuen666/dsh-rtk/issues).

If a plugin fails to boot, include the dsh host version, the profile install shape, and the browser console line. The `missed the module table` line is especially useful: it tells us whether the shared client row was materialized.
