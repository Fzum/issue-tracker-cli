# Agentic Issue Tracker CLI

A work-queue CLI over markdown files, plus the loop that runs it. The filesystem
*is* the tracker — no database, no server. TypeScript for Bun 1.0.29+, zero
runtime dependencies.

The question it answers is: **what should an agent work on next?** `wp next`
answers it; `wp start` / `wp done` let the agent record the answer.

| Entry point | What it is |
|---|---|
| `wp.ts` | The tracker. Ask what is ready, claim it, finish it. Implementation in `src/`. |
| `orchestrate.ts` | The loop. Hands every ready work package to its own agent in its own git worktree, then merges the branches back one at a time. |

Both are tools, like `git` or `jq`: installed once, then pointed at a project.
They hold no work of their own. A project brings three things — its own `wps/`,
a `prompts/worker.md`, and a command that verifies its build.

## Install

Clone it once. There is no build step and no runtime dependency, so `wp.ts` and
`orchestrate.ts` run straight from disk.

```sh
git clone https://github.com/Fzum/issue-tracker-cli.git ~/tools/issue-tracker-cli
```

Then, in every project that should get a queue:

```console
$ cd ~/projects/my-thing
$ ~/tools/issue-tracker-cli/install.sh
issue-tracker-cli -> /home/you/projects/my-thing

  + wps/
  + prompts/worker.md (from the template — edit it)
  + log/ in .gitignore
  + /home/you/.local/bin/wp -> /home/you/tools/issue-tracker-cli/wp.ts
  + /home/you/.local/bin/orchestrate -> /home/you/tools/issue-tracker-cli/orchestrate.ts
  = wp check: clean

Next:
  /plugin install /home/you/tools/issue-tracker-cli
      in Claude Code, for the planning skills: /vision /architecture /breakdown
  wp tree
  orchestrate --dry-run --verify "<the command that verifies your build>"
```

Those are the three things a project must bring, plus the two steps a shell
script cannot take for you: installing the plugin is a Claude Code command, and
choosing the verify command is your call.

`+` changed something, `=` was already in place, `!` wants a human — a bin
directory that is not on your `PATH`, a `wp` link that points at something else,
a missing `git init`, or `wp check` reporting problems. Nothing is overwritten:
a `prompts/worker.md` of your own is kept, `log/` is added to `.gitignore` once,
and every step skips itself when it is already done. So running it again after a
`git pull` is safe.

| Option | Meaning |
|---|---|
| `--dry-run` | Report the same lines and write nothing. |
| `-h`, `--help` | Print the built-in help. |
| `WP_BIN_DIR` | Where the two symlinks go. Default `$HOME/.local/bin`. |

| Code | Meaning |
|---|---|
| `0` | Installed |
| `1` | Installed, but `wp check` found problems in an existing `wps/` |
| `2` | Refused: no `bun`, or the current directory is the clone itself |

### Without the installer

The installer only creates files and symlinks. Both entry points work by
absolute path with nothing installed at all:

```sh
# From a project that has a wps/ directory:
/path/to/issue-tracker-cli/wp.ts next
/path/to/issue-tracker-cli/orchestrate.ts --dry-run

# Or from the clone, pointing at the work packages:
bun run wp --dir /path/to/project/wps next
```

`bun run wp` only resolves from the clone. From anywhere else, call `wp.ts` by
absolute path. `orchestrate.ts` always runs in the project whose queue it
drains, because that is the git repository it merges into.

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
⊘  └─ Write path                 wp-m1e2    ← wp-m1e1
```

`wp check` printing nothing means the directory is valid. Glyphs are `✔` done,
`▶` doing, `○` todo, `?` invalid. The `1/2` column is *direct children done /
total*, rolled up per container.

`⊘` means "cannot start yet", and `←` names what it waits for. `Write path`
waits for the whole `Read path` epic. `Build the graph` waits for
`Parse frontmatter`, which is already `done`, so it shows a plain `○` — only
unfinished dependencies are listed.

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

`wp-m1e2` was blocked by `wp-m1e1`; now that the epic rolls up to `done`, its
`⊘` is gone, it is ready, and `wp next` returns it:

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
| `wp tree` | Print the whole tree with status glyphs, `done/total` rollup counts per container, and `⊘ … ←` for anything that cannot start yet. | — |
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
▶  Ship the CLI          1/3  wp-m1
✔  ├─ Parse frontmatter       wp-m1e1
⊘  ├─ Build the graph         wp-m1e2  ← wp-m1e3
○  └─ Print the tree          wp-m1e3

$ wp tree --json
[
  {
    "depth": 1,
    "id": "wp-m1",
    "short_description": "Ship the CLI",
    "status": "doing",
    "unmet_blockers": []
  },
  {
    "depth": 2,
    "id": "wp-m1e1",
    "short_description": "Parse frontmatter",
    "status": "done",
    "unmet_blockers": []
  },
  {
    "depth": 2,
    "id": "wp-m1e2",
    "short_description": "Build the graph",
    "status": "todo",
    "unmet_blockers": [
      "wp-m1e3"
    ]
  },
  {
    "depth": 2,
    "id": "wp-m1e3",
    "short_description": "Print the tree",
    "status": "todo",
    "unmet_blockers": []
  }
]
```

Container `status` in this output is the derived rollup, not a stored field.
Here `wp-m1` reports `doing` because one child is `done` and two are `todo`.

`unmet_blockers` is the same list the `⊘` line shows: the WP's own `blocked_by`
plus every ancestor's, minus whatever is already `done`. It is what `wp start`
refuses on, so an empty list means "startable".

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

## Running the queue with agents

`wp next --all` answers "what can be picked up right now". `orchestrate.ts` acts
on that answer: one agent per ready work package, each in its own git worktree,
then the branches are merged back one at a time.

```sh
cd /path/to/project                          # the repo with wps/ in it
/path/to/issue-tracker-cli/orchestrate.ts --dry-run   # print wave 1 and stop
/path/to/issue-tracker-cli/orchestrate.ts             # drain the queue
```

Nothing is planned ahead. Readiness is recomputed by `wp next` every round, so a
dependency enforces itself by simply not appearing in the queue. That is why no
wave graph is needed and no scheduler exists.

```
MAIN WORKTREE — the orchestrator lives here, on main, and owns wps/
     │
     │   wave = wp next --all  →  [u1, u2, u3],  then wp start on each
     │
 ┌───┴─────────────┬─────────────────┐          git worktree add, one per agent
 wt-u1           wt-u2            wt-u3
 wp/u1           wp/u2            wp/u3
 agent           agent            agent         edits, runs the gate, commits
 └───┬─────────────┴─────────────────┘
     │   agents report back, then stop
     ▼
 back in main, one branch at a time, never in parallel:
     git merge --no-ff wp/u1 && <verify>  → green → wp done u1
     git merge --no-ff wp/u2 && <verify>  → RED   → merge undone, branch kept
```

### One wave, step by step

1. `wp next --all --json` → the ready leaves. Empty means the queue is drained.
2. `wp start <id>` for each of them, in the main worktree. Claiming is what makes
   the loop terminate: a `doing` leaf is never offered again.
3. `git worktree add ../wt-<id> -b wp/<id>` per agent, plus `bun install` when the
   project has a `package.json`.
4. `claude -p "<role + wp show <id>>"` inside that worktree — all of them at once.
5. Then, serially per branch: `git merge --no-ff` → the verify command →
   `wp done <id>` → drop the worktree and the branch.

### The four rules

1. **The orchestrator owns `main` and `wps/`.** Agents never touch the tracker,
   so status changes cannot conflict — otherwise the most frequent conflict of
   all, since every wave writes them.
2. **One agent = one worktree = one branch = one work package.** A private tree
   is what lets an agent run the suite and believe the result.
3. **Merge serially, never in parallel.** This is what buys back attribution: if
   the gate goes red, it is the branch just merged, because nothing else changed.
4. **`done` means merged and green** — not "the agent reported success". So
   `wp tree` shows integrated reality rather than optimism.

### The prompt is the ticket

No prompt is written per work package. Each agent gets two halves glued together:

```
prompts/worker.md   the role, hand-written once per project:
        +           how to work here, run the gate, commit, never touch wps/
wp show wp-m1e2u3   the task, written by whoever wrote the ticket
        =
the prompt for one agent
```

`--role PATH` points at a different role prompt. This repository ships one you
can copy as a template.

### When something breaks

| What happened | What the orchestrator does |
|---|---|
| Merge conflict | `git merge --abort`, keep the branch, carry on with the next one. Those two work packages overlapped in the code; add a `blocked_by` between them and they land in different waves next time. |
| Gate red after a merge | Undo the merge (`git reset --keep ORIG_HEAD`), keep the branch, never call `wp done`. Without the undo, every later branch in the wave would inherit the red gate and get blamed for it. |
| Agent dies | The work package stays `doing` and its branch survives. Nothing is lost. |
| Agent committed nothing | The branch is refused before the merge. Merging it would be a no-op, so `wp done` would claim work that never landed. |

A work package left at `doing` **will not come back in the queue** — `wp next`
offers only `todo` leaves. Reopening it means editing the `status:` line by hand.
Keep its worktree until it is genuinely done.

Agent output goes to `log/<id>.log`, one file per work package.

### Options and exit codes

| Option | Meaning |
|---|---|
| `--dir PATH` | Work-package directory. Default `./wps`. |
| `--role PATH` | Worker role prompt. Default `./prompts/worker.md`. |
| `--verify COMMAND` | The gate a merge must pass, run through `sh -c`, so `&&` works. Default `bun test`. For this repository: `--verify "bun test && bun run typecheck"`. |
| `--dry-run` | Print the first wave's plan and stop. Claims nothing, spawns nothing, merges nothing. |

| Code | Meaning |
|---|---|
| `0` | The queue drained and everything merged green |
| `1` | The queue drained, but something is left for a human |
| `2` | Usage error, or the repository was not ready |

"Not ready" means: not a git repository, `claude` not on `PATH`, no role prompt,
or the worktree is not clean — every wave merges into this worktree and runs the
gate here. Unstaged edits under `wps/` and `log/` are fine, because they are the
orchestrator's own bookkeeping. **Anything staged is refused, wherever it is**:
`git merge` will not run while the index differs from `HEAD`, even for a file the
merge never touches, so starting would mean paying for a wave of agents and then
failing every merge.

### Deliberate limits

- A wave spawns **everything** the queue offers. There is no cap and no worker
  pool: tracking in-flight work costs more than the idle time at the end of a
  wave.
- Nothing times out an agent that hangs.
- `doing` is not a lock. One orchestrator handing out distinct IDs cannot hand
  the same ID out twice, so two orchestrators at once is the unsupported case.
- Agents are spawned with `--permission-mode acceptEdits`, which covers file
  edits only. Running the gate and committing are `Bash`, so `Bash` must be
  allowed in your Claude Code settings — otherwise an agent edits, never commits,
  and its empty branch is refused at merge time.
- Cleanup is `git worktree remove --force`. By then the work is merged and green,
  so anything left in the worktree is junk; without `--force`, one stray file
  would keep the worktree and block that ID from ever running again.

[`docs/execution-model.md`](docs/execution-model.md) is the full runbook, with
the reasoning and the list of what is deliberately not built.

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
and write real files to temp dirs. `tests/` holds one file per concern for the
tracker, plus `tests/orchestrate.test.ts` for the loop — the wave and merge order
against a fake driver, and the command line against a throwaway git repository.

## Docs

- [`docs/design.md`](docs/design.md) — approved design: field reference,
  derivation rules, the 11 `wp check` rules, the `start`/`done` guards, exit
  codes.
- [`docs/execution-model.md`](docs/execution-model.md) — the runbook the loop
  implements: the wave, worktree isolation, serial merge, failure handling.
- [`docs/vision.md`](docs/vision.md) — brainstorming plus the decision log
  D1–D11. Read it before questioning a constraint; most surprising choices are
  deliberate.
- [`CLAUDE.md`](CLAUDE.md) — guidance for agents working on this repo.
