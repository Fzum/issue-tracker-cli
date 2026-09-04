# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a standalone repository. Everything it needs is inside it:

| Path | What it is |
|---|---|
| `wp.ts` | Executable entry point and the single public barrel (~45 lines). No logic beyond the process contract: the exit code and the stdout EPIPE guard. |
| `src/` | The CLI itself — 11 flat modules, one technical concern each, zero runtime dependencies |
| `orchestrate.ts` | The second entry point: the wave loop that drains a queue with parallel agents. Drives `wp.ts` as a subprocess; imports nothing from `src/` |
| `prompts/worker.md` | The role half of every worker prompt. This copy is both this repo's own and the template other projects copy |
| `install.sh` | The third entry point, and the only one that runs *outside* this repo: it points a target project at the other three. POSIX `sh`, no logic beyond create-if-absent and report |
| `board.ts` | The fourth entry point: a live, read-only view of `wps/` in a browser. Built like `orchestrate.ts` — drives `wp.ts` as a subprocess, imports nothing from `src/` |
| `board.html` | The whole board client in one self-contained file: inline CSS, inline vanilla JS, no framework and no build step. `board.ts` reads it from disk beside itself |
| `tests/` | The suite — one `*.test.ts` per concern plus the shared `helpers.ts` fixture. Given/When/Then, real files in temp dirs |
| `docs/design.md` | The approved design: field reference, derivation rules, the 11 `wp check` rules, the `start`/`done` guards, exit codes |
| `docs/vision.md` | Raw brainstorming plus the decision log D1–D11, with the rationale for every constraint below |
| `docs/execution-model.md` | How an orchestrator runs the queue with parallel agents: the wave loop, worktree isolation, serial merge |
| `docs/board.md` | The board's approved design: why it polls, the five states, the deep leaf counts, and what is deliberately not built |
| `telemetry.env` | The exports that switch live traces on, to `.` into a shell. Not a project file and never copied into one; `install.sh` prints the command and writes nothing. Listed in `install.sh`'s required-files loop, so a clone missing it refuses |
| `docs/observability.md` | Watching a live wave: `wp.id` per agent, the env block that turns telemetry on, the viewer, and what is deliberately not built |

Read `docs/design.md` before changing CLI behaviour, and `docs/vision.md` before
questioning a constraint — most surprising choices are deliberate and have a recorded
reason.

## Commands

```sh
bun install
bun test                                  # all tests
bun test -t "given a self edge"           # single test by name substring
bun run typecheck                         # tsc --noEmit
bun run wp --dir /path/to/project/wps check   # run the CLI (--dir is forwarded by bun)
./wp.ts check                             # or via shebang, against ./wps
./orchestrate.ts --dry-run                # what the next wave would do; spawns nothing
./board.ts --open                         # the live board, on http://127.0.0.1:4400
./install.sh --dry-run                    # from a *target* project; refuses to run here
```

Never run `./orchestrate.ts` without `--dry-run` to "check that it works": it spawns a
real `claude` per ready leaf and merges into the current branch. To exercise the loop,
put a fake `claude` on `PATH` in a throwaway repo — that is how the failure paths were
verified.

Requires Bun >= 1.0.29 (`Bun.stringWidth`, used by `wp tree`); `package.json` `engines`
records it. `@types/bun` is pinned to `latest`, so `typecheck` passes against a newer
API surface than an older installed runtime actually has — `bun test` is what catches
that gap, so never treat a green `typecheck` alone as verification.

There is no build step and no lint config; `bun test` + `bun run typecheck` are the full
verification gate. `bun run wp` only resolves from this directory — from anywhere else,
invoke `wp.ts` by absolute path.

## What this is

A work-queue CLI over markdown files. The filesystem *is* the tracker — no database,
no server. The primary runtime question it answers is "what should an agent work on
next?"; `wp start` / `wp done` then let the agent answer it without hand-editing.

## Architecture

The CLI is a pipeline. One concern per file, each testable alone; the data path is:

`frontmatter` → `store` → `graph` → `check` → `render` / `tree` → `cli`

| Module | Concern |
|---|---|
| `src/ids.ts` | Invariant 1: the stem grammar, `isWithin`, `compareWpIds`, `compareBlockerIds`, `compareText`. Imports nothing. |
| `src/model.ts` | The `WpError` taxonomy plus `Wp` / `ScannedFile` / `Problem`. Imports nothing. |
| `src/frontmatter.ts` | Invariant 7: the deliberate YAML subset, and EOL-preserving line splitting |
| `src/graph.ts` | Invariants 3, 4, 5: every derivation. Pure. |
| `src/json.ts` | The one JSON encoder (recursive key sort + non-ASCII escaping) |
| `src/store.ts` | **The only module that imports `node:fs`.** Read path plus invariant 6's writer. |
| `src/check.ts` | The `wp check` rules. Pure — takes a scan, not a directory. |
| `src/transitions.ts` | The `start` / `done` guard policy and what `--force` overrides |
| `src/render.ts` | Plain-text and JSON output for every command except `tree`. Returns strings. |
| `src/tree.ts` | The glyph tree: connectors, rollup counts, blocker lists, column alignment, `--scope` re-rooting, `tree --json` |
| `src/cli.ts` | **The only module that touches `process.*`.** argv grammar, help, dispatch, exit codes. |

Dependency direction is strictly one-way; an import may only point at a lower level:

```
L0  ids, model                    (import nothing)
L1  frontmatter → model;  graph → ids, model;  json → ids
L2  store → ids, model, frontmatter, graph, node:fs;  check → ids, model, graph
L3  transitions → model, graph, store;  render, tree → ids, model, graph, json
L4  cli → model, store, check, transitions, render, tree
L5  wp.ts → cli, plus the modules it re-exports
```

Four rules keep those boundaries honest. Each is one `grep` (use `grep -rn`, **not**
`git grep` — new files are untracked until staged, so `git grep` passes vacuously):

1. `grep -rnE 'node:fs|from "fs"|Bun\.(write|file)' wp.ts src/` → `src/store.ts` only.
   (`node:path` is exempt; it is pure string manipulation.)
2. `grep -rn 'process\.' wp.ts src/` → `src/cli.ts` and `wp.ts` only.
   (`Bun.stringWidth` in `src/tree.ts` is fine — it is not `process.*`.)
3. `grep -rn 'import\.meta\.main' wp.ts src/` → exactly one hit, in `wp.ts`, in the
   entry block. It is only true in the process entry file, so moving it into
   `src/cli.ts` makes the CLI a silent no-op. The subprocess CLI tests do catch that
   (they spawn `wp.ts` and would see empty output), so this grep is the fast
   pre-check, not the only guard.
4. `grep -rnE 'from "\.\./wp' src/` → nothing. No `src/` module may import the barrel.

Renderers return strings and never write; `src/cli.ts` does every write. That is what
makes output assertable without spawning a subprocess.

`wp.ts` ends with `process.exitCode = main()`, **not** `process.exit(main())`: a single
large `process.stdout.write` followed by `process.exit()` silently discards everything
past 128 KiB when stdout is a pipe. Every fs call is synchronous, so the process still
exits immediately.

The stdout `EPIPE` handler next to it is **load-bearing, not defensive**.
`process.exit()` was also swallowing the EPIPE a reader provokes by closing the pipe
early (`wp tree | head`, quitting `less`); without the handler it becomes uncaught,
so a clean run exits 1 with a crash dump — and exit 1 here *means* "check found
problems". It fires at flush time, so a `try`/`catch` around `main` cannot catch it.
Both halves are pinned by `tests/cli-piped-output.test.ts`; those tests need output past
the ~64 KiB pipe buffer, so keep their fixtures large.

The write path branches off the same graph: `startWp` / `finishWp` guard the
transition, then `setStatus` rewrites one line.

`loadGraph(dir)` is the read path for `next`/`show`/`tree`: it refuses to build a graph
if any file is unparseable or badly named, telling the caller to run `wp check`.
`check` deliberately uses `scanDirectory` directly so it can report on broken files.

### The orchestrator

`orchestrate.ts` implements `docs/execution-model.md`. Read that document before
changing it; every structural choice below is recorded there with a reason.

It is a **second entry point, not part of the CLI**. The four `grep` boundaries above
scope to `wp.ts src/` on purpose: `orchestrate.ts` legitimately touches `process.*`,
`node:fs` and `Bun.spawn`, and no `src/` module may import it. It imports nothing from
`src/` either — it drives `wp.ts` as a subprocess, so the JSON output shape is the
contract between them, not a function signature.

One seam carries the design: `runQueue(driver)` owns the bookkeeping, the `Driver`
interface owns the commands. That is what makes the wave and merge order testable
without git, an agent or a repository — `FakeDriver` in the test file records call
order. Add a step by adding a `Driver` method, never by reaching for git inside
`runQueue`.

Inside that seam the loop reads top-down as `runQueue` → `runAgent` → `integrate` →
`runStep`. `runStep` is the one try/catch: it turns a refused `Driver` call into a
`Failure` value and prints the one report line, so no other function needs a catch.
The two that keep their own are deliberate — `undoMerge` **throws** (it aborts the
run), and `discard` is best effort and never becomes a `Failure`.

Load-bearing behaviour, all of it pinned by tests:

1. **Claim serially before spawning anything.** A leaf that stays `todo` is offered
   again next wave for ever, so claiming is what makes the loop terminate. If nothing
   in a wave can be claimed, the loop stops instead of asking again.
2. **The wave is `Promise.all`; integration is a `for` loop.** Never make integration
   concurrent — serial merging is the whole source of attribution when the gate breaks.
3. **A red gate undoes its own merge** (`git reset --keep ORIG_HEAD`, never `--hard`:
   the `wp start` edits in `wps/` are still uncommitted). Without the undo, every later
   branch in the wave inherits the red gate and gets blamed for it. The runbook only
   says "keep the branch"; this is the part that keeps rule 3 true in a multi-branch
   wave. If the undo itself fails, the run aborts rather than merging onto a broken main.
4. **`wp done` only after a green gate**, and only after a merge that actually
   merged something. An agent can exit 0 having committed nothing; that branch is an
   ancestor of `HEAD`, so `git merge` is a silent no-op and `done` would be a lie.
   `merge` checks with `git merge-base --is-ancestor` and refuses first.
5. **A failing agent is not an error to propagate.** `runAgent` returns its outcome so
   one dead agent cannot abandon the rest of the wave.

Two git details are not cosmetic, and a mutation test proves each is pinned:

- The clean-worktree preflight allows **unstaged** changes under `wps/` and `log/`, and
  refuses anything **staged, wherever it is**. `git merge` will not run while the index
  differs from `HEAD`, even for a path the merge never touches, so admitting a staged
  file means paying for a whole wave of agents and then failing every merge. Read the
  index column of `git status --porcelain`, not just the path (`?` is untracked, not
  staged).
- Cleanup is `git worktree remove --force`, and `git branch -d` runs whether or not the
  removal worked. `bun install` rewrites the tracked `bun.lockb` in every fresh worktree,
  so a plain `remove` fails for every WP — and a leftover worktree makes `prepare` refuse
  that ID for ever, because it checks `existsSync` first.

Per D10 the project owns two of the three inputs: `prompts/worker.md` is read from the
*target repository* (`--role` overrides), and the gate is `--verify` (default
`bun test`, run through `sh -c`). Only `bun install` remains, and only when the
worktree has a `package.json`. Agent output goes to `log/<id>.log`, which is gitignored
and — like `wps/` — exempt from the clean-worktree preflight, or a second run would
refuse to start.

`--scope ID` restricts a run to one work package and everything under it — a
milestone, an epic or a single story, decided by the stem depth rather than by a
keyword. It is passed straight through to `wp next --scope`, so nothing here
computes hierarchy; that is deliberate, because a string prefix match would be
wrong (`wp-m1` vs `wp-m10`) and re-deriving the stem grammar across the subprocess
boundary is exactly what this file must not do.

A scoped run that never got a wave off the ground looks identical to a finished
one, so `printScopeStall` explains it before the summary: `wp tree --scope ID
--json` per WP, with any blocker whose id is *not* among the returned rows marked
`(outside scope)` — no run can release those, so widening the scope is the only way
out. It sits next to `printPlan` in section 5 and makes its own `wp` calls rather
than becoming a `Driver` method: it is reporting, not a step of the loop, and
`runQueue` stays untouched by it.

`orchestrate.ts` ends with `process.exitCode = await main()` and the same EPIPE guard
as `wp.ts`, for the same two reasons.

### The installer

`install.sh` is the only file here that runs with the *target* project as its working
directory. It is POSIX `sh` (`/bin/sh` is dash on the dev machine), like
`scripts/check-boundaries.sh`, and it is not covered by the four module-boundary greps —
those scope to `wp.ts src/`.

It finds the clone through `$0` (`cd "$(dirname "$0")" && pwd -P`) and the target through
`pwd -P`. That is the whole configuration: no flags for paths, no config file.

Four behaviours are load-bearing, each pinned by a test in `tests/install.test.ts` and
each confirmed by mutation:

1. **Every step is create-if-absent, and reports which it did** (`+` changed, `=` already
   there, `!` wants a human). This is what makes a second run after a `git pull` safe,
   and it is why a `prompts/worker.md` the user edited is never overwritten.
2. **`log/` is appended to `.gitignore` only when the rule is absent**, and a leading
   `printf '\n'` is emitted first when the file does not already end in a newline —
   otherwise `log/` is glued onto the last line and ignores nothing. The absence test
   pipes through `tr -d '\r'` first: `core.autocrlf=true` is set on the dev machine and
   `.gitattributes` pins only `*.ts`, `*.yml` and `*.sh` to LF, so a checked-out
   `.gitignore` really does contain `log/\r` and a plain `grep -qxF 'log/'` misses it.
   That bug was observed, not imagined — it appended a second `log/` to this repo's own
   `.gitignore` during a mutation run.
3. **Every refusal happens before the first write** — no `bun`, a clone missing
   `wp.ts` / `orchestrate.ts` / `prompts/worker.md`, or the current directory *being*
   the clone. That last one matters: without it, running the script here would create
   this repo's own `wps/` and rewrite its `.gitignore`.
4. **`--dry-run` skips the smoke test too**, not just the writes. `wp check` against a
   `wps/` the dry run declined to create would report exit 2 and read as a real failure.

Exit codes mirror the CLI's: `0` installed, `1` installed but `wp check` found problems
in an existing `wps/`, `2` refused. The two steps it only *prints* — `/plugin install`
and the `--verify` command — are deliberate: a slash command is not a shell command, and
the gate is the project's choice per D10.

### The board

`board.ts` and `board.html` implement `docs/board.md`. Read that document before changing
either; every choice below is recorded there with a reason.

It is the **fourth entry point, and a reader only**: no route writes, so invariant 6
stands. Like `orchestrate.ts` it drives `wp.ts` as a subprocess and imports nothing from
`src/`, so `tree --json` is the contract between them, not a function signature.

One seam carries the design: **`boardState(rows)`, one exported pure function**, holds
every rule of §3–§5 — container detection, the five states, the deep leaf counts, the
summary, the `hash`. It touches no filesystem, no network and no clock, which is what
makes it testable against literal arrays and what leaves the client, which nothing here
can test, with nothing but rendering. Add a rule there, never in the route and never in
`board.html`. `project` — the basename of the working directory — is the one payload field
the route adds instead, so `boardState` stays pure; being a constant, it does not defeat
`hash` the way a timestamp would.

Load-bearing behaviour:

1. **A container is an id some row names as its `parent`** — never a prefix of the id
   string (`"wp-m10e1".startsWith("wp-m1")` is `true`), and never the row order, which a
   missing parent file silently shifts. A `parent` naming an id with no row of its own
   becomes `null`, so that row renders as a root; dropping it is the one failure §3 exists
   to prevent, because a vanished work package looks like nothing at all.
2. **`done` and `doing` outrank blocked**, inherited from `statusGlyph` in `src/tree.ts`
   and it must not drift from it, or the board and the tree disagree about one file.
   `unmet_blockers` is the source, never the raw `blocked_by`.
3. **Every bar counts leaf descendants at any depth**, where `wp tree` counts direct
   children. That divergence is deliberate (§5) and will eventually be reported as a bug;
   do not "fix" it into agreement.
4. **It polls, and there is no watcher.** `fs.watch` fires while an agent is halfway
   through writing a file, where a poll either catches a valid tree or catches an error;
   a restarted server also needs no reconnect logic, and there is no debounce to tune.
   One second of latency is invisible against agents that take minutes.
5. **The payload carries no timestamp**, deliberately. `hash` is what lets the client skip
   a re-render and therefore skip destroying DOM the user is mid-scroll in, and a
   `generated_at` would change on every poll and defeat it entirely. The age in the header
   is the client timing its own last successful poll.
6. **`ok: false` is served with HTTP 200 and must never blank the page.** A half-written
   file is a normal event while agents work, so the client keeps the last good tree under
   a banner: a blank page reads as "everything vanished", a banner over a stale tree reads
   as "one file is broken right now", which is the truth and usually clears itself.

Two repository traps, both invisible when hit:

- **`tsconfig.json`'s `include` must list `board.ts`.** A root module outside those globs
  escapes `typecheck` entirely and reports a false green.
- **The four module-boundary greps scope to `wp.ts src/`.** `board.ts` legitimately
  touches `process.*`, `Bun.serve`, `Bun.spawn` and reads `board.html` from disk, exactly
  as `orchestrate.ts` legitimately touches its own three. The exemption is written down
  here and in `scripts/check-boundaries.sh` because nothing in the greps shows it, and a
  reader who cannot see why a root module is unchecked "fixes" it by widening the scope.
  No `src/` module may import `board.ts`.

`board.ts` ends with `process.exitCode = await main()` and the same EPIPE guard as
`wp.ts`, for the same two reasons.

### The load-bearing invariants

Changes that violate these contradict the design, not just the code:

1. **The filename stem is the ID.** `wp-m1e1u1.md` → `wp-m1e1u1`. There is no `id:`
   field. Grammar: `wp-` followed by `[a-z][0-9]+` segments (`STEM_PATTERN`).
2. **Only three fields are stored:** `status` (leaves only), `blocked_by` (flat list of
   stems), `short_description`. An unknown key is preserved but ignored only when its
   value is a single-line scalar; a list or map under any key but `blocked_by` raises
   `FrontmatterParseError`, so one such file fails `wp check` and makes `next`, `show`
   and `tree` refuse the whole directory.
3. **Everything else is derived, never stored** — parent (stem minus last segment),
   children (stems extending by one segment), `blocks` (inverted `blocked_by`), type
   (stem depth), container status (rollup over children), `ready`. If you find yourself
   adding a field that duplicates a derivation, that's the bug.
4. **Leaves are work; containers are derived.** A WP with children carries no `status`;
   `wp check` reports it as a problem. `wp next` returns leaves only.
5. **Readiness includes ancestors.** A leaf is ready only when its own *and every
   ancestor's* `blocked_by` targets resolve to `done` (`WpGraph.isReady`).
6. **One writer, one line.** `wp start` / `wp done` are the only write path, and
   `setStatus` only ever *replaces* an existing `status:` line — never inserts one,
   never re-serializes the frontmatter, always via temp-file + rename. Everything
   else stays read-only, and agents may still flip `status` by hand. `wp new` and
   `wp mv` are still deliberately deferred. An unmet `blocked_by` target is the only
   thing `wp start` refuses on — not the current status, and not another leaf being
   `doing` (D9 records why that guard was removed); `--force` overrides even that.
7. **The frontmatter parser is a YAML subset on purpose.** Nested maps, multiline
   scalars, anchors and flow mappings raise `FrontmatterParseError` rather than being
   silently misread — a misparsed `blocked_by` would corrupt the queue. Do not swap in a
   YAML library without reading risk §11 of `docs/design.md`.

Which module owns each invariant — change **every** listed owner together:

| # | Owner(s) |
|---|---|
| 1 | `src/ids.ts` (grammar + ordering) and `src/store.ts` (path → ID, and the only `STEM_PATTERN` test; `parseWp` deliberately does not validate the stem) |
| 2 | `src/model.ts` (`Wp`'s getters), `src/frontmatter.ts` (unknown keys preserved), `src/store.ts` (`blocked_by ??= []`) |
| 3 | `src/graph.ts` (`subtree`) and `src/ids.ts` (`parentId` *is* the parent derivation, `isWithin` the subtree one); `src/render.ts` / `src/tree.ts` re-derive type, depth and `parent` for the wire — a re-derivation each time, never a stored field |
| 4 | `src/graph.ts`, enforced by `src/check.ts` and `src/transitions.ts` |
| 5 | **Two implementations with inverted polarity, both in `src/graph.ts`:** `isReady` (yes/no) and `unmetDependencies` (names the blockers). Change both. Two readers depend on that equivalence: `src/transitions.ts` lists the blockers in the `wp start` refusal, `src/tree.ts` prints them after `⊘`. |
| 6 | `src/store.ts` (`setStatus`, the writer) and `src/transitions.ts` (the guards) |
| 7 | `src/frontmatter.ts` |

Ordering everywhere is `compareWpIds` — natural sort by segment letter then numeric
value, so `wp-m2` precedes `wp-m10`. Never fall back to lexicographic sort on IDs.
`compareText` in `src/ids.ts` is the lexicographic one; it is for filenames, object keys
and problem messages only.

`--scope ID` on `wp next` and `wp tree` narrows both to one subtree. It compares
*segments*, never strings — `"wp-m10e1".startsWith("wp-m1")` is `true`, so a string
prefix would quietly sweep a whole other milestone into a scoped run. That is what
`isWithin` in `src/ids.ts` is for, and it is why the filter lives in the CLI rather
than in `orchestrate.ts`, which must not know the stem grammar. A scope *filters*
readiness and never relaxes it: `WpGraph.readyQueue(scope)` applies `isReady` first
and the subtree second, so invariant 5 is untouched. An unknown scope is an unknown
ID (exit 2) — `WpGraph.subtree` resolves it before any segment arithmetic runs,
which is also what keeps `stemSegments`' bare `Error` off the exit path.

One exception, also in `src/ids.ts`: sort `blocked_by` targets with
`compareBlockerIds`. A target is an unvalidated string — it need not name an existing
file and need not be a grammatical stem — and `compareWpIds` **throws** on a stem it
cannot parse, so sorting raw targets with it crashes `wp tree` (exit 1, which in this
CLI means "`wp check` found problems"). `compareBlockerIds` keeps natural order for
grammatical stems and puts the rest after them, lexicographically. `src/tree.ts` is the
only caller today, because it is the only place a raw target reaches a sort; anything
that sorts them in future belongs there too.

Exit codes: `0` success (including an empty queue), `1` only from `wp check` finding
problems, `2` usage error / unknown ID / unreadable directory. `main` in `src/cli.ts` is
what converts `WpError` subclasses into exit 2; anything else propagates as a crash. That
`instanceof WpError` check is why every error class lives in one module — `src/model.ts`.

One input can legitimately produce several problems — a self-dependency trips both the
self-reference rule and the cycle rule, and a stray non-WP file trips both the filename
rule and the frontmatter rule. `src/check.ts` numbers these separately; don't "fix" the
duplication by collapsing rules.

### JSON output

`--json` goes through `jsonText` in `src/json.ts`, which recursively sorts object keys and
escapes non-ASCII. The shape is a stability contract for agent consumers — CLI tests
assert on it directly. `src/render.ts` owns the `show` / `next` / `check` payload shapes,
`src/tree.ts` owns the `tree` rows, and nothing else may call `jsonText`.

A `tree --json` row carries `parent` beside `depth`. Both are re-derived from the id for
the wire (`parentId` in `src/ids.ts`), so the tracker still stores nothing and invariant 3
is untouched — and `parent` is on the wire because no consumer may re-derive it: a prefix
match adopts a foreign milestone, and `board.ts`, the consumer it was added for, must not
know the stem grammar. It was additive, which is the only kind of change to these shapes
that is safe.

## Conventions

- Tests import from `../wp.ts`, the barrel — never from `src/` directly. That keeps the
  public surface explicit and reviewable in one file, and it is why rule 4 above exists.
  Adding a `src/` export does **not** make it public; add it to `wp.ts` deliberately.
- Tests are Given/When/Then in both name and body (`// Given`, `// When`, `// Then`
  comment markers), built on the `Fixture` class in `tests/helpers.ts` which writes real
  files to a temp dir; CLI tests spawn `wp.ts` as a subprocess and assert exit codes, so
  `wp.ts` must remain the runnable entry point.
- Add a test per spec rule when touching `check` — the suite already has one per rule.
- tsconfig runs `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
  so indexed reads need `?? fallback` and optional properties cannot take `undefined`.
  Match the existing `?? ""` / `?? []` idiom rather than adding non-null assertions.
  `include` covers `wp.ts`, `orchestrate.ts`, `board.ts`, `src/**/*.ts` and
  `tests/**/*.ts` — a new module outside those globs escapes `typecheck` entirely and
  gives a false green.

### The test layout

One file per concern, mirroring `src/`. Put a new test in the file that owns the behaviour
it pins, not the module it happens to call through:

| Test file | Pins |
|---|---|
| `tests/frontmatter.test.ts` | Invariant 7, the YAML subset — through `parseWp`, the only path a real file takes into the parser |
| `tests/graph.test.ts` | Invariants 3, 4, 5: parent / children / type, inverted `blocks`, cycles, container rollup, readiness |
| `tests/check.test.ts` | One test per `wp check` rule, plus the clean folder |
| `tests/store.test.ts` | Invariant 6's writer: `setStatus` replaces one line and preserves comments, unknown keys, CRLF and a missing final newline |
| `tests/transitions.test.ts` | The `start` / `done` guard policy and what `--force` overrides |
| `tests/tree.test.ts` | The glyph tree: connectors, rollup counts, blocker lists, column alignment, `tree --json` |
| `tests/cli.test.ts` | argv grammar, printed rows, JSON shapes, exit codes |
| `tests/cli-piped-output.test.ts` | The `process.exitCode` + EPIPE pair, on output past the pipe buffer |
| `tests/orchestrate.test.ts` | The loop, not the CLI: wave and merge order against `FakeDriver`, the real-git `Driver` against a throwaway repo, and `orchestrate.ts` as a subprocess |
| `tests/install.test.ts` | `install.sh` as a subprocess: what a fresh project gains, that a second run changes nothing, and every refusal |
| `tests/board.test.ts` | The board, not the CLI: every §3–§5 rule called straight into `boardState` on literal rows, plus `board.ts` as a subprocess on a test port driven with `fetch` — including §7's `ok: false` |
| `tests/helpers.ts` | The shared `Fixture`, `expectProblem` and `cleanupFixtures`. Not a test file — `bun test` reports 11 files, not 12. |

`tests/orchestrate.test.ts`, `tests/install.test.ts` and `tests/board.test.ts` are the
three files outside that mirror, because `orchestrate.ts`, `install.sh` and `board.ts` are
outside `src/`. Each brings its own fixture rather than importing `tests/helpers.ts`: one
needs a git repository, one a target project plus a throwaway `HOME`, and one a server on
a free port — not the bare `wps/` directory the shared `Fixture` builds.

The browser is deliberately not tested: a headless browser in a repository with zero
runtime dependencies would cost more than the coverage is worth, and keeping every rule in
`boardState` is what makes that trade honest rather than lazy.

`tests/install.test.ts` passes `env` to `Bun.spawnSync` on purpose, and always sets
`HOME` and `WP_BIN_DIR` inside the temp directory. A test that inherited the real
environment would write symlinks into the developer's own `~/.local/bin`, and the
"`bun` is not on `PATH`" case is only reachable by replacing `PATH` outright.

Every test file registers `afterEach(cleanupFixtures)` itself. Do **not** move that hook
into `tests/helpers.ts`: Bun evaluates a helper module once per process, so a hook
registered there attaches only to whichever test file imported it first, and every other
file silently leaks its temp directories. That was measured, not assumed.

Four modules have no file of their own, and two of them have real holes. Measured by
mutation, not assumed:

- `src/ids.ts` — covered. The ordering tests in `tests/graph.test.ts` and
  `tests/tree.test.ts` pin `compareWpIds` and `compareBlockerIds`.
- `src/model.ts` — covered. Each error class is asserted by the file that throws it.
- `src/json.ts` — **not covered.** Every `--json` test calls `JSON.parse`, which throws
  key order away, so neither the recursive key sort nor the non-ASCII escaping is asserted
  anywhere. Replacing `jsonText`'s body with a plain `JSON.stringify` leaves 93/93 green.
- `src/render.ts` — **half covered.** `show` is only ever run with `--json`; the one
  plain-text `show` call asserts an unknown-ID failure. Making the plain-text branch
  return a constant leaves 93/93 green, so display order, the `compareText`-sorted extra
  keys and the verbatim body append have no test at all.

Both holes predate the split — the test bodies are unchanged — and it only made them
visible. Close them by asserting raw stdout, not by adding a file for its own sake.

### If a module outgrows its file

Split further only when a file earns it, not pre-emptively:

- `src/cli.ts` past ~250 lines → lift the argv grammar into `src/args.ts`.
- `src/render.ts` past ~150 lines → split by command.
- `board.html` when it next earns it → the CSS out first, into one file `board.ts` serves
  beside the page, because that is the half with no logic in it.
- `WpGraph.requireWp` / the three `unknown work-package ID` throws (`src/graph.ts`,
  `src/transitions.ts`, `src/render.ts`) could be deduplicated by dropping `private`;
  deliberately left alone as it buys no behaviour. Same for `ancestors` vs the tree's
  `ancestorChain` — those two differ on purpose, see the comments on both.
