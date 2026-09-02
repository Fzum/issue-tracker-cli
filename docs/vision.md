# Vision — Agentic Issue Tracker (markdown-native)

Status: brainstorming. This file captures raw input + decisions so context is never lost.
Started: 2026-09-01

## 1. Core idea

A **super simple issue tracker for agentic workflows**, built entirely on
markdown files and their frontmatter. No database, no server, no web UI.
The filesystem *is* the tracker.

Guiding principles: **KISS / YAGNI**. Nothing gets built that isn't needed
by an actual agent workflow today.

## 2. Actors

- **BA agent (business analyst)** — given a vision, produces work packages
  (WP) as markdown files. Writes content, no relations yet.
- **Relation pass** — a second run spawns, per milestone, a subagent that
  walks each WP and fills in the `relates_to` frontmatter.
- **Implementer agents** — (implied) consume WPs to do the work and flip status.

## 3. Proposed folder structure

```
milestone-one/
  epic-one/
    wp-m1e1.md
    wp-m1e1u1.md
milestone-two/
  ...
```

Rationale: **traceability from the filename alone**. `wp-m1e1u1.md` reads as
"work package, milestone 1, epic 1, user story 1". Hierarchy is encoded in
both the path and the ID.

Open concern (raised by the author): this may already be too complicated.

## 4. Proposed frontmatter

```yaml
---
type: epic
relates_to:
  - name: wp-m1e1u1.md
    relation_type: is_parent_of
short_description: "llm friendly short description with the most relevant parts of the ticket"
---
<markdown body = the actual ticket content>
```

Must be parsable as YAML (and/or JSON).

## 5. Relation types (initial set)

- `is_blocked_by`
- `blocks`
- `is_parent_of`
- `is_child_of`

## 6. Possible mini CLI

A small deterministic tool that, given a WP, extracts:
- `short_description`
- `relations`
- `status`

Deterministic = no LLM in the read path. Agents call it instead of
re-reading and re-parsing files by hand.

## 7. Open questions (to work through one at a time)

1. Is the milestone/epic/story hierarchy needed at all, or is a flat WP list
   with parent links enough?
2. Filename-as-ID vs. explicit `id` in frontmatter — what happens on rename,
   reorder, insert-in-the-middle?
3. Are all four relation types needed on day one, or is one direction enough
   (derive the inverse)?
4. What is `status` — where does it live, what are the allowed values, who
   writes it?
5. Does the CLI need to exist at all in v1, or can agents just read files?
6. What does the BA agent actually emit, and what is the contract the
   relation pass depends on?
7. How is consistency checked (dangling relations, cycles, orphans)?

## 8. Decisions

_(appended as we settle each question)_

### D1 — The tracker is a work queue (2026-09-01)

Primary runtime question: **"what should I work on next?"** — an agent asks for
the next unblocked, not-done WP and starts on it.

Consequences:
- `status` and a dependency edge are the load-bearing schema.
- Parent/child hierarchy is navigation and human legibility, not machinery.
- Context assembly and progress reporting are secondary; they must fall out of
  the same files without extra schema.

### D2 — The filename stem is the ID (2026-09-01)

`milestone-1/epic-1/wp-m1e1u1.md` → ID is `wp-m1e1u1`. There is **no `id:` field**
in the frontmatter. One source of truth, greppable, path derivable from ID.

Accepted cost: inserting or reordering means renaming + rewriting references.
Mitigation (later, only if it hurts): a `wp mv` command that rewrites referrers.

Falls out of this: **parent/child never needs to be stored** — `wp-m1e1u1`'s
parent is `wp-m1e1`, i.e. the stem minus its last segment.

### D3 — `blocked_by` is the only stored relation (2026-09-01)

Frontmatter carries a flat list of IDs: `blocked_by: [wp-m1e1u2, wp-m2e1]`.

Everything else is derived at read time:
- `parent`   — stem minus last segment (`wp-m1e1u1` → `wp-m1e1`)
- `children` — stems that extend this one by exactly one segment
- `blocks`   — invert the `blocked_by` graph

Nothing is stored twice, so nothing can desync. The relation subagent has
exactly one job: for each WP, list what must land first.

Dropped from the original sketch: `blocks`, `is_parent_of`, `is_child_of`, and
the `{name, relation_type}` object shape.

### D4 — status: todo | doing | done (2026-09-01)

Three states. `doing` doubles as a claim so parallel agents don't grab the same WP.

Derived, never stored:
- `ready`   = status todo AND every `blocked_by` is done
- `blocked` = status todo AND some `blocked_by` is not done

Deferred (add only when it actually hurts): `owner`/`claimed_at` for stale-claim
recovery; `cancelled` as a terminal state that also satisfies `blocked_by`.

### D5 — Flat `wps/` folder, stem carries the hierarchy (2026-09-01)

```
wps/
  wp-m1.md          # milestone  (depth 1)
  wp-m1e1.md        # epic       (depth 2)
  wp-m1e1u1.md      # story      (depth 3)
  wp-m2.md
```

No nested directories. A milestone is just a WP that has children. `ls` shows
the whole tree in order. Path/stem drift is impossible because there is no path.

`type` is dropped from the frontmatter — it is stem depth.

### Schema after D1–D5

```yaml
---
status: todo            # todo | doing | done
blocked_by: [wp-m2e1]   # flat list of stems, may be empty
short_description: "llm-friendly summary of the ticket"
---
markdown body = the actual ticket
```

Three fields. Everything else is derived:
`type` ← depth · `parent` ← stem prefix · `children` ← stems extending it ·
`blocks` ← inverted graph · `ready`/`blocked` ← status + blocked_by

### D6 — The CLI is read-only in v1 (2026-09-01)

```
wp next          # the next ready WP (deterministic)
wp next --all    # the full ready queue
wp show <id>     # short_description, status, blocked_by,
                 # + derived parent / children / blocks
wp check         # dangling refs, cycles, bad status, unparseable frontmatter
```

No write commands. Agents flip `status` with a normal file edit — no locking,
no partial writes, nothing to corrupt. `wp check` catches any mangling.

Deferred until it actually hurts: `wp start`/`wp done` (atomic claim),
`wp new` (scaffold), `wp mv` (rename + rewrite referrers).

### D7 — Only leaves are work; containers are derived (2026-09-01)

A WP with children is a container (milestone, epic). Containers carry **no
`status` field**. Their state is computed:

- all children done → `done`
- any child doing, or some done and some not → `doing`
- otherwise → `todo`

`wp next` returns only leaf WPs. Ties break by stem sort, which walks the tree
depth-first in natural order (m1e1u1, m1e1u2, m1e2, m2e1...).

Progress rollup falls out for free — no extra schema.

### D8 — Single-file TypeScript on Bun (2026-09-01)

`issue-tracker-cli/wp.ts`, no runtime dependencies. The CLI is an independent
Bun project that can be opened directly in an IDE. Frontmatter is parsed as a
deliberate YAML *subset* (see spec) rather than through a package — a minimal
install in any agent sandbox, while keeping the whole tool readable and
patchable in one module. Development uses Bun's test runner and TypeScript for
static checks.

### D9 — `wp start` / `wp done` write; D6 stands otherwise (2026-09-02)

D6 deferred the write commands until agents demonstrably mangled YAML. They are
added early for a different reason: driving the loop by hand is the friction.
`wp next` hands over a WP, and marking it `doing` — the thing that makes the
epic and milestone above it read `doing` in `wp tree` — was a file edit the
agent had to get right. Now the loop is `wp next` → `wp start` → work →
`wp done`, entirely through the CLI.

What kept D6 honest is preserved. The commands rewrite one line and rename a
temp file over the original, so there is still nothing to corrupt, and they
build the graph first so they refuse a folder `wp check` would reject. Nothing
new is stored: `doing` was already a valid status and the rollup already derived
it, so this adds a writer, not a schema.

An unmet `blocked_by` target is the only thing `wp start` refuses on. A first
cut also refused when any other leaf was already `doing`, reading "one agent,
one WP at a time" as a rule to enforce. That was wrong: it is a statement about
how the human works, not an invariant of the tree, and enforcing it made two
independent epics interfere for no reason. Dependencies are the one thing the
tracker knows better than the caller, so they are the one thing it blocks on.
`--force` overrides even that.

Consequently the current status is not checked either — a `done` leaf reopens,
and any number of leaves may be `doing`. Nothing downstream cares: `wp next`
still offers only `todo` leaves, and the rollup still reports `doing` the moment
one child is. Claims stay unmodelled; `owner` / `claimed_at` remain deferred
until parallel agents make bare `doing` collide.

Still deferred: `wp new`, `wp mv`, a `cancelled` status, relation types beyond
`blocked_by`.

### D10 — The tracker is tooling; the work lives elsewhere (2026-09-02)

The goal all of the above serves, written down once so it stops being implicit.

**The end state.** Drop a vision into any repository. A BA agent turns it into
`wps/`, a relation pass fills in `blocked_by`, `wp check` passes, and an
orchestrator drains the queue in waves until every leaf is `done`. What comes out
is merged, tested code on `main` — not a report about what should have been built.

**Two places, never one.** `wp` is a tool, like `git` or `jq`: installed once,
pointed at a folder. It holds no work of its own. The `wps/` in this repository is
a fixture, nothing more. Real tickets live in the project they describe, next to
its code:

```
~/tools/issue-tracker-cli/   wp.ts, orchestrate.ts           the tooling
~/code/shop-api/             src/, wps/, prompts/worker.md    the work
```

Nothing in `wp.ts` knows about TypeScript or Bun — it knows filenames, three
frontmatter fields and three status values — so it drops into a Python or Rust
project unchanged. Each project brings exactly three things: its own `wps/`, a
`prompts/worker.md`, and a command that verifies the build.

**The missing actor.** §2 named the BA agent, the relation pass and implementer
agents. The one it lacked is the **orchestrator**: it owns `main` and `wps/`,
hands each ready leaf to a worker isolated in its own git worktree, and integrates
the branches serially. Workers never merge and never touch the tracker files.
`done` means merged and green, not "the agent reported success".

**No scheduler was needed.** Readiness is recomputed on every invocation, so
`wp next --all` already *is* the wave, and a dependency enforces itself by not
appearing in the queue. Likewise no prompt library is needed: `wp show <id>` is
the task half of a worker prompt, so the tickets the BA agent wrote were always
the prompts.

Still open: `orchestrate.ts` is not built, and the verify command it runs is
hardcoded rather than configured per project.

Full runbook: `docs/execution-model.md`.

---

## Outcome

All seven questions resolved. Full design: `docs/design.md`. How the queue is
actually run: `docs/execution-model.md`.
