# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.6

宿主基线切到 `dsh 0.2.3-alpha.2`（Node `^24.22.3 || >=26.13.1`），shared 经 catalog 抬到 `^0.2.13`。设置卡随 shared v3 视觉层更新；Insights 按设计稿 v3 重排（860px 内容列、六格 KPI 与容器查询、ECharts 饼图与宿主语义色、粘性表头、页级/表内空态、`RtkPanelSection` 与侧栏 `RtkTrailing`）。测试入口改为子进程 `scripts/run-tests.mjs`，以 `NODE_OPTIONS=--disable-warning=ExperimentalWarning` 吸收 `node:sqlite` 的 Worker 警告；对账文案与判据同步。另按 rtk 1.2.1 复核了工具级前缀（`cargo +nightly test` / `git --no-pager log`）的真 CLI 回路，并把取回口径写清：`rtk recall <hash>` 默认只回被省略的中段，整份输出要加 `--full`。

## 0.2.5

宿主基线抬到 `0.2.2-rc.5`；客户端统计读取的测试替身换官方 RemoteMock。

### Changed

- **宿主依赖线抬到 `0.2.2-rc.5`**：devDependencies 全族精确钉 rc.5，`engines.dsh` 与 dsh 家族 peer 同一条窗口；shared 经 catalog 抬到 `^0.2.12`，`pnpm-lock.yaml` 经 `pnpm install --lockfile-only` 重解到 registry 现量；devDependencies 补 `react-dom`（`^19.3.0`，与 react 相邻）——shared 0.2.12 的 card-ui 经 `createPortal` 引 `react-dom`，客户端测试经 ESM 链解析到它（与 danger-guard / dir-prep / session-rescue 的既有供应同形）。
- **stats-reader 测试的命名空间替身换官方 `RemoteMock`**（`dsh-remote-mock` 由死依赖转为在用）：四个端点各挂一条 unary 规则、调用经 `mock.dispatch` 转发，实参透传与「无参方法一个实参都不传」改由 MockLog 断言，每组用例后跑 `assertNoUnmatched` 漏配断言；`get` / `$mount` 两位仍是手写替身——那两位测的是读取器自身的投影契约，官方 mock 不实现 `$mount`。
- **`lib/rtk-hook.ts` 的 `isFieldBag` / `fieldOf` 与 stats-reader 的 `RemoteHost` / `isRemoteMounter` 收编 shared**（逐字同构副本，改用 `./lib/record` 与 `./lib/typert-client` 的正主）。

## 0.2.4

Follows rtk 1.2.1. CI now installs 1.2.1 and the real CLI circuits run against it; the pipe
filter table covers rtk 1.2.1's whole `pipe -f` name set; tool-level flags no longer swallow the
subcommand in command-family statistics; the verify layer accepts a transparent wrapper before
`rtk`; the generated `pipeline.toml` is checked by rtk's own loader at assembly; and a ledger
written by a newer rtk schema reports its version instead of silently looking stale.

### Added

- **The pipe filter table covers every rtk 1.2.1 `pipe -f` name.** The 23 canonical names (`log`,
  `sqlfluff-lint`, `prettier`, `ecs`, `phpstan` and `pint` included) are all in the table, and rtk's
  four documented aliases are normalised when they appear in `enabledFilters` (`rg` → `grep`,
  `fd` → `find`, `paratest` / `php-test` → `pest`; the undocumented `cargo` alias is normalised too),
  so an entry written with an alias keeps matching. All 23 canonical names are classified for the
  output guard: `log` joins the listing class (recoverable folding), the five new linters join the
  lint class. The `prettier` row leans on the guard's fabricated-success rule: rtk prints "All
  files formatted correctly" for a run that reported violations, and that claim against the
  original warning lines is what rejects the compression.
- **The generated `pipeline.toml` is validated by rtk's own loader.** `rtk pipeline validate` runs
  once at assembly, after the version probe confirms a supported rtk, and a non-zero exit turns
  `E000` / `W025` diagnostics into one warn line. rtk otherwise falls back to `rtk:default`
  silently while `rtk hook` still exits 0, which reads exactly like "nothing to save". The check
  never blocks assembly, and it is not spawned when rtk is missing or too old.
- **A ledger written by a newer schema reports its version.** `readPrefixLedger` reads
  `PRAGMA user_version` and warns when it is above 3 (`Initial` / `EngineTables` /
  `InitialRecheck` in rtk 1.2.1); the data is still read, so a future additive migration degrades
  visibly rather than looking like an empty week.
- **The verify layer accepts a transparent wrapper before `rtk`.** `env FOO=1 rtk git status`,
  `command rtk cargo test`, `time rtk git log` and `nohup rtk …` now pass P1, and the ledger env
  injection finds `rtk` behind the same wrappers. `sudo`, `uv run`, `timeout`, `nice` and `xargs`
  are still rejected: those change the exit-code or output meaning the plugin reasons about.

### Fixed

- **Tool-level flags no longer swallow the subcommand in command-family statistics.** `cargo
  +nightly test`, `git -C /tmp log`, `git --no-pager log`, `pnpm --silent run build` and
  `docker --context prod ps` used to normalise to the bare tool name, so the Insights page could
  not tell them apart from `cargo` / `git` / a plain `pnpm` invocation. The family reader now skips
  value-taking global flags (a table per tool) and `+toolchain` tokens before reading the
  subcommand.
- **CI pins rtk 1.2.1 and the measured baseline moved with it.** README, the Chinese README, this
  changelog and the workflow all name 1.2.1; the plugin's lower bound moves to `>= 1.2.1` as well.

## 0.2.3

Compound commands stop being judged by their first word. The window and the reading-material
predicate now split the line and judge every segment, the pipe filter table skips only leading
segments that write nothing to stdout, and the splitter itself moved out of the module that needs
`node:fs` so the client bundle can share it.

### Fixed

- **Compound commands are judged per segment, so reading material stops being mangled.** Both
  predicates in `lib/output-window.ts` used to look only at the first word of the whole command,
  which made `cd /repo && cat build.log` answer "neither a log nor reading material" — a `cd` prefix
  was enough to slip past both compression paths. The cost ran in two directions. On logs it was a
  missed opportunity: a 900-line build log passed through untouched at 55,213 B, and on a real
  ledger 183 skipped `cd`-family calls in one day held 337,517 B while nothing compressed them
  (`rtk hook claude` returns zero bytes for an unduplicated 55 KB log, so only the local window can
  recover it). On reading material it was a correctness defect, which is worse: `cd /tmp && cat
  fresh2.ts` (203 lines, 8,044 B, 200 of them identical) fell into the cleanup chain instead, and
  `dedup` folded it to `[x200]` — the model received 360 B and a `[+N lines omitted]` header for a
  source file, which is exactly what "reading material is never touched" exists to prevent. Both
  predicates now split the command with `splitCommand` (the same splitter the rewrite layer uses)
  and judge each segment; a log segment wins over a reading segment, and shapes that cannot be split
  (`$(...)`, real redirection, a trailing `&`, a shell comment) fall back to being judged as one
  command.

- **The splitter's own boundaries were tightened: shell comments, fd target words, a trailing `\`.**
  Three shapes were being cut where bash sees something else. A word-initial `#` opens a shell
  comment, so `echo ok # note; more` runs only `echo ok` (measured) — the splitter used to cut
  ` more` out as a second command, which let the family and filter predicates reason about a command
  that never runs. An `>&` target counts as an fd copy only when the **whole word** is digits:
  `echo hi >&2log` really creates a file named `2log` and `2>&1x` reports an ambiguous redirect (both
  measured in bash), so checking only the first digit let a file-writing redirection through as a
  harmless dup — and the next segment would then read output that had already been compressed. A lone
  trailing `\` means the command is unfinished; the splitter used to advance past the end of the
  string and still report success, so the segment count it handed out was not the one bash sees. All
  three now return `undefined`, and every caller already reads `undefined` as "do not split, treat it
  as one command": `structuralReject` calls it `compound`, `verifyRewrite` calls it
  `not-segmentable`, `withRtkLedgerEnv` returns the command unchanged — none of them treat "cannot
  split" as "verified, safe to run". The `CommandSegment.sep` contract was wrong in prose only:
  `a && b` yields `sep: "&&"` with the spaces kept in `text`, not `sep: " && "`; rejoining was always
  lossless, so only the doc changed.

### Changed

- **The pipe filter table skips leading segments that write nothing to stdout.** `filterOf` used to
  match every table row against the whole command, and every row anchors on `^` — so `cd /repo &&
  cargo test`, the shape a model uses most often, could never match any row. On a real ledger 257
  `cd`-family pipe rows in one day (444,666 B) reached the pipe layer with nothing claiming them —
  all of them compound commands whose first word is `cd`. The table now skips a
  **silent-setup prefix** (`cd` / `export` / `set` / `unset` / `true` / `:`) and judges the first
  segment that actually produces output. The boundary is deliberate: the filter receives the stdout
  of the whole compound command, so anything that writes into that same stream before the target
  makes parsing it as libtest (or pytest) output a real defect — `ls -la && cargo test` therefore
  still does not match, and `pushd` / `popd` are not on the silent list because they write the
  directory stack to stdout (measured). A first segment that already matches keeps the old
  behaviour (`cargo test && echo hi` still compresses), and shapes that cannot be split fall back to
  being judged as one command.
- **The splitter moved to `lib/command-segments.ts`, which has no node imports.** With the table
  judging segments, `lib/command-filter.ts` needed `splitCommand`, and that module is in the client
  bundle (`src/client-entry.ts` imports it for the default filter set). Taking it from
  `lib/prefix-safety.ts` drags `node:fs` into `client.js` as an unregistered external — caught by
  the build's registered-externals gate, not by the compiler: `client.js` came back byte-identical
  afterwards, because the client only uses the table constants and the splitter is tree-shaken.

### Tests

- 1019 cases across 63 files, coverage at 100% on all four dimensions. New cases: the compound
  window predicate (log in the last segment, prose in the last segment, both present, unsplittable
  fallback, and the neither-path case, in `test/output-window.test.ts`), the filter table's
  per-segment semantics (`cd X && cargo test` and friends, consecutive silent segments, the
  `ls -la && cargo test` boundary, first-segment behaviour, unsplittable fallback, and the enabled
  set applying to compound commands, in `test/command-filter.test.ts`), and `test/command-segments.test.ts`
  (14 cases) which pins the splitter's own boundaries: shell comments, fd copy targets that are not
  a whole number, a lone trailing backslash, unbalanced quotes, and — separately, because one cannot
  stand in for the other — that `sep + text` rejoins the original command byte for byte. The
  integration hook that spawns real binaries also stopped riding on vitest's default 10s budget:
  `test/integration/real-data.test.ts` now declares its own hook timeout, probes the rtk version once
  per file instead of once per `describe`, and bounds the `cargo --version` probe, because two
  external spawns under one 10s hook turned into `Hook timed out in 10000ms` on the Windows runner
  with 63 concurrent workers — a test-only defect that reported nothing about the plugin.

## 0.2.2

The two shapes get the outputs rewriting cannot reach and `rtk pipe` has no filter for: log files and
directory listings, windowed in this plugin with the elided middle saved for retrieval. The Insights
footnote also learned to reconcile itself with `rtk gain`.

### Added

- **The `prefix` shape now assembles on Windows.** `installPrefixShadow` no longer rejects `win32`;
  the only assembly gate is `findOnPath("rtk")`, whose Windows candidates are `.exe` / `.cmd` / the
  bare name. This supersedes the conservative stance recorded in earlier versions. CI now installs
  rtk 1.2.0 on all three runners from the official release assets (sha256 checked) and runs the real
  CLI circuits with `DSH_RTK_TEST_MODE=real`; the fake-rtk fixtures are executable on POSIX and use
  `path.delimiter`, so those tests no longer depend on a machine-installed rtk.
- **Log output is windowed locally, and the cut middle stays retrievable.** `lib/output-window.ts`
  keeps the first 50 and last 200 lines of a long log and folds the middle into a single
  `[+N lines omitted]` marker; `host.ts` routes a command to this `window` mode when `isLogTarget`
  matches. The reason is that nothing else covers it: `rtk read` defaults to `--level none` and
  passes bytes through unchanged (`guard.ts` 14,947 B → 14,947 B), its `aggressive` level strips the
  `export` keyword off every declaration, and `rtk pipe` has no `cat` filter at all — while `cat` is
  the single largest command family in a real ledger (35.4% of input tokens). The marker shape is
  `[+N lines omitted]` on purpose: that is the family `GUARD_RULES`' `folded-entries` rule already
  recognises, so the window cannot silently become an unreported truncation — the guard rejects it,
  the original goes to the spill store, and the relaxed pass writes the retrieval path as the first
  line of the body. Scope is command × target: `cat src/app.ts` is untouched (source files are never
  windowed), and both line counts are card fields (`windowHeadLines` / `windowTailLines`, defaulting
  to the same 50/200 as rtk's own `cap` method).
- **`phpunit` and `pest` join the filter table.** `rtk pipe -f phpunit` keeps every failure fact
  (method name, assertion text, `FooTest.php:42`) while going 466 B → 212 B, and `pest` passes
  through faithfully (though it does not compress: guard says `low-gain`, which is the right answer).
  `pint`, `phpstan`'s text path, `sqlfluff-lint`'s text path, `ecs` and `log` were measured and
  **rejected** — the first three only parse JSON or fail into a tail-of-60-lines fallback, `ecs`
  drops the stack trace, and `log` discards every line its keyword classifier does not recognise.
  `prettier` stays permanently out (it fabricates success).
- **The Insights footnote reconciles itself with `rtk gain`.** `rtkSelf` carries rtk's own two
  counters from the **same** ledger and window: failed parse count plus how many fell back and ran
  anyway (`parse_failures`), and how many rows `rtk gain` would exclude as oversized (input above
  7,500 tokens, rtk's `HEADLINE_INPUT_CAP_TOKENS`). The page deliberately keeps the full totals and
  only annotates the difference, so the two numbers can be told apart instead of one silently
  mimicking the other. Both lines appear only for the rewrite shape, only when the ledger is
  readable, and only when non-zero — printing "0 parse failures" when the ledger could not be read
  would turn "nothing was read" into "nothing failed".

- **The recall store is taken over, so folded output is retrievable inside dsh.** The injected prefix
  now carries `RTK_RECALL_DB` next to `RTK_DB_PATH`, pointing at `$DSH_HOME/rtk/recall.db`. Before
  this, the prefix path only set `RTK_DB_PATH`; measured under a clean `HOME`, a single `rtk ls -la`
  then created the **global** `~/Library/Application Support/rtk/recall.db` and wrote one row into it,
  so the compressed lines pointed at a store the page never mentioned. Both variables are also
  tombstoned in `withoutRtkDbEnv`, and the Insights footer reports the store's entry count and disk
  size (file size, not `SUM(byte_size)` — that column holds the pre-gzip length). "Clear" deliberately
  does not touch it: the pointers already handed to the model would stop resolving, while the button
  promises to clear counters.
- **rtk's own cleanup chain runs on dsh output.** `lib/rtk-hook.ts` generates a `pipeline.toml` at
  `$DSH_HOME/rtk/config/pipeline.toml` (`schema_version = 1`, `extends = "rtk:posthook"`, plus one
  `[[hook.after_tool.shell]]` rule this plugin owns) and `host.ts` pipes long output through
  `rtk hook claude` before windowing it. The chain is `ansi → progress → dedup`: `base64-elide` was
  measured and left out because its `MethodInfo` is `lossy: true, recovery: Recovery::None` and
  removing it changed the compressed result by zero bytes; `cap` is left out because the windowing
  above already cuts head and tail, and two cutters would make the omitted count un-reconcilable.
  Order is clean-then-window on measurement (792-line build log 32,550 B → 9,228 B, against 10,366 B
  for the window alone and 9,309 B the other way round). It takes the output above the log window
  and the long output no filter claims (`./build.sh`, `make`), so `hook` joins the default filter set.
  Three side effects are isolated rather than tolerated: the config lives under `RTK_CONFIG_DIR`, the
  ledger under a **separate** `$DSH_HOME/rtk/hook.db` (rtk writes one `Bash <cmd>` row per call, which
  would otherwise show up as a command in the Insights tables), and `HOME` / `USERPROFILE` (plus
  `APPDATA` / `LOCALAPPDATA` on Windows) point at `$DSH_HOME/rtk/home` — without that last one, rtk
  writes `pipeline-status.json` into the platform data dir and a clean load **deletes the user's own
  copy** (measured on macOS; on Windows rtk resolves that directory through the Known Folder API, so
  the redirect is best-effort and not yet verified on a real machine). `parseHookOutput` treats an
  empty reply as "nothing to change", not "compressed to nothing": rtk emits zero bytes whenever
  `never_worse` or `min_size` says no, and hiding the output in that case would be the worst possible
  reading.

- **Reading material is never touched, and the model is told why.** Two changes with one goal: the
  model must not be able to mistake a compressed excerpt for a complete output. First, the "never
  touched" predicate got narrower — `isReadingTarget` (`lib/output-window.ts`) means a file-reading
  command (`cat` / `head` / `tail` / `less` / `more` / `zcat` / `zless` / `zmore`) **whose operands
  carry no log extension**, so `head -1000 src/app.ts` (900 lines → 4,400 B before this) and
  `cat notes.txt` now pass through untouched, while `cat build.log` still gets windowed. `.txt` left
  the log-extension list for the same reason: the real ledger's `.txt` rows are
  `coverage/rust-summary.txt`, `.scratch/*-gaps.txt`, `huge.txt` — reports and prose, not noise.
  Second, the plugin now registers a resident summary (`rtk-usage`, systemPrompt order 1565) holding
  the three facts that change a decision — reading commands are never compressed, anything dropped is
  retrievable, `rtk bypass <cmd>` is the one clean way to keep a command verbatim — and registers the
  full rules as the virtual skill `rtk`, which appears in the skill catalog from the first step and
  loads by name. The body is not pushed into the context by default. `@deepseek-ai/dsh-skill` and
  `@deepseek-ai/dsh-system-prompt` are `devDependencies` only, and `skills` is deliberately **not**
  in `inject`: a missing skill service costs only the loadable body, never the assembly.

### Fixed

- **`windowOf` returns through a single exit.** The first version had one branch returning a value
  and another returning nothing, which the repository's `typescript(consistent-return)` baseline
  rejects; the rewrite is behaviour-identical.
- **A hook pass that saved nothing is reported as "nothing to save", not as a failure.** `rtk hook`
  emits zero bytes whenever `never_worse` or `min_size` says no, so the `hook` mode legitimately
  returns "no change" — and `renderCompressed` was mapping that to `pipe-failed`, the record type for
  a spawn failure. On the page that reads as "rtk is broken" and sends the reader to check the
  installation, when the honest answer is "this output had nothing worth cutting". Both non-spawning
  modes (`window` and `hook`) now record `guard:low-gain`; only the `rtk pipe` branch can produce
  `pipe-failed`.
- **The `already-rewritten` handoff no longer gives up on rewrites that compress nothing.**
  `rtk rewrite` turns `cat build.log` into `rtk read build.log`, and `rtk read`'s `--level` defaults
  to `none` — measured, 22,390 B in and 22,390 B out. So "this call was rewritten" was being read as
  "this output is already compressed", and the window never got a chance at exactly the family where
  it earns most: `rtk_cmd = 'rtk read'` is 710 rows / 7,353,339 input tokens all-time, of which the
  rows with a log-extension target are 431 rows / 6,672,440 tokens; since 1.2.0 that is still 73 rows
  / 1,855,886 tokens. The one-shot ledger now records the rewritten command instead of a boolean, and
  `isVerbatimRewrite` (in `lib/dedup.ts`) keeps the handoff only for rewrites that really do compress
  (`rtk read` with no `-l` / `-m` / `--head-lines` / `--tail-lines`). The ledger entry is still
  consumed either way, so a call is never asked twice.
- **The bars-only fallback now says where the rate went.** When fewer than three buckets carry
  savings the chart drops the rate line on purpose (two points are not a trend), but the old note
  only explained the missing line — so on a real ledger, where two days of data mean every window and
  granularity lands in that mode, the page read as "the rate is not drawn". The note is now its own
  amber callout rather than grey footnote text, and it names both places the rate still appears (the
  KPI row and the detail tables). The fallback rule itself is unchanged.

### Tests

- 991 cases across 62 files, coverage at 100% on all four dimensions. New unit files:
  `test/output-window.test.ts` (target detection over nine log viewers, nine log extensions and
  seven source extensions, reading-material detection, plus the window's marker shape, line
  accounting, newline preservation and invalid-argument handling), `test/rtk-hook.test.ts` (the
  generated `pipeline.toml`, the PostToolUse payload, the eight environment keys and the three-level
  reply parser) and `test/skill.test.ts` (the skill spec handed to the host, every silent failure
  mode — absent service, empty body, throwing register — and where the disposal lands). The
  integration rigs under `test/integration/` drive the real Cordis pipeline, the real agent loop,
  the real tool-bash receipts, the real web gateway and loader, the real rtk CLI, and real cargo/git
  data; `test/platform/platform.test.ts` asserts the assembly gate on the host platform, Windows
  included.

## 0.2.1

Compression stops being decorative. The default filter set now covers the commands command rewriting
cannot take — including vitest, whose passing lines this plugin strips itself instead of asking rtk —
the two loss-based guard rules became recoverable when the original really was saved to a spill file,
and the Insights page gained a frozen first column plus a one-shot count animation.

### Changed

- **The default `enabledFilters` follow what command rewriting cannot take.** `['cargo-test',
  'pytest', 'ctest']` → `['git-log', 'git-diff', 'git-status', 'grep', 'find', 'vitest']`. `rtk
  rewrite` answers rc=3 for the old three and rewrites them to `rtk <cmd>`, so the compression pass
  could only ever report `already-rewritten`; on a real profile 64 bash calls produced `compressed 0`,
  `no-filter 58`, `already-rewritten 3`. The first five are the shapes rewriting still hands back, so
  filtering them is the only chance left. `vitest` joins them because `pnpm test` / `npm test` /
  `yarn test` are the forms rtk **cannot** rewrite (its rules require an explicit `run`, measured
  rc=1) — and that path does not call rtk at all (see Added).
- **The command table counts the segments that were actually rewritten.** rtk's own ledger already
  stores one row per rewritten segment (`cd x && rtk git diff && rtk cargo test` becomes two rows,
  `git diff` and `cargo test`; `cd x` has none), so the prefix detail tables are already
  per-segment — what changed is the wording plus the value in `dsh_last_events.command_family`:
  a rewrite now takes the first **rewritten** family, where the previous version took
  `commandFamilyOf(whole line)` and printed `cd` for exactly those commands.
- **The deny table is down to one entry: `aws`.** The other eight (`git log` / `git diff` /
  `git show` / `ls` / `find` / `grep` / `rg` / `cargo clippy`) refused a rewrite because the output
  would get shorter — that is the compression shapes' question, not the rewrite gate's. Rewriting
  them is now the default, and "output got shorter" is answered by the guard. `aws` stays because
  rewriting changes the exit code: a missing `aws` gives 127 natively and 1 through rtk.
- **A segment that fails the gate is restored; the rest still gets rewritten.** `cd x && aws s3 ls &&
  cargo test` → `cd x && aws s3 ls && rtk cargo test`. rtk rewrites every segment it recognizes, so
  handing the whole line over and putting the gated segments back verbatim is the only way to keep
  both halves. `restoreGatedSegments` uses each segment's **original text including trailing
  whitespace** — trimming it makes that segment fail the "untouched segment" check.

### Added

- **The vitest path compresses without rtk.** `lib/vitest-strip.ts` drops `✓` passing lines from the
  stdout segment in memory: `host.ts` routes `filter === "vitest"` to a `strip` mode instead of
  spawning `rtk pipe -f vitest`, so no process is started and no version gate applies. Measured on
  this repo's own suite: 4,105 B → 412 B (73 lines dropped, 90%), with `Test Files 52 passed (52)` /
  `Tests 860 passed (860)` / `Duration` intact. The reason is not preference: rtk's vitest parser gets
  nothing usable on vitest 5 (its injected `--reporter=json` writes a file, stdout keeps one notice
  line), `--outputFile=/dev/stdout` dies at 65,536 B on a non-blocking pipe (a real 850-test JSON is
  149 KB), and feeding it plain text loses every assertion (`AssertionError` 4 → 0, and the guard said
  `ok`). Console blocks (`stdout | …`) are left whole — a user's `console.log` can look exactly like a
  passing line.
- **A recoverable rejection can be relaxed, and then says where the original is.** Two guard rules
  — `lost-hash` and `folded-entries` — are now marked `recoverable`: what they object to is *missing*
  content, and that content is in the original. `host.ts` therefore saves the original to the host's
  spill store **first**, and only then finishes the compressed body; the relaxed
  pass writes `spillRelaxed` (omitted bytes + locator + the host's own `retrievalHint`) as the **first
  line of the compressed body**, not just into `additionalContexts` — a model usually reads only the
  body. Without a retrieval path the old behaviour stands: no lossy compression enters the context.
  The other four rules stay hard rejects (`fabricated-success` would show the model a contradiction).
- **The first table column is frozen, and the scroll chain stops at the table.** `tbody td:first-child`
  is `position: sticky; left: 0` over an opaque background with a hairline divider (the header cell
  keeps `z-index: 3` so the corner cell wins both axes), and `.rtkc-table-wrap` gained
  `overscroll-behavior: contain`.
- **The KPI counters count up once.** Three integer cells (bash calls, attempts, succeeded) animate
  from 0 to their value with pure CSS — a registered `@property --rtkc-count-target`,
  `counter-reset` + `counter()` in `::after`, no timers and no per-frame re-render. Only the first
  render after mount animates (a module-level flag); `prefers-reduced-motion` shortens the animation
  to 1 ms instead of removing it, because the starting `0` comes from the keyframes.

### Tests

- 866 cases across 53 files with the four coverage dimensions at 100%. New cases pin the failure
  header reconciliation, the relaxed pass (with and without a spill store), the new default filter
  set, `KpiRow.count` staying absent on the three formatted cells, the gate-restoration path, and the
  six behaviours of `stripPassingTests` (console blocks kept, `↓`/`□`/`×`/`→` kept, all-passing keeps
  its summary, no passing line means `dropped: 0` so the gain rule rejects it).

## 0.2.0

Statistics move out of one cumulative card and into a page of their own, split by shape. The old
single accumulator is demoted to a one-time migration input. Two Remote methods were added, the
client half gained a package-local on-demand chunk, and `storageDomain` left `inject`.

### Added

- **An Insights page in the left sidebar.** The `main` slot entry (key `rtk`) plus a `sidebar.panellist`
  entry with the same id expose `lib/insights-service.ts` through four Remote methods —
  `overview` / `insights` / `status` / `reset`. The page switches shape (rewrite / compression),
  window (7 / 30 / 90 days) and granularity (day / week / month); it shows a KPI row, a combination
  chart, "why this one was not compressed", detail tables, suggestions and a data note.
  `lib/insights-page-logic.ts` holds the DOM-free projection so the whole view model is unit-testable.
- **One dataset, and only dsh sessions land in it** (`lib/rtk-paths.ts`). The ledger is
  `$DSH_HOME/rtk/history.db` (default `~/.dsh/rtk/history.db`), with `$DSH_HOME` resolved through the
  host's own `@deepseek-ai/dsh-home-paths` rather than a second home-directory rule. Every rewritten
  `rtk` segment is prefixed with `RTK_DB_PATH` pointing at that file, so rtk books its rows there and
  nowhere else: the rtk a user runs in their own terminal — and `rtk gain` — stay untouched and are not
  counted. This replaces the intermediate "share rtk's global ledger" step, which on a real host put
  "0 rewrites succeeded" and "1.7M tokens saved" on the same screen. Pipe counters and the per-event
  detail of both shapes are written as `dsh_*` tables **inside that same database**
  (`lib/insights-store.ts`, SQLite via a dynamic `node:sqlite` import; if it cannot be opened only the
  statistics are lost). rtk never reads or drops those tables.
- **"Reset stats" now asks first.** The button opens the host's own `RiskConfirmation`
  (`@deepseek-ai/dsh-client-ui-primitives`, a platform module, externalized in `build-client.mjs`):
  a warning-tone body plus an acknowledgement checkbox, and the confirm button stays disabled until it
  is ticked. The dialog names both halves it clears — rtk's five tables in dsh's own ledger (deleted the
  same way `rtk gain --reset` deletes them) and the plugin's `dsh_*` tables — and says plainly that the
  user's global `rtk gain` history is not touched.
- **Apache ECharts 6.1 as a package-local on-demand chunk.** Charts live in
  `client.insights-echarts.js` (537,725 B), pulled through `require.async` only when the page is
  opened; the entry bundle never contains ECharts. ECharts is a `devDependencies` pin, so the
  published package gains no runtime dependency; the chunk carries an Apache-2.0 notice banner and
  `THIRD_PARTY_NOTICES.md` now embeds the upstream `NOTICE` and `LICENSE` verbatim.
- **A two-bar chart on the settings card** (today's rewrite savings vs compression savings), sharing
  the same chunk, plus one line of per-shape today summary. Both read the existing `overview` reply,
  so the card issues no extra request.

### Changed

- **`storageDomain` is no longer an injected surface.** `isRtkHost` stopped requiring it and `inject`
  is now `["settings", "subprocess", "tools", "workingDirectory"]`; the old accumulator is read once
  through `ctx.get("storageDomain")` (`loadLegacyAccumulator`) and its absence simply skips the
  migration. `lib/stats-store.ts` shrank from a read/write store to that read-only entry, and
  `lib/stats-shape.ts` keeps only `RTK_STATS_NAMESPACE` and `statsStatusSchema`.
- **The cumulative accounting path is gone.** `chartBarsOf` / `ChartBar`, `createDeferredStatsStore`,
  `makeCountRewrite`, `PrefixDeps.countRewrite` and `PipeDeps.stats` were removed; both shapes now
  record through `lib/insights-sink.ts`, which drops records before the store is open rather than
  counting half a window.
- **Read-only deployments degrade instead of failing.** `sandboxModeOf` reads `defaultMode` from
  `sandboxPolicy`; under `read-only` the prefix savings are reported as unavailable (the rewrite
  counters stay visible) and pipe statistics keep working.
- **Availability and suggestions speak keys, not Chinese sentences.** `availability.message` became
  `reasons: AvailabilityReason[]` (five enum values) and each suggestion became
  `{kind, key, severity, params}` with the numbers in `params`. The service no longer decides what
  language the user reads; the page maps keys through `ui-messages.ts`, so an English UI no longer
  shows Chinese paragraphs in the footnote or the suggestions block.
- **Rebuilt artifacts**: `host.js` 224,634 B, `client.js` 83,212 B, `client.insights-echarts.js`
  537,725 B. `test/floors.ts` gained a third entry for the chunk and raised the client budget. Its
  notes quote the current sizes; the budgets themselves were not raised with them.

### Fixed

Found by two ocr passes over the whole package (87 comments in the second, all re-checked against
source and a real host with seeded data) plus that host pass; each one is reproduced by a case in the
suites below.

- **The epoch could go permanently NaN.** `dsh_meta.statsEpoch` was read back with `Number(...)`;
  one unreadable value made every later flush compare `NaN !== NaN`, so every batch was dropped as
  "another host reset us", and `reset()` wrote `"NaN"` straight back. `parseEpoch` now falls back to
  0 and `reset()` only advances the in-memory epoch after `COMMIT` succeeds
  (`lib/insights-store.ts`).
- **A held write lock dropped the batch and blocked the caller for five seconds.** The flush now
  reports failure to its caller, which puts the batch back (bounded by `BUFFER_LIMIT`) and re-arms the
  timer; the purge side of the same transaction moved under `BEGIN IMMEDIATE` so a reset by another
  process cannot land between the epoch read and the write.
- **Recording after `close()` reached a closed handle.** `push` / `schedule` / `reset` / `flushNow`
  all check `closed` first, and `close()` flushes before setting it, so the last few records are not
  thrown away.
- **A pipe-only deployment never created the ledger directory.** `ensureParentDir` now runs inside
  `openInsightsStore`, so statistics work when the prefix side never installs (Windows, or `rtk` off
  `PATH`).
- **Ledger failures were silent.** `readPrefixLedger` / `createRtkLedger` take an optional `warn`
  sink, and `PrefixOptions.warn` is wired to `ctx.logger().warn` — a broken bookkeeping chain says so
  even when the diagnostic log is off. A missing `commands` table is not reported: that is "rtk never
  recorded anything", not a fault.
- **Chart state races.** A second `spec` change no longer mounts a second instance into the same
  container; the follower only updates, and the leader owns disposal. A half-constructed handle
  (chunk version mismatch) is released instead of leaking its canvas and resize listener. Dark mode
  gets its own `--rtkc-chart-text` / `--rtkc-chart-grid`, re-read when `data-ds-dark-theme` flips.
- **Window padding invented data before the ledger starts.** `zeroFillSeries` took the whole window
  and filled it with zeros, so a 30-day view opened with a 0-height bar on a day the ledger has no
  rows for — "no data yet" read as "saved nothing". It now starts at the bucket that contains
  `dataStart`.
- **Suggestions repeated and mis-scaled.** `potentialSuggestions` grouped by filter instead of
  emitting one row per stored day (the stored table is keyed by day and filter), and the compression
  hint said "compressed N times" while counting skipped attempts.
- **Two all-zero readings were shown as real ones.** The card called a day "idle" while rewrite
  attempts existed, and the KPI row printed "average rewrite latency: 0 ms" when no sample had been
  measured.
- **An unbuildable ledger directory made rtk write into the user's own ledger.** When
  `prepareLedgerDir` could not create `$DSH_HOME/rtk/`, the injection path was cleared — and rtk
  without `RTK_DB_PATH` falls back to its own `get_db_path()`, i.e. the ledger the user's terminal
  writes to. `prepareLedgerDir` now returns two facts (`inject` / `writableDir`): the path is
  injected **even when the directory cannot be created** (rtk then drops the row silently, exit 0,
  a row missing at worst), while only a verified directory is registered with the sandbox and
  reported as available. Polluting someone's data and losing one row are not the same severity.
- **`FAILURES (31)` was read as "31 tests failed".** rtk's count is a *line* count — its parser
  pushes every non-empty line of a failing block as its own entry, so a 15-failure run prints
  `(31)` and a 40-failure run prints `(81)`. Rather than rewrite a number we have not verified, the
  guard appends one line under the header stating what the count is and how many failing blocks the
  input actually has (and, when `… +N more failures` is present, that not every block is expanded).
  It stays silent when the block count cannot be established from the input.
- **A placeholder was printed as if it were a measurement.** Rewrite form has no byte size to
  measure, so `dsh_last_events.size_bucket` is `unknown` for every prefix row — and the "latest
  rewrite" line rendered it verbatim as "已改写 · git status · 输入 unknown". The size segment is now
  dropped entirely when nothing was measured (`whyLastNoSize` / `whyLastPlainNoSize`).

- **A read face that threw took the whole endpoint with it.** `overview` / `insights` read straight
  through `store?.read*()`, so a store closed under them (or held by another writer) rejected the
  Remote call and the page could only say "load failed". `guardedStoreOf` now wraps every read: a
  throw becomes an empty window plus one `warn` line naming which table failed, and the ledger side
  keeps whatever it read. A failed read is also no longer indistinguishable from an empty one.
- **`Math.max(...samples)` on an unbounded window.** Spreading every event of a 90-day window can
  exceed the argument limit and throw `RangeError` exactly on the busiest installs. Replaced with a
  loop (`lib/insights-service.ts`).
- **Rewrite rows claimed a 100% success rate.** `prefixCommandRows` set `attempts` and `compressed`
  to the row's `commands`; the ledger only holds rows rtk actually ran, so the computed `successPct`
  was always 100. Both now copy `commands` with a comment saying what that means.
- **"Latest event" could be missing while it existed.** `lastEventOf` scanned the newest 20 rows of
  both shapes and filtered by form, so a busy compression stream could push the rewrite row out.
  `readLastEventOf(form)` asks SQL for one row per shape instead.
- **The data-start day read the whole pipe table.** `pipeDataStart` opened the day table from
  `0000-00-00` just to take its first row; `readPipeFirstDay()` is `ORDER BY day LIMIT 1`.
- **A purge failure rolled back a batch of good inserts.** `prune` ran inside the write transaction;
  one failing `DELETE` discarded the records that had just been written. It now runs after `COMMIT`
  in its own try/catch and only warns.
- **A failed flush was silent.** The retry path kept the batch but said nothing; the first failure
  now logs `cannot write the stats tables (…); keeping up to N records in memory and retrying`.
- **Resetting left the migration snapshot behind.** `reset()` cleared the nine `dsh_*` tables but not
  `dsh_meta.legacy`, so the page kept showing the old accumulator after a "clear". It is deleted in
  the same transaction now.
- **`readPrefixEvents` had no consumer** and was removed; `readLastEvents` keeps the newest rows.
- **The read side waited five seconds for a write lock.** `BUSY_TIMEOUT_MS` is right for the writer
  (rtk's own writer uses 5000) but the reader runs on the host's main thread through a synchronous
  API. Reads now open with `timeout: 500`.
- **`TOP_COMMANDS` truncated the wrong rows.** `ORDER BY saved DESC LIMIT 100` cut the low-yield tail
  — i.e. exactly the families a suggestion is supposed to find — and made per-family totals disagree
  with the window total. Raised to 2000.
- **Clearing rtk's tables could follow a symlink and delete someone else's data.** `clearRtkCommands`
  now refuses a symlinked database file, and does the five `DELETE`s inside one transaction instead
  of swallowing every per-table error.
- **Every ledger query wrapped the timestamp column in `date(…, 'localtime')`.** That defeats any
  index rtk has on `timestamp` and scans the whole table on each poll. The window bound is now
  compared against a pre-computed RFC3339 UTC string (`toRfc3339Utc`), with the local-day projection
  kept for grouping only.
- **Command families were mis-parsed three ways.** Wrapper options were taken as the command
  (`sudo -u bob cargo test` → `-u`), only `/` was stripped from a path (a Windows path became the
  family, leaking the user's directory into the ledger), and a two-word family swallowed a file
  argument (`pytest tests/test_api.py` → `pytest tests/test_api.py`). Wrappers now skip their own
  value-taking flags, both separators are stripped, and the second word must look like a subcommand.
- **`rtk pipe` inherited `RTK_DB_PATH` from the host process.** The rewrite path already scrubbed it;
  the pipe child now does too, so a stray variable cannot redirect rtk's bookkeeping.
- **Non-shell tools were recorded as pipe skips.** Every non-bash call wrote a `not-shell` row, which
  polluted "the latest compression" and the skip-reason table with rows that were never candidates.
  They are not recorded at all; a downstream block and a downstream value rewrite are also two
  different reasons now (`downstream-block` / `downstream-value`).
- **`ChartSpec.compact` was declared and never read.** The settings card's 132px chart rendered with
  the page's grid and five split numbers. `compact` now drives both (`grid`, `splitNumber`), and the
  card asks for it.
- **A dead branch said `yAxisIndex` depends on the shape.** `lineSeriesOf` is only reached from the
  combo path, so the condition was always true; it is now the constant it was.
- **The two selects had no accessible name.** `Picker` takes a `label` and writes it to
  `aria-label`; the page passes `rangeLabel` / `granularityLabel`.
- **Switching shape could land an old reply on the new view.** `reload` had no generation counter;
  a slow 90-day reply could overwrite a fresh 7-day one. Each request carries a generation and stale
  replies are dropped.
- **Negative ratios produced `width: -25%`.** `ratioOf` now floors at 0 and caps at 1.
- **Counts were formatted as token volumes.** The workdir and skip-reason tables ran `formatTokens`
  over `commands` / `count`, so "1500 calls" printed `1.5k` while the KPI row printed `1500`.
- **The sparse-chart note said "days" while counting buckets.** With weekly or monthly granularity
  the sentence was wrong; it now says "buckets" / 「时间段」.
- **`sectionKpi` / `sectionChart` / `sectionWhy` were dead keys**, and `data-rtk-panel-icon` was
  written onto the icon with no CSS consuming it. Both removed.
- **A failed chunk load was cached forever.** One transient failure left every later open without a
  chart for the rest of the session. Failures are no longer cached, and both "chunk did not load"
  and "chunk loaded but exports the wrong thing" log a line.
- **A chart handle was updated on a node that no longer existed.** `ChartState` did not remember
  which container the handle was mounted on, so a conditional re-render could push an update into a
  detached node. It records the node now and re-mounts when it changes.
- **The Remote endpoint trusted its input.** `insights(request)` is `InsightsRequestSchema.parse`d
  inside the service too: the gateway codec checks the wire envelope, not the payload.
- **A close error masked the real one.** `loadLegacyAccumulator` awaited `domain.close()` in
  `finally`, so a throw from `close()` replaced whatever the read had already failed with.
- **The sink kept handing out a store it was closing, and never retried a failed open.** The
  disposer clears its `active` reference first, and `load()` only caches a *successful* open, so a
  transient failure is retried on the next call.
- **The generated banner named the wrong file.** Entry and chunk share one header, so
  `client.insights-echarts.js` told readers to edit `src/client-entry.ts`. It now says "the sources
  under `src/`".
- **Nothing checked the chunk at load time.** `declareClientFreshness` only compared `client.js`, so
  a stale chunk shipped silently; it now compares every declared chunk. `test/build-client.test.ts`
  asserts the platform module stays external, and `test/publish-manifest.test.ts` asserts every
  `client.*.js` on disk is in `files`.

### Tests

- 854 cases across 52 files with the four coverage dimensions at 100%. New suites cover the view
  model (`test/insights-view.test.ts`), the service (`test/insights-service.test.ts`), the store
  (`test/insights-store.test.ts`), the ledger (`test/rtk-ledger.test.ts`), path resolution
  (`test/rtk-paths.test.ts`), the SQLite face (`test/sqlite-face.test.ts`), prefix and pipe
  instrumentation (`test/prefix-insights.test.ts`, `test/pipe-insights.test.ts`), the page
  projection, and the chunk split in `test/build-client.test.ts`.
- `test/readme-parity.test.ts` keeps the two READMEs structurally identical, and
  `test/publish-manifest.test.ts` keeps the new chunk in `files`.

## 0.1.2

Bumped `@jayyuen66/dsh-plugin-shared` to `^0.2.10`. The settings-card sticky save bar no longer picks up an opaque background from an older fixed-id `CARD_UI_CSS`. The client bundle was rebuilt. No public tool, Remote method, or config surface changed.

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
