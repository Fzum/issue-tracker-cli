# Execution model — running the queue with parallel agents

Date: 2026-09-02
Status: adopted
Source: `design.md` (the CLI), `vision.md` D9 (why `start`/`done` write)

## 1. What this answers

`design.md` answers *"what should I work on next?"*. This document answers
*"how do several agents work at once without stepping on each other?"*

The short version: **the tracker is already the scheduler.** No plan is computed,
nothing new is stored, no command is added. This is a runbook, not a feature.

## 2. The idea

The tree is not a plan. It is a bowl of tickets.

`wp next --all` means "which tickets can be picked up *right now*". Hand each one
to an agent. When they finish, look in the bowl again — new tickets are in there,
because finishing unlocked them. Repeat until the bowl is empty.

No wave planning is needed because **readiness is recomputed from scratch on every
invocation** (§5 of `design.md`). You never need to know the future; you only need
to know "now". A dependency enforces itself by simply not appearing in the queue.

In-flight work excludes itself for free: `wp next` returns only `todo` leaves, and
a claimed leaf is `doing`.

## 3. The wave loop

Spawn everything the queue offers, wait for all of it, then re-query.

```sh
while :; do
  ids=$(wp next --all --json | grep '"id"' | cut -d'"' -f4)
  [ -z "$ids" ] && break
  printf '%s\n' "$ids" | while read -r id; do
    # wp start <id>, spawn an agent for <id>
  done
  # wait for the whole wave, then integrate (§6)
done
```

Use `while read -r id`, not `for id in $ids`: zsh does not word-split unquoted
parameters, so the `for` form hands the whole list to one agent.

On the sample tree in `wps/` this drains in two rounds:

```
round 1: spawn 4 agents -> wp-m1e1u1 wp-m1e1u2 wp-m1e2u1 wp-m1e2u2
round 2: spawn 1 agents -> wp-m1e2u3
round 3: queue empty -> stop
```

Nobody computed that `wp-m1e2u3` goes second. It was not in the bowl during round 1.

A worker pool (refill as each agent frees up) is the obvious refinement and is
deliberately not used: it requires tracking which IDs are in flight, and at this
queue size the idle time is worth nothing.

## 4. Why worktrees

The tracker knows dependencies between *tickets*, not between *files*. Two WPs can
be fully independent in the tree and both want to edit `cart.ts`.

Encoding that as `blocked_by` up front does not work: stories are written before
anyone knows what files will exist. Foresight is unavailable — so isolate instead.

The damage in a shared working tree is not mainly clobbered edits. It is **lost
attribution**: several agents running the suite against each other's half-finished
changes, where no failure can be traced to a cause, and agents start "fixing" work
that is not theirs. One worktree per agent restores a private tree, so a worker can
run `bun test` and believe the result.

## 5. Roles and flow

```
   MAIN WORKTREE  —  the orchestrator lives here, on main
   repo/
     wps/        <-- ONLY the orchestrator ever writes these
     src/
        |
        |  wave = wp next --all  ->  [u1, u2, u3]
        |  wp start u1, u2, u3   (orchestrator, in main)
        |
   ┌────┴──────────────┬───────────────────┐
   │                   │                   │
 wt-u1               wt-u2               wt-u3     git worktree add
 branch wp/u1        branch wp/u2        branch wp/u3
 agent A             agent B             agent C
 edits               edits               edits
 bun test  (own tree, own result)  ...     ...
 commits             commits             commits
   │                   │                   │
   └────┬──────────────┴───────────────────┘
        |  agents report back, then stop
        v
   ORCHESTRATOR, back in main — one at a time, never parallel:

     git merge wp/u1 && bun test   -> green -> wp done u1
     git merge wp/u2 && bun test   -> green -> wp done u2
     git merge wp/u3 && bun test   -> RED   -> u3 is the culprit, unambiguously
                                              hand back / fix / leave it doing
        |
        v
   git worktree remove …   ->   next wave
```

## 6. The four rules

1. **The orchestrator owns `main` and `wps/`.** Agents never touch the tracker
   files, so status changes cannot conflict — otherwise the most frequent conflict
   of all, since every wave writes them.
2. **One agent = one worktree = one branch = one WP.** No exceptions.
3. **Merge serially, never in parallel.** This is what buys back attribution: if
   the suite goes red, it is the branch just merged, because nothing else changed.
4. **`done` means merged and green** — not "the agent reported success". So
   `wp tree` shows integrated reality rather than optimism.

Per agent:

```sh
git worktree add ../wt-<id> -b wp/<id>
cd ../wt-<id> && bun install
# agent works here; its brief is `wp show <id>` (description + body)
```

Per wave, back in main, one branch at a time:

```sh
git merge --no-ff wp/<id> && bun test && wp done <id>
git worktree remove ../wt-<id> && git branch -d wp/<id>
```

## 7. Failure handling

- **Merge conflict.** Those two WPs overlapped in the code. Resolve it in the
  orchestrator, or hand the branch back to an agent. Then record the lesson:
  `blocked_by` between them chains them into different waves next time. Foresight
  was unavailable; hindsight is not.
- **Suite red after a merge.** Do not call `wp done`. Keep the branch and retry.
- **Agent dies.** The WP stays `doing` and its branch survives. Nothing is lost.

One sharp edge: a WP stuck at `doing` **will not come back in the queue**, because
`wp next` returns only `todo` leaves. There is no `wp reset` — reopening means
editing the `status:` line by hand (or `wp start` on it again, which is a no-op).
Keep the worktree until the WP is genuinely done.

## 8. Implementing the orchestrator

`orchestrate.ts` is built. This section records the intended shape; §8.4 records
where the built thing goes further than the sketch, and why.

### 8.1 The prompt is the WP

You never write a prompt per WP. The WP *is* the prompt.

`wp show <id>` prints the description plus the markdown body — what the BA agent
wrote the ticket for. A worker's prompt is two halves glued at spawn time:

- **Role** — fixed, one hand-written `prompts/worker.md`, identical for every
  worker: how to work here, run the suite, commit at the end, never touch `wps/`,
  report back.
- **Task** — `wp show <id>` output. Already written, already in git.

```
prompts/worker.md   (role, hand-written once)
        +
wp show wp-m1e2u3   (task, written by the BA agent)
        =
the prompt for one agent
```

The tracker does not feed IDs to a program that then invents instructions. The
tickets were always the prompts; the loop delivers them.

### 8.2 Language

TypeScript on Bun, in `orchestrate.ts` next to `wp.ts`.

1. Same runtime as the CLI (D8). No new toolchain, and Bun's shell is built in, so
   still zero dependencies.
2. A wave is `await Promise.all(ids.map(work))`. Bash parallel jobs plus exit-code
   collection is fiddly.
3. Prompt quoting is the real killer in shell: multi-paragraph prompts containing
   backticks, quotes and `$` inside `claude -p "..."`.

Rejected:

- **Plain shell.** Fine for a 20-line spike to feel the loop. Dies on quoting and
  error handling.
- **No program at all** — a Claude Code skill where the main session orchestrates
  and spawns subagents through the Agent tool's worktree isolation. Zero code, but
  it is a model following prose: it can merge out of order or forget a `wp done`.
  Good for learning, bad for a loop whose whole value is deterministic bookkeeping.

### 8.3 Sketch

```ts
#!/usr/bin/env bun
import { $ } from "bun";

const ROLE = await Bun.file("prompts/worker.md").text();

const ready = async (): Promise<string[]> =>
  JSON.parse(await $`./wp.ts next --all --json`.text()).map((w: any) => w.id);

async function work(id: string) {
  const dir = `../wt-${id}`;
  await $`./wp.ts start ${id}`;
  await $`git worktree add ${dir} -b wp/${id}`;
  await $`bun install`.cwd(dir);

  const brief = await $`./wp.ts show ${id}`.text();     // description + body
  const prompt = `${ROLE}\n\n---\n\n${brief}`;          // role + task

  await $`claude -p ${prompt} --permission-mode acceptEdits`.cwd(dir);
}

for (;;) {
  const ids = await ready();
  if (ids.length === 0) break;

  await Promise.all(ids.map(work));          // the wave — parallel

  for (const id of ids) {                    // integration — serial, §6 rule 3
    await $`git merge --no-ff wp/${id}`;
    await $`bun test`;                       // throws -> no `done`, branch kept
    await $`./wp.ts done ${id}`;
    await $`git worktree remove ../wt-${id}`;
  }
}
```

Three notes:

- Bun's `$` throws on a non-zero exit, so a red suite aborts before `wp done` — the
  §7 behaviour for free. In real code, wrap the integration body in try/catch to
  continue with the next branch.
- `claude -p` is headless. `--permission-mode acceptEdits` stops it asking;
  `--output-format json` if you want to parse what it did.
- Each worktree also contains `wps/`, so "never touch the tracker files" is
  enforced by the role prompt rather than by the filesystem. An agent that ignores
  it shows up as a merge conflict — noisy, but not silent.

The four rules of §6 are visible in the control flow: `start` before spawn,
`Promise.all` for the wave, a `for` loop for integration, `done` only after the
suite passes.

### 8.4 What the built version adds

The control flow is the sketch's. Six things the sketch left out turned out to be
load-bearing, and the tests in `tests/orchestrate.test.ts` pin each one.

1. **A red suite undoes its own merge** — `git reset --keep ORIG_HEAD`. §7 says
   only "keep the branch and retry", which is enough when the red branch is the
   last in the wave, as in §5's diagram. It is not enough otherwise: the merge
   commit stays on `main`, so the *next* branch merges onto a red tree and gets
   blamed for it, and rule 3 quietly stops being true. `--keep` rather than
   `--hard` because the `wp start` edits to `wps/` are still uncommitted here, and
   `--hard` would throw the queue's own bookkeeping away. If the undo fails, the
   run stops rather than merging onto a broken `main`.
2. **A conflicting merge is aborted** before moving on, so the next branch in the
   wave meets a mergeable worktree instead of a half-merged one.
   **An empty branch is refused** before that: an agent can exit 0 having
   committed nothing, and merging its branch is "Already up to date" — no merge
   commit, nothing to undo, and a `done` that claims work which never landed.
3. **Claiming is serial and comes before any spawn.** It is also what makes the
   loop terminate, so if a whole wave fails to claim, the loop stops rather than
   asking `wp next` the same question for ever.
4. **A driver seam.** `runQueue(driver)` holds the bookkeeping; a `Driver`
   interface holds the commands. The wave order, the merge order and every failure
   path are then testable with a fake, which matters for a loop whose entire value
   is deterministic bookkeeping — the reason §8.2 rejected "no program at all".
5. **A preflight and a `--dry-run`.** It refuses to start outside a git
   repository, without `claude` on `PATH`, without a role prompt, or with a dirty
   worktree — every wave merges into this worktree and runs the suite in it.
   Unstaged edits under `wps/` and `log/` are the orchestrator's own; anything
   *staged* is refused wherever it lives, because `git merge` will not run while
   the index differs from `HEAD` even for a path the merge never touches, so
   starting would mean paying for a wave and then failing every merge.
   `--dry-run` prints the first wave's plan and stops.
6. **The project owns two of the three inputs** (D10). `prompts/worker.md` is read
   from the target repository, not from the tool, and the verify command is
   `--verify` (default `bun test`) rather than hardcoded — which closes the gap
   D10 left open. `bun install` survives, but only when the worktree has a
   `package.json`.

`Bun.spawn` with an argument list is used throughout instead of `$`. §8.2's reason
for a program over shell was prompt quoting; an argument list settles it by having
no shell to quote for.

## 9. Deliberately not built

| Not built | Add when |
|---|---|
| an `execution-plan` / wave-graph command | something must pre-allocate agents before the run |
| claims (`owner`, a lock) | more than one orchestrator runs at a time |
| file-level dependencies | worktrees stop being enough isolation |
| a worker pool with in-flight tracking | wave idle time is measurably expensive |

Double-claiming is not a risk under this model: `doing` is not a lock, but one
orchestrator handing out distinct IDs cannot hand the same ID out twice.
