# Design — Agentic Issue Tracker (markdown-native)

Date: 2026-09-01
Status: approved for planning
Source: `vision.md` (raw input + decision log D1–D8)

## 1. Purpose

A work queue for agentic workflows, stored entirely as markdown files. The
filesystem is the tracker: no database, no server, no web UI.

The primary runtime question is **"what should I work on next?"** An agent asks
for the next unblocked work package and starts on it. Context assembly and
progress reporting must fall out of the same files without additional schema.

### Non-goals

- Human-facing UI of any kind
- Multi-project support, users, permissions, comments, attachments
- History or audit trail beyond what git already gives
- Any write path beyond `wp start` / `wp done` flipping a leaf's `status` (§6)

## 2. Layout

One flat directory. Every work package is one file.

```
issue-tracker-cli/
  README.md
  package.json
  tsconfig.json
  wp.ts
  tests/
    wp.test.ts
wps/
  wp-m1.md
  wp-m1e1.md
  wp-m1e1u1.md
  wp-m1e1u2.md
  wp-m1e2.md
  wp-m2.md
```

No nested folders. A milestone is simply a WP that has children, so `ls` prints
the whole tree in order and no path can contradict a filename.

### 2.1 Stem grammar

A filename is `wp-` followed by one or more segments, then `.md`. A segment is
one lowercase letter followed by one or more digits.

```
stem    := "wp-" segment+
segment := [a-z][0-9]+
```

`wp-m1e1u1` has segments `m1`, `e1`, `u1` — depth 3. The ID of a WP is its stem
without the `.md` extension (`wp-m1e1u1`); this is what relations reference.
There is no `id` field in the frontmatter.

Depth maps to a label for display only: 1 = milestone, 2 = epic, 3 = story,
4+ = task. The label carries no behaviour — only leaf-vs-container does.

## 3. File format

### Leaf (a WP with no children — actual work)

```markdown
---
status: todo
blocked_by: [wp-m1e1u1, wp-m2e1]
short_description: "Validate the login form client-side before submit"
---

## Context
Free-form markdown body: the actual ticket.
```

### Container (a WP with children — milestone, epic)

```markdown
---
short_description: "Milestone 1: authentication"
---

Free-form markdown body.
```

### Field reference

| Field | Where | Required | Meaning |
|---|---|---|---|
| `status` | leaves only | yes | `todo` \| `doing` \| `done` |
| `blocked_by` | any | no (defaults `[]`) | flat list of stems that must be done first |
| `short_description` | any | yes | one-line LLM-friendly summary |

`status` on a container is an error (§7). `blocked_by` on a container is legal
and applies to the container as a whole; see §5.

## 4. Derived values

Nothing below is ever stored. Storing it would let it drift from the truth.

| Derived | Rule |
|---|---|
| `type` | stem depth |
| `is_leaf` | no other stem extends this one |
| `parent` | stem minus its last segment; depth-1 stems have none |
| `children` | stems extending this one by exactly one segment |
| `blocks` | inversion of the `blocked_by` graph |
| `ready` | leaf AND `status: todo` AND every `blocked_by` target resolves done |
| container status | rollup, below |

### 4.1 Container status rollup

Over a container's **direct** children (each child itself resolved by this rule,
so it recurses):

- every child `done` → `done`
- else any child `doing`, or at least one `done` → `doing`
- else → `todo`

A container with no children cannot occur — a WP with no children is a leaf by
definition, and therefore carries a written `status`.

### 4.2 Resolving a `blocked_by` target

A target's status is its written `status` if it is a leaf, or its rolled-up
status if it is a container. A container target is done only when every
descendant is done. This makes "block this story on all of milestone 2" a
one-line dependency.

## 5. Ready and ordering

A WP is **ready** when all of:

1. it is a leaf,
2. its `status` is `todo`,
3. every stem in its own `blocked_by` resolves to `done`,
4. every stem in any **ancestor's** `blocked_by` resolves to `done`.

Rule 4 is what makes container-level `blocked_by` mean anything: blocking an
epic blocks every story inside it.

Ordering is **natural sort of the stem** — segments compared by letter, then by
numeric value, so `wp-m2` sorts before `wp-m10`. This walks the tree
depth-first in the order a reader expects. `wp next` returns the first ready WP
in that order; ties cannot occur because stems are unique.

## 6. CLI

`issue-tracker-cli/wp.ts` — single-file TypeScript CLI for Bun 1.0+, with no
runtime dependencies. From `issue-tracker-cli/`, run as `bun run wp <cmd>`,
`bun wp.ts <cmd>`, or `./wp.ts <cmd>` via shebang. Every command except
`wp start` / `wp done` is read-only; those two rewrite exactly one line (§6.1).
Agents may still flip `status` with an ordinary file edit.

Commands operate on `./wps` by default; `--dir <path>` overrides.
Every command accepts `--json` for machine consumption.

### `wp next [--all]`

Prints the next ready WP as `<id>\t<status>\t<short_description>`. With
`--all`, prints the entire ready queue in order. Empty queue prints nothing and
exits 0.

### `wp show <id>`

Prints stored fields plus every derived value: type, parent, children, blocks,
ready, and (for a container) rolled-up status. Unknown id exits 2.

### `wp tree`

Prints the whole set as an indented tree with rolled-up status per node. This is
the progress view; it needs no schema of its own.

### `wp check`

Validates the folder (§7). Prints one line per problem as
`<file>: <problem>`. Exits 1 if any problem was found, 0 if clean.

### `wp start <id> [--force]`

Claims a leaf by writing `status: doing`, then prints the `wp next` row. Guards,
first failure wins:

1. unknown id → exit 2
2. already `doing` → prints the row, exits 0 (idempotent; re-running is safe)
3. not a leaf → exit 2, `<id> is a container; only leaves carry status`
4. another leaf is `doing` → exit 2, `<other> is already doing`
5. not ready (§5) → exit 2, naming the unmet `blocked_by` targets, or the
   current status when it is not `todo`

`--force` skips 4 and 5 only. Guard 4 encodes the one-agent-one-WP rule (D9);
it scans every leaf, so concurrent agents need `--force` until claims are
modelled properly.

### `wp done <id> [--force]`

Releases a claimed leaf by writing `status: done`, then prints the row. Unknown
id → exit 2; already `done` → prints and exits 0; not a leaf → exit 2; not
currently `doing` → exit 2, `<id> is <status>, not doing; start it first`.
`--force` skips the last check only.

### 6.1 How the write works

Both commands build the graph through the normal read path first, so they refuse
to touch a directory that `wp check` would reject. The write then locates the
frontmatter block the way the parser does, replaces the single `status:` line
(preserving its line ending), and never inserts the field — a leaf missing
`status` is not `ready`, so the guards reject it first. The result goes to a
temporary file in the same directory and is `rename`d over the original, so a
torn write cannot leave a corrupt WP. Body, comments, unknown keys, key order
and CRLF endings all survive byte-for-byte.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success (including "queue is empty") |
| 1 | `wp check` found problems |
| 2 | usage error, unknown id, or unreadable directory |

## 7. Validation rules (`wp check`)

1. Filename does not match the stem grammar (§2.1)
2. Frontmatter block missing or unterminated
3. Frontmatter is not parseable by the subset parser (§8.1)
4. `short_description` missing or empty
5. `status` missing on a leaf
6. `status` present on a container
7. `status` not one of `todo` / `doing` / `done`
8. `blocked_by` entry references a stem with no file
9. `blocked_by` entry references the WP itself
10. `blocked_by` graph contains a cycle (report the cycle's members)
11. A stem's parent has no file — e.g. `wp-m1e1u1.md` exists but `wp-m1e1.md`
    does not, leaving an orphan in the middle of the tree

Rule 11 keeps the derived hierarchy total: every non-root stem has a real parent.

## 8. Implementation notes

Single module, functions grouped by responsibility so each can be tested alone:

- **parse** — read a file, split frontmatter, produce a `Wp` record
- **graph** — build the stem index, derive parent/children/blocks, detect cycles
- **query** — `ready`, rollup, natural sort
- **check** — the rules in §7
- **cli** — argument dispatch and output formatting

No index file and no cache: the folder is re-scanned on every invocation. At the
scale this targets (hundreds of files) that is a few milliseconds, and it means
there is no stale state to invalidate.

### 8.1 Frontmatter parsing

The parser accepts a deliberate subset of YAML — exactly the three fields in §3
and nothing else:

- The block is delimited by a line `---` at the very start of the file and a
  following line `---`.
- Each line inside is `key: value`. Blank lines and `#` comments are skipped.
- `status` and `short_description` take a scalar; surrounding single or double
  quotes are stripped.
- `blocked_by` accepts either inline `[a, b]` or a YAML block list:
  ```yaml
  blocked_by:
    - wp-m1e1u1
    - wp-m2e1
  ```
- Any other key is preserved but ignored, so adding a field later is not a
  breaking change.
- Anything else — nested maps, multiline scalars, anchors — is a parse error
  surfaced by `wp check` rule 3, not silently misread.

This is a documented constraint on what the BA agent may emit, not an attempt to
implement YAML. Making the failure loud is the point: a silently misparsed
`blocked_by` would corrupt the queue.

## 9. Agent workflow

### Pass 1 — BA agent

Reads the vision, writes `wps/*.md`. Sets `short_description`, `status: todo`
on leaves, and the body. Expresses the entire hierarchy through its choice of
stems. Writes no dependencies — `blocked_by` is omitted or `[]`.

### Pass 2 — relation agent

One subagent per milestone, filling in `blocked_by`.

Each subagent receives **the full stem list with every `short_description`** —
one line per WP, cheap enough to pass entirely — but may only write files whose
stem starts with its own milestone segment. Reading globally lets it express
cross-milestone dependencies; writing locally means two subagents can never
touch the same file.

Both passes are followed by `wp check`. A non-zero exit means the pass is
rejected and rerun; agents never proceed on an invalid folder.

## 10. Deliberately deferred

Each of these is easy to add later precisely because nothing above depends on
its absence:

| Deferred | Add when |
|---|---|
| `owner` / `claimed_at` | enough parallel agents that bare `doing` collides |
| `cancelled` status | the BA agent over-generates and scope cuts wedge the queue |
| `wp new` / `wp mv` | renumbering on insert becomes a real cost |
| relation types beyond `blocked_by` | a second edge type earns its keep |
| index or cache | a scan is measurably too slow |

## 11. Known risks

- **Renumbering cascade.** Inserting an epic mid-milestone renames every
  downstream stem and every reference to it. Accepted in D2; `wp mv` is the
  escape hatch if it bites.
- **Stem depth as type.** Adding a level between epic and story means restemming
  that subtree. Acceptable while the BA agent generates the tree in one pass.
- **Subset parser vs. LLM output.** A BA agent may emit valid YAML the parser
  rejects. Mitigated by rule 3 firing loudly and by the pass-then-check loop;
  if it recurs, swap in pyyaml behind the same `parse` interface.

## 12. Test plan

Unit tests per group in §8, over a fixture folder:

- parse: valid leaf, valid container, both `blocked_by` forms, each parse error
- graph: parent/children derivation, `blocks` inversion, cycle detection
  (self-edge, 2-cycle, longer cycle)
- query: rollup at each state, ancestor-blocking (rule 4), natural sort
  (`m2` before `m10`), empty ready queue
- check: one test per rule in §7, plus a clean folder exiting 0
- write: byte-for-byte preservation (extra keys, comments, CRLF, no trailing
  newline), and refusal to insert a missing `status`
- start/done: one test per guard in §6, plus `--force` overriding each
- cli: exit codes, `--json` shape stability

The suite uses Bun's built-in test runner and Given/When/Then test structure.
Run it from `issue-tracker-cli/` with `bun test`.
