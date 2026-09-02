# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a standalone repository. Everything it needs is inside it:

| Path | What it is |
|---|---|
| `wp.ts` | The entire CLI (~980 lines, zero runtime dependencies) |
| `tests/wp.test.ts` | The whole suite — Given/When/Then, real files in temp dirs |
| `docs/design.md` | The approved design: field reference, derivation rules, the 11 `wp check` rules, the `start`/`done` guards, exit codes |
| `docs/vision.md` | Raw brainstorming plus the decision log D1–D9, with the rationale for every constraint below |

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

There is no build step and no lint config; `bun test` + `bun run typecheck` are the full
verification gate. `bun run wp` only resolves from this directory — from anywhere else,
invoke `wp.ts` by absolute path.

## What this is

A work-queue CLI over markdown files. The filesystem *is* the tracker — no database,
no server. The primary runtime question it answers is "what should an agent work on
next?"; `wp start` / `wp done` then let the agent answer it without hand-editing.

## Architecture

`wp.ts` is organised as a pipeline of exported groups that are each testable alone:

`parseFrontmatter` / `parseWp` → `scanDirectory` → `WpGraph` → `check` → CLI printers → `main`

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

Ordering everywhere is `compareWpIds` — natural sort by segment letter then numeric
value, so `wp-m2` precedes `wp-m10`. Never fall back to lexicographic sort on IDs.

Exit codes: `0` success (including an empty queue), `1` only from `wp check` finding
problems, `2` usage error / unknown ID / unreadable directory. `WpError` subclasses are
what `main` converts into exit 2; anything else propagates as a crash.

One input can legitimately produce several problems — a self-dependency trips both the
self-reference rule and the cycle rule, and a stray non-WP file trips both the filename
rule and the frontmatter rule. The spec numbers these separately; don't "fix" the
duplication by collapsing rules.

### JSON output

`--json` goes through `jsonText`, which recursively sorts object keys and escapes
non-ASCII. The shape is a stability contract for agent consumers — CLI tests assert on
it directly.

## Conventions

- Tests are Given/When/Then in both name and body (`// Given`, `// When`, `// Then`
  comment markers), built on the `Fixture` class in `tests/wp.test.ts` which writes real
  files to a temp dir; CLI tests spawn `wp.ts` as a subprocess and assert exit codes.
- Add a test per spec rule when touching `check` — the suite already has one per rule.
- tsconfig runs `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
  so indexed reads need `?? fallback` and optional properties cannot take `undefined`.
  Match the existing `?? ""` / `?? []` idiom rather than adding non-null assertions.
