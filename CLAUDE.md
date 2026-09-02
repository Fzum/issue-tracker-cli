# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a standalone repository. Everything it needs is inside it:

| Path | What it is |
|---|---|
| `wp.ts` | Executable entry point and the single public barrel (~45 lines). No logic beyond the process contract: the exit code and the stdout EPIPE guard. |
| `src/` | The CLI itself — 11 flat modules, one technical concern each, zero runtime dependencies |
| `tests/wp.test.ts` | The whole suite — Given/When/Then, real files in temp dirs |
| `docs/design.md` | The approved design: field reference, derivation rules, the 11 `wp check` rules, the `start`/`done` guards, exit codes |
| `docs/vision.md` | Raw brainstorming plus the decision log D1–D11, with the rationale for every constraint below |
| `docs/execution-model.md` | How an orchestrator runs the queue with parallel agents: the wave loop, worktree isolation, serial merge |

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
```

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
| `src/ids.ts` | Invariant 1: the stem grammar, `compareWpIds`, `compareBlockerIds`, `compareText`. Imports nothing. |
| `src/model.ts` | The `WpError` taxonomy plus `Wp` / `ScannedFile` / `Problem`. Imports nothing. |
| `src/frontmatter.ts` | Invariant 7: the deliberate YAML subset, and EOL-preserving line splitting |
| `src/graph.ts` | Invariants 3, 4, 5: every derivation. Pure. |
| `src/json.ts` | The one JSON encoder (recursive key sort + non-ASCII escaping) |
| `src/store.ts` | **The only module that imports `node:fs`.** Read path plus invariant 6's writer. |
| `src/check.ts` | The `wp check` rules. Pure — takes a scan, not a directory. |
| `src/transitions.ts` | The `start` / `done` guard policy and what `--force` overrides |
| `src/render.ts` | Plain-text and JSON output for every command except `tree`. Returns strings. |
| `src/tree.ts` | The glyph tree: connectors, rollup counts, blocker lists, column alignment, `tree --json` |
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
Both halves are pinned by `describe("CLI piped output")` in the test suite; those tests
need output past the ~64 KiB pipe buffer, so keep their fixtures large.

The write path branches off the same graph: `startWp` / `finishWp` guard the
transition, then `setStatus` rewrites one line.

`loadGraph(dir)` is the read path for `next`/`show`/`tree`: it refuses to build a graph
if any file is unparseable or badly named, telling the caller to run `wp check`.
`check` deliberately uses `scanDirectory` directly so it can report on broken files.

### The load-bearing invariants

Changes that violate these contradict the design, not just the code:

1. **The filename stem is the ID.** `wp-m1e1u1.md` → `wp-m1e1u1`. There is no `id:`
   field. Grammar: `wp-` followed by `[a-z][0-9]+` segments (`STEM_PATTERN`).
2. **Only three fields are stored:** `status` (leaves only), `blocked_by` (flat list of
   stems), `short_description`. Unknown keys are preserved but ignored.
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
| 3 | `src/graph.ts` and `src/ids.ts` (`parentId` *is* the parent derivation); `src/render.ts` / `src/tree.ts` re-derive type and depth for the wire |
| 4 | `src/graph.ts`, enforced by `src/check.ts` and `src/transitions.ts` |
| 5 | **Two implementations with inverted polarity, both in `src/graph.ts`:** `isReady` (yes/no) and `unmetDependencies` (names the blockers). Change both. Two readers depend on that equivalence: `src/transitions.ts` lists the blockers in the `wp start` refusal, `src/tree.ts` prints them after `⊘`. |
| 6 | `src/store.ts` (`setStatus`, the writer) and `src/transitions.ts` (the guards) |
| 7 | `src/frontmatter.ts` |

Ordering everywhere is `compareWpIds` — natural sort by segment letter then numeric
value, so `wp-m2` precedes `wp-m10`. Never fall back to lexicographic sort on IDs.
`compareText` in `src/ids.ts` is the lexicographic one; it is for filenames, object keys
and problem messages only.

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

## Conventions

- Tests import from `../wp.ts`, the barrel — never from `src/` directly. That keeps the
  public surface explicit and reviewable in one file, and it is why rule 4 above exists.
  Adding a `src/` export does **not** make it public; add it to `wp.ts` deliberately.
- Tests are Given/When/Then in both name and body (`// Given`, `// When`, `// Then`
  comment markers), built on the `Fixture` class in `tests/wp.test.ts` which writes real
  files to a temp dir; CLI tests spawn `wp.ts` as a subprocess and assert exit codes, so
  `wp.ts` must remain the runnable entry point.
- Add a test per spec rule when touching `check` — the suite already has one per rule.
- tsconfig runs `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
  so indexed reads need `?? fallback` and optional properties cannot take `undefined`.
  Match the existing `?? ""` / `?? []` idiom rather than adding non-null assertions.
  `include` covers `wp.ts`, `src/**/*.ts` and `tests/**/*.ts` — a new module outside
  those globs escapes `typecheck` entirely and gives a false green.

### If a module outgrows its file

Split further only when a file earns it, not pre-emptively:

- `src/cli.ts` past ~250 lines → lift the argv grammar into `src/args.ts`.
- `src/render.ts` past ~150 lines → split by command.
- `WpGraph.requireWp` / the three `unknown work-package ID` throws (`src/graph.ts`,
  `src/transitions.ts`, `src/render.ts`) could be deduplicated by dropping `private`;
  deliberately left alone as it buys no behaviour. Same for `ancestors` vs the tree's
  `ancestorChain` — those two differ on purpose, see the comments on both.
