<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-rtk@main/icon.svg" width="96" height="96" alt="dsh-rtk logo" />
</p>

<h1 align="center">dsh-rtk</h1>

<p align="center"><em>Compresses bash/pwsh output with the local rtk CLI before it reaches the model: a rewritten command prefix, a post-execute pipe fallback, and a settings card that reports what it saved.</em></p>

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
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-简体中文-658EFF?style=flat-square" alt="简体中文" /></a>
</p>

---

**A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that puts the local `rtk` binary between a shell tool and the model. rtk itself stays on your machine; the plugin only orchestrates it.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [ What it does](#-what-it-does)
- [ Install](#-install)
- [ Verify it is live](#-verify-it-is-live)
- [ What it does not provide](#-what-it-does-not-provide)
- [ Enabling it in dsh](#-enabling-it-in-dsh)
- [ The two shapes](#-the-two-shapes)
- [ Settings](#-settings)
- [ Insights](#-insights)
- [ Support surface](#-support-surface)
- [ External dependency](#-external-dependency)
- [ Data and privacy](#-data-and-privacy)
- [ Known boundaries](#-known-boundaries)
- [ Development](#-development)
- [ Feedback](#feedback)
- [ License](#-license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **Two compression shapes; the master switch follows rtk readiness.** `prefix` shadows `bash` per agent and routes the command through `rtk rewrite` first; `pipe` feeds a finished shell result through `rtk pipe -f <filter>` and replaces only the model-facing text. Until you set `enabled` explicitly, it is on only when a supported rtk is detected; `prefix` is the default form and `pipe` is opt-in.
- **Nothing is compressed that is not worth it.** Outputs under `minBytes` (256) and rewrites that save less than `minGainRatio` (0.95) pass through unchanged. The plugin never claims a saving it did not make.
- **Failures keep their text.** The guard rejects any compression that loses the failing assertion, the file:line, or the exit marker — a compressed failure that hides why it failed is worse than no compression.
- **The failure count is labelled.** rtk's `FAILURES (31):` counts **output lines**, not failing tests — a 15-failure run prints 31. Rather than rewrite a number it has not verified, the plugin adds one line under the header: what the count means, how many failing blocks the input really has, and whether any were folded away.
- **Fail-open everywhere.** rtk missing, rtk too old, a rewrite that rewrites destructively, a command that is not safe to rewrite: the original command runs, the original output is delivered, and nothing is lost.
- **Compound commands are rewritten segment by segment.** `cd <repo> && cargo test` — the shape multi-repo work produces constantly — is split into segments and only the one carrying the output is rewritten (`cd <repo> && rtk cargo test`). Constructs that cannot be split (command substitution, redirection, background `&`, unbalanced quotes) still run unchanged as a whole.
- **A settings card and an insights page.** The card keeps the configuration and adds one line of today's summary (per shape) plus a two-bar chart; the full readout lives on an rtk page in the left sidebar — browsable by shape, time window, command and working directory. The data plane is the official Typert Remote namespace; no new HTTP route.

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-rtk
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-rtk`. The package is on the public npm registry; no credentials, no scoped-registry line.

- **Node.js `>= 24.9`** (ESM-only; that floor is what makes `require()` of an ESM entry work, hence `engines.node`).
- **Host `dsh` at `0.2.2-rc.2` or later on the `0.2.x` line.** The host reads `engines.dsh` (`^0.2.2-rc.2`) and it **decides alone** — with that field present, compatibility is judged before `peerDependencies` is ever consulted, prereleases included. Any `0.2.x` at or above `0.2.2-rc.2` passes the host gate; `0.2.2-rc.1` and anything older does not. Strict npm peer resolution likewise accepts nothing below `0.2.2-rc.2`, and on the prerelease side only the `0.2.2` tuple (`0.2.2-rc.2` onward) — a later minor's prerelease such as `0.2.3-rc.1` waits for its stable release. `0.3.0` and later need the risk grant `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`. The support window rolls: at publish time this package is checked against every released host version inside the window — the judgement is the host's `--dump-config` layer line for this package, while the settings card and its namespace calls are verified once in full on the release's development baseline — and re-verified once the window moves, so the version number in this bullet is not a standing promise.
- **No `@deepseek-ai/*` under `dependencies`, by contract** (`test/publish-manifest.test.ts`). Profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package there becomes a real second copy; `@deepseek-ai/dsh-tools` keys its scheduler with a plain `Symbol`, so **every native tool call throws** in that profile while build, typecheck and coverage stay green. The `@deepseek-ai/dsh*` peers carry the same support-window range (`^0.2.2-rc.2`), while the exact pins in `devDependencies` are the compile-time discipline against a second host type surface — not a claim the host consults.
- **`rtk >= 1.0.0` on `PATH`.** This is the one runtime dependency outside npm: `brew install rtk` on macOS/Linux, `winget install rtk-ai.rtk` on Windows. Without it the plugin still loads and every compression path fails open.
- **What ships**: `host.js`, `client.js`, the package-local on-demand chunk `client.insights-echarts.js`, `cordis.patch.yml`, `icon.svg`, both READMEs, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, `locale/zh.json` + `locale/en.json`, and `docs/` (both DETAIL files). Artifacts are rebuilt by `prepack`, never committed.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **The layer is mounted.** `dsh --profile web --dump-config` ends with `# == @jayyuen66/dsh-rtk` plus `- id: rtk`. That command is the only accepted signal and is **not read-only** — read layer lines from stdout **and** check stderr separately; accept both `# == <layer>` and `# == <layer>, patched by <path>`.
2. **rtk is found.** The card's readiness line names the binary it resolved and its version. `rtk not found` there means the host process's `PATH` differs from your shell's.
3. **A command is compressed.** With `enabled: true` and the card's counters at zero, ask the model to run a build or a test suite: the next card refresh shows the call and the byte delta.
4. **The card renders.** The settings page lists "rtk 输出压缩" (or its English title); toggling a value plus **Save** round-trips with a 200 and the dirty state clears.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **No HTTP route of its own.** The card's data plane is the official Typert Remote namespace through the host `/api` gateway; auth, Host/DNS-rebinding/Origin checks and body limits are all the gateway's.
- **No CLI subcommand.** `dsh rtk …` does not exist.
- **No rtk code bundled.** The plugin invokes the `rtk` command as a subprocess and consumes its stdout. rtk's Apache-2.0 surface is what it uses; nothing from the BUSL engine is linked or redistributed.
- **No rewriting of input arguments.** dsh deliberately forbids `tools/pre-execute` from rewriting a tool call's arguments (they are already logged and rendered). The `prefix` shape therefore works by shadowing `bash` per agent, not by mutating an existing call.
- Required surfaces: `settings` / `tools` / `subprocess` / `workingDirectory` (all in `inject`). `spillStore`, `sandboxPolicy` and `storageDomain` are read through `ctx.get()` and degrade gracefully when absent — `storageDomain` is only consulted once to migrate the old accumulator, so its absence merely costs a slice of historical counters.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- `dsh.bundle.patch` points at `cordis.patch.yml`, whose `insert:` block carries a `- id: dsh-plugin-shared` supplier row (keep it enabled; disabling it removes the cards' shared component supply) plus the `- id: rtk` entry with `name: "@jayyuen66/dsh-rtk"` — the **bare package name** is what makes the host scan the client half. The card components come from the shared client row, externalized as `@jayyuen66/dsh-plugin-shared/client`; the host module table provides `react`, `zod` and that shared row.
- A missing injected surface keeps cordis from activating the entry (startup diagnostic: `pending (waiting for service: …)`); a malformed ctx throws `required services … missing` from apply.
- Deployment defaults go on the registration line's `config:`; precedence is card runtime value > row config > schema `.default()`.
- **The master switch follows rtk readiness.** Until you set `enabled` explicitly, it stays off when rtk is missing or below the supported floor and turns on once a supported rtk is detected. `prefix` is the default form. Turn the switch off manually to pin it off, or on to pin it on; both the switch and the form selector take effect on the next tool call.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The two shapes

| | **prefix** | **pipe** |
| --- | --- | --- |
| When | before the command runs | after the shell result exists |
| How | shadow `bash` per agent, ask `rtk rewrite`, run the rewritten form | feed captured stdout through `rtk pipe -f <filter>` |
| What the model sees | the compressed output of the rewritten command | the compressed output, original markers and exit code preserved |
| Failure mode | rewrite rejected → original command runs | filter unusable → original text delivered |
| Compound commands | rewritten segment by segment: only the output-bearing segment changes | the whole command's output is compressed together |
| Default | on when `enabled` is on | off (waiting for rtk to cover more shapes) |

Compound handling under `prefix` deserves its own paragraph: rtk already rewrites segment by segment (`rewrite_compound` in `discover/registry.rs`), and `cd /tmp && cargo test` measurably becomes `cd /tmp && rtk cargo test`. The plugin splits both the original command and the product into segments, requires the **separator sequence to match one for one**, and runs P1–P4 on **each** segment (a segment that was not touched must be byte-identical; the touched one may only gain a leading `rtk `). Anything else is rejected and the original command runs.

## <img src="https://api.iconify.design/lucide/settings.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | unset | master switch; until set, on only when a supported rtk is detected |
| `enabledForms` | `['prefix']` | which shapes may act; takes effect on the next tool call |
| `denyCommands` | `[]` | extra command patterns never rewritten |
| `enabledFilters` | `['cargo-test','pytest','ctest']` | pipe filters that may act |
| `minBytes` | `256` | outputs smaller than this are never compressed |
| `minGainRatio` | `0.95` | a compression that keeps ≥95% of the bytes is discarded |
| `stdoutCapBytes` | `64000` | cap on what the filter returns: the compressed body is tail-truncated to this many bytes (the exit marker is kept) |
| `warnHint` | `true` | append the compile-warning hint after `cargo test` |
| `rewriteHostEnv` | `''` | value for `RTK_REWRITE_HOST`; empty leaves it unset |
| `pipeTimeoutMs` | `3000` | restart-only |
| `rewriteTimeoutMs` | `2000` | restart-only |
| `rewriteCacheSize` | `256` | restart-only |
| `vitestMaxMajor` | `5` | restart-only; vitest at or above this major is not compressed |
| `logFilterMode` | `'off'` | restart-only |

The config schema has 14 fields; 13 of them carry built-in defaults, while `enabled` follows rtk readiness until you set it explicitly. 9 of them volatile — the settings card writes those and they take effect on the next tool call, `enabledForms` included. The remaining **non-volatile deployment values**, 5 of them, are read once at assembly, so changing them needs a restart.

## <img src="https://api.iconify.design/lucide/chart-column.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Insights

The left sidebar gains an rtk page. **The two shapes are reported separately and never merged**: prefix reports how many commands were rewritten and how many tokens that saved; pipe reports how many outputs were compressed and how many tokens that saved. They are not the same quantity, and one blended savings rate would explain neither.

- **Tabs**: rewrite (prefix) / compression (pipe).
- **Window and granularity**: 7 / 30 / 90 days, day / week / month. Empty buckets inside the window are zero-filled, so the x-axis is a stable time axis rather than "the days that happened to have data".
- **KPI row**: calls, attempts, successes, coverage (pipe) or success rate (prefix), tokens saved, savings rate.
- **Combination chart**: bars are tokens saved per bucket, the line is the savings or coverage rate on a second axis. **Under three days it falls back to bars** — a line through two points is not a trend, it is a misreading.
- **Why this one was not compressed**: the latest event plus the top reasons in the window.
- **Detail tables**: prefix by command family and working directory, pipe by filter, command family and working directory.
- **Suggestions**: low-yield filters, enabled-but-never-hit filters, disabled-but-clearly-compressible filters, low-yield command families.
- **Data note**: the start date, and the concrete reason when a ledger cannot be read (read-only sandbox, missing database, unreadable file, unexpected shape).

Charts use [Apache ECharts](https://echarts.apache.org/) 6.1, **loaded on demand**: it is not in the entry bundle at all, and only opening this page downloads the half-megabyte charting code as a package-local chunk (`client.insights-echarts.js`, pulled by the host through `require.async`; switching tabs does not download it twice). The two-bar chart on the settings card shares the same chunk. License and copyright notices are in `THIRD_PARTY_NOTICES.md`.

## <img src="https://api.iconify.design/lucide/monitor.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Support surface

`engines.dsh` and the `@deepseek-ai/dsh*` peers are `^0.2.2-rc.2` (one line, no union); `@deepseek-ai/schemastery` peer is `^3.19.0`; `engines.node` is `>=24.9.0`.

## <img src="https://api.iconify.design/lucide/cpu.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> External dependency

rtk 1.2.0 was the version every claim in this repository was measured against. The plugin requires `>= 1.0.0`; below that it reports the version it found and does nothing.

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

- **Command text leaves the host process only as an argv to your own `rtk` binary.** No network call is made by this plugin.
- **One dataset, and only dsh sessions land in it.** The ledger lives in dsh's own directory: `$DSH_HOME/rtk/history.db` (default `~/.dsh/rtk/history.db`, with `$DSH_HOME` resolved the same way the host resolves it). The plugin prefixes every rewritten `rtk` segment with `RTK_DB_PATH` pointing at that file, so rtk books its rows there and nowhere else — **the rtk you run in your own terminal, and `rtk gain`, are neither affected nor counted here**. Pipe compression counters and the per-event detail of both shapes live in `dsh_*` tables in the same database (SQLite via `node:sqlite`; if it cannot be opened only the statistics are lost, compression is unaffected). rtk never reads those tables and never drops them; kept for 90 days, no lifetime total.
- **The plugin's own tables and the page never store full commands, arguments or output.** Only the command family (a template-level name like `cargo test` or `git status`), the working directory, the filter name, the reason and the counters. rtk's tables in that ledger do hold `original_cmd`; the plugin only reads it, and only ever shows its command family — the raw text never reaches the page or the statistics.
- **Tokens are estimated by the host's `tokenMeter`** (falling back to `bytes / 4` when the service is absent — the same density as rtk's own `estimate_tokens_from_len`). The pipe form measures both ends, so its saving is measured; what prefix saves is the book rtk keeps for "original vs rewritten command", which the plugin only reads rather than estimates itself.
- **The three sandbox modes differ.** Under `read-only` the prefix savings cannot be read (the ledger is not writable, so the page says so plainly while the rewrite counters stay visible) and pipe statistics keep working; under `workspace-write` the plugin registers `$DSH_HOME/rtk/` as a session-scoped writable root (through its physical path, so a symlinked `/tmp` still lands) and both faces work normally; `danger-full-access` adds no further restriction.
- **"Clear" sits behind a confirmation and empties both sides of dsh's ledger**: rtk's five tables (`commands` and its siblings, deleted the same way `rtk gain --reset` deletes them) plus the plugin's own `dsh_*` tables. Only `$DSH_HOME/rtk/history.db` is touched — **your global `rtk gain` history stays put**, which is exactly what the checkbox in the dialog says. The old single accumulator (the `rtk_stats` storage domain) is migrated once into a snapshot the first time it is opened, and never accumulates again.
- **Compressed originals can be spilled** into the host's spill area when they exceed the inline budget — the same mechanism every other host tool uses, with the same per-session partition.

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

- **`rtk rewrite` does not know whether a flag asks for more detail.** It rewrites `cargo test -- --nocapture` and `pytest -vv` just like the quiet form, and the detail is then compressed away. The plugin refuses to rewrite any command carrying a detail flag; when it does compress, the loss is bounded by the guard, not by rtk.
- **`npm run <script>` is never rewritten.** rtk maps a script name to a tool name (`npm run lint` → `rtk lint`), which would run ESLint instead of your script. The plugin drops any rewrite that removes a word from the original command.
- **Listing commands fold.** `ls`, `find`, `grep`/`rg` can replace a long listing with a `+N more` marker; the guard detects the marker family and rejects the compression, so folded listings never reach the model through this plugin.
- **Approvals see the command you asked for, not the rewritten one.** The shadow rewrites `args.command` inside `execute`, which runs *after* the pipeline's `tools/pre-execute` stage. General command approval (auto-review, danger-guard, Claude-Code-style hooks) therefore evaluates the frozen original arguments (`cargo test`) while the rewritten form (`rtk cargo test`) is what actually runs. Sandbox escalation approval is *inside* `orig.execute` and is preserved untouched, because the plugin never spawns the command itself. The plugin's own safety net in front of that gap is three subtractions — the information-loss deny table (`git diff` / `git log` / `git show <ref>` / `ls` / `find` / `grep` / `rg` / `cargo clippy` / `aws`), the P1–P4 rewrite checks (only a prefix may be stripped, no script-runner word may disappear), and the vitest major gate. Danger commands (`rm -rf`, `git push --force`) are not in rtk's rewrite surface at all, so they run unchanged and are reviewed unchanged — danger-guard is not bypassed.
- **If any segment of a compound command hits the deny list, the whole command runs unchanged.** The deny list (`git diff` / `git log` / `ls` / `find` / `grep` / `rg` / `cargo clippy` / `aws`, …) and the vitest major gate are evaluated **per segment**, because `cd x && git diff` starts with `cd` — evaluating the whole string would disable the entire table. On a hit the command is not taken apart either: someone typing `cd X && git status` expects one complete execution, and handing the first half to the shell while stitching the second half back is not the plugin's job.
- **`rtk pipe` on a failing pytest run keeps the failure names but not always the assertion body.** The guard checks for a success claim and for the failing line; a filter output that passes both but still loses detail is a known limit of the filter, not of the guard.

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install --ignore-scripts
pnpm run check          # typecheck + lint + build + test + fmt:check
```

`pnpm run smoke @jayyuen66/dsh-rtk` from the umbrella workspace mounts the package into a sandbox `DSH_HOME`; the accepted signal is the `--dump-config` layer line.

## Feedback

Issues and pull requests are welcome: [https://github.com/JayYuen666/dsh-rtk/issues](https://github.com/JayYuen666/dsh-rtk/issues).

If a plugin fails to boot, include the dsh host version, the profile install shape, and the browser console line. The `missed the module table` line is especially useful: it tells us whether the shared client row was materialized.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT for this plugin. rtk is Apache-2.0 for the CLI and command filters this plugin uses; see `THIRD_PARTY_NOTICES.md`.
