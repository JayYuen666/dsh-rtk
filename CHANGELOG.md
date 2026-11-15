# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

Feature and behavior update: compound command handling, per-filter token accounting with a bar
chart, and settings-card fixes. The master switch follows rtk readiness, the form selector is hot,
and the stats card refreshes while it is open.

### Added

- **Compound commands are rewritten segment by segment.** A command containing `&&`, `||`, `;`, `|`,
  or a newline used to be rejected outright, excluding the most common shape in multi-repo work
  (`cd <repo> && cargo test`). rtk rewrites per segment (`cd /tmp && cargo test` →
  `cd /tmp && rtk cargo test`), so `lib/prefix-safety.ts` exposes `splitCommand`; constructs that
  cannot be split (command substitution, redirection, background `&`, unbalanced quotes) and empty
  segments still run unchanged.
- **Rewrite verification and the deny table run per segment.** Both sides are split and the
  separator sequence must match one for one; each segment runs P1–P4 (an untouched segment must be
  byte-identical, a touched one may only gain a leading `rtk `). The information-loss deny table and
  the vitest major gate are evaluated per segment too, so `cd x && git diff` no longer disables the
  whole table. Any segment hitting a reason runs the whole command unchanged.
- **Per-filter token accounting and a bar chart.** `byFilter` records `savedTokens`; the projection
  gained `topFilters` and the card renders a per-filter bar chart with plain `div`s and inline CSS.
  Tokens come from the host `tokenMeter`, falling back to `bytes / 4` when that service is absent.
  The rewrite form still records command counts only; its original output never passes through the
  plugin, so its saving is only visible through `rtk gain`.
- **Settings are hot, and the master switch follows rtk readiness.** The prefix shadow and the
  post-execute listener are no longer gated by the enabled form; each call reads `forms`, `enabled`,
  and `supported` at the consumption point. Changing the form in the card takes effect on the next tool call — no
  host restart. `enabled` has no static schema default: until set explicitly, it is on only when a
  supported rtk is detected, and off when rtk is missing or below the floor. A manual toggle writes
  an explicit value that wins. `prefix` remains the default form and `pipe` is opt-in.
- **The stats card polls while open.** It refreshes `summary` and `status` every five seconds when
  the document is visible, skipping a tick while the previous refresh is still in flight.

### Fixed

- **The chart's per-filter share used the wrong denominator.** `summarize` divided each filter's
  saved tokens by total original tokens, so the percentages added up to the overall savings rate
  (38.34% in the live check) instead of 100%. The projection field is now `sharePct` and divides by
  total saved tokens; the row reads "占全部节省" and the chart explains that bar length is relative
  to the largest filter and the percentage is a share of all tokens saved.
- **An invalid number draft could survive a save.** `NumberField` keeps out-of-range input out of
  `onChange`, so the card's dirty set never saw it: saving another valid field cleared the dirty
  state and left the invalid draft plus its error in the field until a page reload. The card now
  tracks field validity, blocks saving while any number field is invalid, and resets drafts/errors
  after save or revert. `NumberField` gained the backward-compatible `onInvalidChange` and
  `resetToken` props for this.
- **Two settings hints stated the wrong scope.** The filter hint said filters only work in
  "rewrite + output compression", but pipe-only uses them too; it now names every form that includes
  output compression and lists all filter names from the pipe table instead of only the three
  defaults. The master-switch hint now depends on the selected form.
- **The form selector no longer needs a restart.** The old card showed the live configured value
  while the running host still used the assembly-time layers. The restart note is gone; the live
  value and the active behavior now agree.

## 0.1.0

First functional release. The plugin mounts, renders its settings card, and stays out of the way
until `enabled` is turned on.

### Added

- **Two compression shapes, both off by default.** `prefix` shadows `bash` per agent and routes the
  command through `rtk rewrite` before running the rewritten form; `pipe` listens on
  `tools/post-execute`, feeds the finished stdout through `rtk pipe -f <filter>`, and replaces only
  the model-facing text. The original command and its arguments are what the audit log and the UI
  show in both shapes.
- **An 18-row pipe filter table** covering cargo test, pytest, ctest, vitest, `pnpm`/`npm`/`yarn`
  test, go test, go build, tsc, mypy, ruff check, ruff format, git log, git diff, git status,
  grep/rg, and find/fd. Only `cargo-test`, `pytest` and `ctest` are enabled by default.
- **A nine-entry information-loss deny table** for the prefix shape (`git log`, `git diff`,
  `git show`, `ls`, `find`, `grep`, `rg`, `cargo clippy`, `aws`). Each entry records the measured
  loss that justifies it, and the table is a literal prefix match so a reader can audit it by eye.
- **Rewrite verification P1–P4** after `rtk rewrite`: the result must carry the `rtk ` prefix, the
  rest must be non-empty, the original command must end with that rest on a word boundary, and a
  script runner may not be stripped from the middle of the command.
- **A six-criterion compression guard** — empty output, low gain (measured in UTF-8 bytes against
  `minGainRatio`), fabricated success claims, lost commit hashes for VCS output, collapsed entries
  for listing output, and an unclassified filter — plus adjacent-duplicate collapsing for summary
  filters. A compressed failure that hides why it failed is rejected outright.
- **Marker and stderr fidelity.** The exit marker (`[exit code: N]`, `[killed by signal: X]`,
  `[timed out after Nms]`, `[stopped: …]`) and the `[stderr]` segment are split out before
  compression and reassembled after it, so the host's exit-status parser keeps working.
- **Original-output retention.** When a compressed result would still exceed the inline budget, the
  full original is saved through the host spill store and a retrieval hint rides along, so the
  model can read what was dropped instead of guessing.
- **Fail-open on every path.** rtk missing, rtk below `>= 1.0.0`, a rejected rewrite, an unsafe
  command, a filter that errors: the original command runs and the original output is delivered.
  Compounding commands, commands carrying explicit `--detail`-style flags, and commands already
  prefixed with `rtk` are skipped before any subprocess runs.
- **A per-agent shadow that inherits the host tool.** The shadow is a copy of the host's own `bash`
  definition with `execute` replaced, so sandboxing, background jobs, approval, and rendering stay
  the host's. The command is passed through unchanged to the original tool after the rewrite.
- **A compile-warning hint after `cargo test`.** When rtk's output no longer contains the `warning:`
  lines it dropped, a short hint is appended above the exit marker.
- **A settings card with a live data plane.** Per-filter counters, byte savings, the resolved rtk
  path and version, and the live `enabled`/`forms` state come from a host storage domain through the
  official Typert Remote namespace `rtkStats` (`summary`, `status`, `reset`). Auth and body limits
  are the host `/api` gateway's; the plugin opens no route of its own.
- **Fourteen configuration fields, nine of them volatile.** The card writes the volatile ones and
  they take effect on the next tool call; the five deployment values are read once at assembly.
- **A readiness line on the card.** When rtk is missing or below the floor, the card says which of
  the two it is and what to run (`brew install rtk` / `winget install rtk-ai.rtk`, or upgrade),
  rather than leaving the toggles looking effective.
- **Bilingual locale metadata, detail documents, and a support window of `^0.2.2-rc.2`.**
- **Windows is deliberately conservative**: the `prefix` shape is not assembled there, because rtk's
  Windows distribution and its `pwsh` command shapes have not been verified on a real machine.
  `pipe` works on every platform.

- **A first-level settings page.** `settings.section` registers `id: "rtk"` at `order: 31` (after the
  host's own account/general/models/plugins/agent-presets), and `settings.section.icon` carries the
  official rtk mark under the same id. The two ids must match character for character: an unmatched
  id renders no icon at all, and the symptom is a section that is there with the default gear beside
  it. `plugins.bundle.config` stays registered, so the plugin detail page and the settings page show
  the same card.
- **The official rtk mark as the navigation icon.** The logo ships as the project's own artwork
  (Apache-2.0, declared in `THIRD_PARTY_NOTICES.md`), inlined as a data URI and used as a CSS mask so
  the mark takes `currentColor` — a hardcoded colour would be a black blob in the dark theme. The
  card's context had no icon package to import: `@deepseek-ai/dsh-client-ui-primitives` is not in
  this package's dependency face and `build-client.mjs` externalises only the react family and zod.
  `icon.svg` carries the same artwork behind an SVG mask.

### Fixed

- **Volatile configuration was snapshotted at assembly.** `apply` runs once, so reading `enabled`,
  `denyCommands`, `warnHint`, `rewriteHostEnv`, `enabledFilters`, `minBytes`, `minGainRatio`, and
  `stdoutCapBytes` into closure-captured values made "the card saved it" and "the behavior changed"
  two unrelated events. All eight are now read at their consumption point.
- **The default path was broken.** The shadow installer returned early when `enabled` was false, and
  `enabled` defaults to false, so turning the master switch on in the card had no effect until a
  restart — the shape never got installed in the first place. `enabled` is now read in `execute`;
  assembly gates on the shape list, the platform, and rtk being on `PATH` only.
- **`findOnPath` accepted a directory.** A directory passes `X_OK` on POSIX, so a directory named
  `rtk` on `PATH` was taken for the binary. The consequences were silent: assembly believed rtk was
  installed, every rewrite failed with `EACCES` and failed open, and `status()` reported a fake path
  with `supported: null`, so the card warned about neither a missing nor an outdated rtk. A
  `statSync(...).isFile()` check now backs the access check.
- **A relative `workdir` from the model was joined with the wrong separator rules.** The host appends
  the model's relative path to the session cwd verbatim, without rewriting separators inside it; the
  plugin now matches that, which only showed up on Windows.
- **A late mount never shadowed agents that already existed.** The event listener alone missed them;
  live agents are now read from the agent registry at assembly, and a registry whose shape is not
  recognised degrades to the event listener instead of throwing.
- **The prefix shape silently did nothing in a preset-based profile.** The shadow looked up the
  `bash` tool with `ctx.tools.get("bash")`, and that call without a scope sees **only the global
  layer**. In the web profile, `bash` is registered by the **agent preset** instead (the global
  `tool-bash` row is disabled), so the lookup always came back `undefined`, the shadow was never
  installed, and nothing was logged. The symptoms were contradictory: `enabledForms: [prefix]`,
  the plugin active, the card writing settings — and every bare `git status` still printed the
  native output. The lookup now passes the agent (`ctx.tools.get("bash", agent)`), and a failed
  lookup logs one line so a shape that cannot install is never silent.
- **A version below the floor only stopped one layer.** Both now stop, and the check is a runtime
  gate in `execute`/`decide` rather than something only the settings card displayed.
