# Agentic Issue Tracker CLI

A work-queue CLI over markdown files. The filesystem *is* the tracker — no
database, no server. TypeScript for Bun 1.0.29+, zero runtime dependencies.
`wp.ts` is the entry point; the implementation lives in `src/`.

The question it answers is: **what should an agent work on next?** `wp next`
answers it; `wp start` / `wp done` let the agent record the answer.

## Install

```sh
bun install
```

There is no build step. `wp.ts` is executable and runs straight from disk.

```sh
# From a project that has a wps/ directory:
/path/to/issue-tracker-cli/wp.ts next

# Or from this directory, pointing at the work packages:
bun run wp --dir /path/to/project/wps next
```

`bun run wp` only resolves from this directory. From anywhere else, call
`wp.ts` by absolute path.

## Quick start

Make a `wps/` directory with one markdown file per work package. The filename
is the ID:

```
wps/
├── wp-m1.md          Ship the CLI        (milestone, has children → no status)
├── wp-m1e1.md        Read path           (epic, has children → no status)
├── wp-m1e1u1.md      Parse frontmatter   status: done
├── wp-m1e1u2.md      Build the graph     status: todo, blocked_by: wp-m1e1u1
└── wp-m1e2.md        Write path          status: todo, blocked_by: wp-m1e1
```

Validate the directory, then look at it:

```console
$ wp check
$ wp tree
▶  Ship the CLI             0/2  wp-m1
▶  ├─ Read path             1/2  wp-m1e1
✔  │  ├─ Parse frontmatter       wp-m1e1u1
○  │  └─ Build the graph         wp-m1e1u2
○  └─ Write path                 wp-m1e2
```

`wp check` printing nothing means the directory is valid. Glyphs are `✔` done,
`▶` doing, `○` todo, `?` invalid. The `1/2` column is *direct children done /
total*, rolled up per container.

Ask what to work on, claim it, finish it:

```console
$ wp next
wp-m1e1u2	todo	Build the graph

$ wp start wp-m1e1u2
wp-m1e1u2	doing	Build the graph

$ wp done wp-m1e1u2
wp-m1e1u2	done	Build the graph
```

Containers update themselves, because their status is derived, not stored:

```console
$ wp tree
▶  Ship the CLI             1/2  wp-m1
✔  ├─ Read path             2/2  wp-m1e1
✔  │  ├─ Parse frontmatter       wp-m1e1u1
✔  │  └─ Build the graph         wp-m1e1u2
○  └─ Write path                 wp-m1e2
```

`wp-m1e2` was blocked by `wp-m1e1`; now that the epic rolls up to `done`, it is
ready and `wp next` returns it:

```console
$ wp next
wp-m1e2	todo	Write path
```

That is the whole loop.

## Commands

```
usage: wp [--dir PATH] [--json] {next,show,tree,check,start,done} ...
```

| Command | What it does | Extra flags |
|---|---|---|
| `wp next` | Print the first ready leaf as `id<TAB>status<TAB>description`. Prints nothing when the queue is empty. | `--all` prints the whole ready queue |
| `wp show ID` | Print every stored and derived field of one work package, then its body. | — |
| `wp tree` | Print the whole tree with status glyphs and `done/total` rollup counts per container. | — |
| `wp check` | Validate the directory and print one line per problem. | — |
| `wp start ID` | Claim a leaf by writing `status: doing`. | `--force` starts even when blocked |
| `wp done ID` | Release a claimed leaf by writing `status: done`. | `--force` skips the "must be doing" check |

Global options:

| Option | Meaning |
|---|---|
| `--dir PATH` | Work-package directory. Default `./wps`. `--dir=PATH` also works. |
| `--json` | Emit machine-readable JSON. Works with every command. Keys are sorted and non-ASCII is escaped — the shape is a stability contract for agent consumers. |
| `-h`, `--help` | Print the built-in help. |

Colour in `wp tree` is on for a TTY and off when `NO_COLOR` is set.

### `wp next`

Returns leaves only, in natural ID order. A leaf is ready when its own *and
every ancestor's* `blocked_by` targets are `done`.

```console
$ wp next
wp-m1e1u2	todo	Build the graph

$ wp next --json
{
  "id": "wp-m1e1u2",
  "short_description": "Build the graph",
  "status": "todo"
}

$ wp next --all --json
[
  {
    "id": "wp-m1e1u2",
    "short_description": "Build the graph",
    "status": "todo"
  },
  {
    "id": "wp-m1e3u1",
    "short_description": "Write the status line",
    "status": "todo"
  }
]
```

An empty queue prints nothing and still exits `0`. Use `--all --json` if you
want an explicit `[]`.

### `wp show ID`

```console
$ wp show wp-m1e1u2
id: wp-m1e1u2
short_description: Build the graph
status: todo
blocked_by: [wp-m1e1u1]
type: story
is_leaf: true
parent: wp-m1e1
children: []
blocks: []
ready: true


Notes go here in the body.
```

`--json` adds the body as a `body` key:

```console
$ wp show wp-m1e1u2 --json
{
  "blocked_by": [
    "wp-m1e1u1"
  ],
  "blocks": [],
  "body": "\nNotes go here in the body.\n",
  "children": [],
  "id": "wp-m1e1u2",
  "is_leaf": true,
  "parent": "wp-m1e1",
  "ready": true,
  "short_description": "Build the graph",
  "status": "todo",
  "type": "story"
}
```

### `wp tree`

`--json` gives a flat, pre-ordered list with a `depth` field instead of
glyphs, so consumers do not have to parse box drawing:

```console
$ wp tree
▶  Ship the CLI          1/2  wp-m1
✔  ├─ Parse frontmatter       wp-m1e1
○  └─ Build the graph         wp-m1e2

$ wp tree --json
[
  {
    "depth": 1,
    "id": "wp-m1",
    "short_description": "Ship the CLI",
    "status": "doing"
  },
  {
    "depth": 2,
    "id": "wp-m1e1",
    "short_description": "Parse frontmatter",
    "status": "done"
  },
  {
    "depth": 2,
    "id": "wp-m1e2",
    "short_description": "Build the graph",
    "status": "todo"
  }
]
```

Container `status` in this output is the derived rollup, not a stored field.
Here `wp-m1` reports `doing` because one child is `done` and one is `todo`.

### `wp check`

Exits `1` when it finds anything, `0` when clean. One input can trip several
rules on purpose — a self-dependency is both a self-reference and a cycle.

```console
$ wp check
notes.md: filename does not match wp-<segments>.md grammar
notes.md: frontmatter block missing
wp-m1.md: status present on container
wp-m1e1.md: blocked_by cycle: wp-m1e1
wp-m1e1.md: blocked_by references the WP itself
wp-m1e1.md: status must be one of todo, doing, done
$ echo $?
1
```

The 11 rules it applies:

1. Filename matches the `wp-<segments>.md` grammar
2. A frontmatter block is present and terminated
3. The frontmatter parses under the subset parser
4. `short_description` is present and non-empty
5. `status` is present on a leaf
6. `status` is absent on a container
7. `status` is one of `todo` / `doing` / `done`
8. Every `blocked_by` entry names a stem that has a file
9. No `blocked_by` entry names the work package itself
10. The `blocked_by` graph has no cycles
11. Every stem's parent has a file — no orphan in the middle of the tree

`check` is the only command that reads a broken directory. `next`, `show` and
`tree` refuse to build a graph at all and tell you to run it:

```console
$ wp next
wp: invalid work-package directory; run 'wp check': notes.md: frontmatter block missing; notes.md: invalid filename
```

### `wp start ID` and `wp done ID`

An unmet `blocked_by` target is the **only** thing `start` refuses on — not the
current status, and not another leaf already being `doing`:

```console
$ wp start wp-m1e2
wp: wp-m1e2 is blocked by wp-m1e1
$ echo $?
2

$ wp start wp-m1e2 --force
wp-m1e2	doing	Write path
```

`done` refuses a leaf that is not `doing`; `--force` overrides that. Starting
an already-`doing` leaf and finishing an already-`done` leaf are both no-ops.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, including an empty queue |
| `1` | Only from `wp check`, when it found problems |
| `2` | Usage error, unknown ID, or unreadable directory |

## The file format

One markdown file per work package, in the work-package directory:

```markdown
---
status: todo
short_description: Parse the frontmatter subset
blocked_by:
  - wp-m1e1u1
---

Free-form body. Notes, acceptance criteria, whatever you want.
```

Rules that shape everything else:

- **The filename stem is the ID.** `wp-m1e1u1.md` → `wp-m1e1u1`. There is no
  `id:` field. Grammar: `wp-` then one or more `[a-z][0-9]+` segments.
- **Only three fields are stored:** `status` (`todo` | `doing` | `done`, leaves
  only), `blocked_by` (flat list of stems), `short_description`. Unknown keys
  are kept but ignored.
- **Everything else is derived:** parent (stem minus last segment), children,
  `blocks` (inverted `blocked_by`), type by depth (milestone → epic → story →
  task), container status (rollup over children), and `ready`.
- **Leaves are work; containers are derived.** A work package with children
  carries no `status`. `wp next` returns leaves only.
- **Readiness includes ancestors.** A leaf is ready when its own *and every
  ancestor's* `blocked_by` targets are `done`.
- **Sort order** is natural by segment, so `wp-m2` comes before `wp-m10`.

Hierarchy comes from the ID alone: `wp-m1e1u2`'s parent is `wp-m1e1`, whose
parent is `wp-m1`. Nothing records it.

The frontmatter parser is a deliberate YAML *subset*. Nested maps, multiline
scalars, anchors and flow mappings raise an error rather than being silently
misread, because a misparsed `blocked_by` would corrupt the queue.

`wp start` / `wp done` are the only write path. They replace a single existing
`status:` line via temp file + rename, and never re-serialize your frontmatter.
Editing `status` by hand stays fine. `wp new` and `wp mv` are deliberately not
implemented.

## Development

```sh
bun install
bun test                            # all tests
bun test -t "given a self edge"     # one test by name substring
bun run typecheck                   # tsc --noEmit
```

`bun test` plus `bun run typecheck` are the whole verification gate. There is
no build step and no linter. Tests are Given/When/Then in both name and body,
and write real files to temp dirs.

## Docs

- [`docs/design.md`](docs/design.md) — approved design: field reference,
  derivation rules, the 11 `wp check` rules, the `start`/`done` guards, exit
  codes.
- [`docs/vision.md`](docs/vision.md) — brainstorming plus the decision log
  D1–D9. Read it before questioning a constraint; most surprising choices are
  deliberate.
- [`CLAUDE.md`](CLAUDE.md) — guidance for agents working on this repo.
