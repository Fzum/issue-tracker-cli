# The board — a live view of `wps/` in a browser

Date: 2026-09-03
Status: adopted
Source: `design.md` (the CLI and its JSON), `execution-model.md` (what a run looks like)

## 1. What this answers

`design.md` answers *"what should I work on next?"* for an agent.
`execution-model.md` answers *"how do several agents run at once?"*

This document answers a question neither of them does: **"what is happening right
now, and how far along am I?"** — for a human, at a glance, while agents are
working.

`wp tree` already prints the answer once. The board is the same answer, kept
current, in a browser tab you leave open on a second screen.

It is a **reader**. It never writes to `wps/`. `wp start` and `wp done` remain the
only write path (invariant 6).

## 2. The idea

The board is a fourth entry point, `board.ts`, and it is built the same way
`orchestrate.ts` is built: **it drives `wp.ts` as a subprocess and imports nothing
from `src/`.** The JSON output is the contract between them, not a function
signature.

The whole mechanism is three moving parts:

```
browser  --GET /api/state (every 1s)-->  board.ts  --spawn-->  wp tree --json
   ^                                        |
   +--------------- rows + hash ------------+
```

There is no file watcher. The client polls; the server rescans on each poll by
spawning the CLI. On a queue of this size that is a sub-100ms round trip, and it
buys three properties a watcher does not have for free:

- **No partial-write handling.** `fs.watch` fires while an agent is halfway
  through writing a file. A poll either catches a valid tree or catches an error,
  and §7 says what to do with the error.
- **Restart resilience.** Kill and restart `board.ts`; the open tab recovers on
  its next poll with no reconnect logic.
- **No debounce to tune.** An editor's write-temp-then-rename produces a burst of
  watch events and exactly one changed poll.

Agents take minutes per work package. One second of latency is invisible, and it
is the reason this design has no WebSocket, no Server-Sent Events, and no
subscription bookkeeping.

## 3. The data contract, and the one field it is missing

`wp tree --json` returns, per row:

```json
{ "depth": 3, "id": "wp-m2e1u2", "short_description": "Reserve stock",
  "status": "doing", "unmet_blockers": [] }
```

Two things the board needs are absent: which rows are containers, and which leaves
roll up into which milestone.

**Neither may be reconstructed from the id strings.** `"wp-m10e1".startsWith("wp-m1")`
is `true`, so a prefix match silently sweeps a whole other milestone into a
milestone's progress bar. Nor may it be reconstructed from the *ordering* — rows
arrive parents-first, so a depth stack looks like it works, but a work package
whose parent file is missing (a state `wp check` reports and `wp tree` still
renders) attaches to the wrong parent with no error.

So `wp tree --json` gains one field:

```ts
parent: parentId(id),      // null at a root
```

`src/tree.ts` already imports `parentId` from `src/ids.ts`; this is one line in
`treeRows` plus one test in `tests/tree.test.ts`. It is **additive**, so the JSON
stability contract in `CLAUDE.md` holds and existing consumers are unaffected.

This is the only change to the CLI. Everything else the board needs is derived
from `parent`:

| Derived | How |
|---|---|
| is a container | some row's `parent` is this id |
| is a leaf | no row's `parent` is this id |
| leaf descendants | walk the parent map transitively |

`parent` may name an id that has no row of its own — the missing-parent-file case
above. The board treats such a row as a root rather than dropping it, so a broken
tree is still visible; `wp check` is what explains it.

## 4. The five states

`wp tree` has one axis (the stored status, plus a blocked glyph). The board has
five states, because the two most interesting things about an agent queue are not
stored fields:

| State | Condition | Colour |
|---|---|---|
| `done` | leaf, `status: done` | green |
| `doing` | leaf, `status: doing` | amber, animated |
| `ready` | leaf, `status: todo`, no unmet blockers | cyan |
| `blocked` | leaf, `status: todo`, unmet blockers present | magenta, dimmed |
| `container` | some row names it as parent | neutral, renders a bar |

`ready` is the state with no CLI equivalent and the reason the board is worth
building: it is exactly what `wp next` would return, so the board shows what is
about to happen as well as what is happening.

Two rules are inherited from `statusGlyph` in `src/tree.ts` and must not drift:

1. **`done` and `doing` outrank blocked.** Work already under way is reported as
   it stands; only a work package that has not started reads as unstartable.
2. **`unmet_blockers` is the source**, not the raw `blocked_by`. It is the same
   list `wp start` refuses on and the same list the tree prints after `⊘`, so the
   board can never claim something is startable when `wp start` would refuse it.

A leaf whose `status` is missing or is not one of the three renders as `invalid`
— a red `?`, the same glyph and colour `src/tree.ts` gives it. It is not a sixth
state so much as the absence of one, it is a state `wp check` reports as a
problem, and the board's job is to show it rather than to guess which of the five
was meant.

A container may carry unmet blockers of its own. It keeps its bar and shows the
blocker list beside it; it does not take the `blocked` colour, because the bar is
the more useful thing in that row.

The palette is the CLI's own ANSI colours — green, amber, grey, magenta — so the
two views agree on sight. Cyan is the one addition, for the one new state.

## 5. Progress: deep leaf counts

`wp tree` counts **direct children**: a milestone of three epics shows `0/3` until
a whole epic lands, even with eight of its nine stories done. That is right for a
dense one-screen tree. It is wrong for a progress bar, which is read as "how far
along is this".

Every bar on the board counts **leaves in the subtree, at any depth**:

```
▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  7/14 leaves  50%

▾ ▣ wp-m2  Fulfilment      2/9 ▓▓░░░  22%      <- not 0/3
  ▾ ▣ wp-m2e1  Inventory   1/3 ▓▓░░░  33%
```

Leaves are the only rows that carry work, so they are the only sound unit to count.
This is a deliberate divergence from `wp tree`, recorded here so a later reader
does not "fix" it into agreement.

`doing` fills neither half of the bar: the bar is `done / total`. The state counts
in the summary header carry the rest.

## 6. The server — `board.ts`

A fourth entry point at the repository root, beside `wp.ts` and `orchestrate.ts`,
installed into a target project as `wp-board` (§11).
It finds the CLI the way `orchestrate.ts` does — `join(import.meta.dir, "wp.ts")` —
and it binds `127.0.0.1` only. This is a local development tool; it is not exposed
and it has no authentication because it has no reachable surface to protect.

| Flag | Meaning |
|---|---|
| `--dir <path>` | forwarded to `wp`; default `wps/` |
| `--port <n>` | default `4400` |
| `--open` | open the default browser at startup |
| `-h`, `--help` | usage |

Two routes, and no more:

```
GET /            -> board.html, read from disk beside board.ts
GET /api/state   -> the payload below
```

```json
{
  "hash": "9f2c1a…",
  "ok": true,
  "summary": { "done": 7, "doing": 2, "ready": 3, "blocked": 2, "total": 14 },
  "rows": [
    { "id": "wp-m2e1", "parent": "wp-m2", "depth": 2, "state": "container",
      "short_description": "Inventory epic", "unmet_blockers": [],
      "leaves_done": 1, "leaves_total": 3 },
    { "id": "wp-m2e1u2", "parent": "wp-m2e1", "depth": 3, "state": "doing",
      "short_description": "Reserve stock when an order is placed",
      "unmet_blockers": [], "leaves_done": 0, "leaves_total": 0 }
  ]
}
```

The payload carries **no timestamp**, deliberately: the freshness indicator in the
header is the client timing its own last successful poll. A `generated_at` on the
wire would change on every poll and defeat `hash` entirely.

`hash` is over the serialized rows (`Bun.hash`, no dependency). It exists so the
client can skip a re-render — and therefore skip destroying and rebuilding DOM
that the user is mid-scroll in — when a poll returns an unchanged tree, which is
what almost every poll returns.

**One exported pure function carries the design:** `boardState(treeRows)` takes the
parsed rows from `wp tree --json` and returns that payload. Every rule in §3, §4
and §5 lives inside it. It touches no filesystem, no network and no clock, so it
is unit-testable against literal arrays — and the client JavaScript, which is not
testable here, is left with nothing but rendering.

## 7. When the tree cannot be read

`wp tree` exits `2` on an unreadable directory or an unparseable file, and
`loadGraph` refuses the whole directory when any single file is bad. Agents write
these files while the board is watching, so a half-written file is a normal
event, not an exceptional one.

On a non-zero exit the payload becomes:

```json
{ "ok": false, "error": "wp: cannot read directory /nope: ENOENT…" }
```

and **the client keeps the last good tree on screen underneath a banner carrying
that message**. It must not blank the page. A blank page during a run reads as
"everything vanished"; a banner over a stale tree reads as "one file is broken
right now", which is the truth, and it usually clears itself on the next poll.

The header shows the age of the displayed data, so a tree that stays stale is
visibly stale rather than quietly wrong.

## 8. The client — `board.html`

One self-contained file: inline CSS, inline vanilla JavaScript, no framework, no
bundler, no dependency, no build step. That is the same constraint the rest of the
repository holds itself to, and it is what keeps `board.ts` runnable straight from
a clone.

Monospace and dark, so it reads as a terminal.

```
┌─ my-project ───────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  7/14 leaves  50%     │
│ ✔ 7   ▶ 2   ● 3   ⊘ 2          updated 1s  │
└────────────────────────────────────────────┘

▾ ▣ wp-m1    Checkout milestone     5/5 ▓▓▓▓▓ 100%
  ▾ ▣ wp-m1e1  Cart epic            2/2 ▓▓▓▓▓ 100%
      ✔ wp-m1e1u1  Add an item to the cart
      ✔ wp-m1e1u2  Remove an item from the cart
▾ ▣ wp-m2    Fulfilment milestone   2/9 ▓▓░░░  22%
  ▾ ▣ wp-m2e1  Inventory epic       1/3 ▓▓░░░  33%
      ✔ wp-m2e1u1  Model stock levels
      ▶ wp-m2e1u2  Reserve stock when an order is pla…
      │ Reserve stock when an order is placed, so two
      │ concurrent orders cannot claim the same unit.
      ⊘ wp-m2e1u3  Release stock   ← wp-m2e1u2
      │ Release reserved stock when an order is cancelled.
      │ waiting on   ▶ wp-m2e1u2  Reserve stock…
```

### 8.1 Two gestures

- **The chevron on a container** folds its children away. Collapse state lives in
  `localStorage`, so it survives both a re-render and a reload.
- **Clicking a leaf row** opens an inline detail strip beneath it holding the
  untruncated `short_description` and, when there are any, the unmet blockers —
  each with the state glyph of its own row, so you can see whether the thing you
  are waiting on is itself running or itself blocked. Rows truncate to a single
  line, which is what keeps fifty work packages on one screen; the strip is how
  you read the rest. Several may be open at once.

  Only *unmet* blockers can be shown. `wp tree --json` carries `unmet_blockers`,
  not the full `blocked_by`, so a dependency that is already `done` does not
  appear — a row with nothing left in its way shows only its description. Listing
  satisfied dependencies would mean a second field on the wire, and §10 is the
  reason that is not worth it.

There is no modal. `wp tree --json` carries no markdown body, and a popup showing
the same two facts the strip already shows would be ceremony. §10 records the
one-line change that would make a modal worth having later.

### 8.2 Motion, and its two jobs

- **`doing` gets a marching border** — a CSS gradient animation, no JavaScript.
  It is the only continuously moving thing on the page, so "an agent is working
  on this one" is legible from across a room.
- **A row whose state changed since the last poll flashes once.** This is what
  makes the board feel live rather than merely current: when a wave lands, you
  see *which* rows moved instead of noticing later that the numbers differ.

Both respect `prefers-reduced-motion`, which disables the marching border and
replaces the flash with a brief static highlight.

### 8.3 The polling loop

Fetch `/api/state` every 1000ms. Re-render only when `hash` differs from the last
render. Pause entirely while `document.hidden`, and fetch once immediately on
becoming visible again — an unattended tab should not spawn a subprocess every
second for a day.

## 9. Testing

`tests/board.test.ts`, which brings its own fixture rather than importing
`tests/helpers.ts` — like `tests/orchestrate.test.ts` and `tests/install.test.ts`,
it sits outside the `src/` mirror because `board.ts` does.

| Pins | How |
|---|---|
| every rule in §3–§5 | `boardState` called directly on literal row arrays: container detection, deep leaf counts, the five states, `done`/`doing` outranking blocked, a dangling `parent` treated as a root |
| the routes and payload shape | `board.ts` spawned as a subprocess on a test port, driven with `fetch` against a temp `wps/` |
| §7 | the same, pointed at a directory holding one unparseable file: `ok: false` and a non-empty `error` |
| the new `parent` field | `tests/tree.test.ts`, beside the other `tree --json` assertions |

**The browser is not tested**, and that is the reason §6 puts every rule in
`boardState`. Adding a headless browser to a repository with zero runtime
dependencies would cost more than the coverage is worth; keeping the client dumb
is what makes that trade honest rather than lazy.

## 10. What this is not

Each of these is a deliberate cut, not an oversight:

- **No writes.** No click-to-start, no click-to-done. Invariant 6 stands: `wp start`
  and `wp done` are the only write path, and a board that could claim work would
  race the orchestrator for it.
- **No markdown body, and so no modal.** Adding `body: wp.body` to `tree --json`
  is one line — `src/render.ts` already returns it for `show --json` — and it is
  what a later modal would need. It is out of scope because a live board is read
  at a glance, and the body is read when you are about to do the work, which is
  what `wp show` is for.
- **No search, filter, or `--scope`.** `wp tree --scope` exists, so this is a flag
  and a query parameter away when a queue gets big enough to want it.
- **No watcher.** §2.
- **No authentication, no non-local binding, no multi-project view.**
- **No framework, no bundler, no npm dependency, no build step.**

## 11. Files

| File | Change |
|---|---|
| `board.ts` | new — the entry point, the two routes, and `boardState` |
| `board.html` | new — the whole client |
| `src/tree.ts` | one added field, `parent`, in `treeRows` |
| `tests/board.test.ts` | new — §9 |
| `tests/tree.test.ts` | one test for `parent` |
| `tsconfig.json` | `include` gains `board.ts` |
| `install.sh` | a third symlink, `wp-board` |
| `CLAUDE.md` | the fourth entry point, its grep exemption, and the `board.test.ts` row |
| `README.md` | the entry-point table and a usage line |

Two repository-specific traps, both recorded in `CLAUDE.md` and both silent when
hit:

1. **`tsconfig.json`'s `include` must gain `board.ts`.** A new root module outside
   those globs escapes `typecheck` entirely and reports a false green.
2. **The four module-boundary greps scope to `wp.ts src/`.** `board.ts`
   legitimately touches `process.*`, `Bun.serve`, `Bun.spawn` and reads
   `board.html` from disk — exactly as `orchestrate.ts` legitimately does — so the
   exemption must be written down, or the next reader will "fix" it. No `src/`
   module may import `board.ts`.

`board.ts` ends with `process.exitCode = await main()` and the same stdout EPIPE
guard as the other two entry points, for the same two reasons recorded in
`CLAUDE.md`.

## 12. Risks

**The `parent` field is a public contract change.** It is additive, so nothing
breaks, but `tree --json`'s shape is asserted directly by CLI tests and consumed
by agents. Mitigated by adding it in one place with a test beside the existing
`tree --json` assertions.

**Deep counts and shallow counts will look like a bug.** The board says a
milestone is `2/9` where `wp tree` says `0/3`, and someone will eventually report
that as an inconsistency. §5 exists to answer that report.

**A subprocess per poll is fine until it is not.** At one second and ~30ms per
spawn this is 3% of a core. A queue of several hundred work packages, or a slower
machine, may want the interval raised or the CLI imported in-process instead —
both are small changes, and neither is worth making before it is measured.

**`board.html` will grow.** It holds layout, five states, two gestures, motion and
the polling loop in one file. The rule from `CLAUDE.md` applies: split it when it
earns the split, not before — and the split, when it comes, is CSS out first,
because that is the half with no logic in it.
