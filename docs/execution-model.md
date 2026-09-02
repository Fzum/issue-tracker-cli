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

## 8. Deliberately not built

| Not built | Add when |
|---|---|
| an `execution-plan` / wave-graph command | something must pre-allocate agents before the run |
| claims (`owner`, a lock) | more than one orchestrator runs at a time |
| file-level dependencies | worktrees stop being enough isolation |
| a worker pool with in-flight tracking | wave idle time is measurably expensive |

Double-claiming is not a risk under this model: `doing` is not a lock, but one
orchestrator handing out distinct IDs cannot hand the same ID out twice.
