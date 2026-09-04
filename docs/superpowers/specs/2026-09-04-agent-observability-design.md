# Agent observability — design

Approved 2026-09-04. Status: design agreed, not yet implemented.

## 1. The problem

`orchestrate.ts` spawns one `claude -p` per ready leaf, up to a whole wave at a
time. While a wave runs, the only window into it is `log/<id>.log`, and that file
is written *after* the agent exits: during the minutes an agent actually works
there is nothing to see. When something goes wrong there is no way to answer
"which agent burned the tokens", "which one is stuck", or "what tool did it call
before it gave up" without reading four transcripts end to end afterwards.

Claude Code already emits OpenTelemetry metrics, events and (in beta) spans. The
gap is not collection — it is **attribution**. Every agent in a wave reports
itself the same way, so a viewer shows four identical anonymous sessions.

## 2. What this adds

One resource attribute, `wp.id`, set per spawned agent to that agent's work
package ID. That is the whole feature.

With it, any OTLP viewer groups, filters and sums by work package:

```
wp-m1e1u1  ──────────────  3m12s
  Read src/foo.ts    ▖        0.2s
  api_request        ▄▄▄      8.1s
  Edit src/foo.ts     ▖       0.3s
  Bash bun test        ▄▄▄▄▄  41s

wp-m1e1u2  ──────────       2m01s
```

## 3. What this deliberately does not add

Recorded so the omissions read as decisions, not oversights.

| Not built | Why |
|---|---|
| A `--otel` flag, or any exporter / endpoint / protocol default | The operator turns telemetry on in their own shell. Per D10 the project owns as few inputs as it can; owning Claude Code's telemetry env surface would mean tracking it as Claude changes, for no behaviour of our own. |
| An OTLP receiver inside `board.ts` | The board stays a reader over `wps/`. A real trace UI exists and is one binary away; reimplementing a waterfall against zero dependencies costs more than it returns. |
| A `service.name` override | Claude Code owns that name. Overriding a resource attribute a viewer keys its whole navigation on is how a UI ends up blank. `wp.id` is additive and cannot do that. |
| Any second tag (`wp.wave`, `wp.branch`, `wp.scope`) | The wave number lives in `runQueue`, and the driver's `work(id)` does not receive it. Passing it means changing the `Driver` seam — a real cost for a number a viewer can derive from timestamps. Branch and scope are functions of the ID. |
| Telemetry for the orchestrator process itself | It is not a `claude` process and has no OTel SDK. Its own report lines on stdout are the record of what it did. |
| Anything in `install.sh` | Nothing to install. The doc is the deliverable. |

## 4. The change to `orchestrate.ts`

### 4.1 One new pure function, section 1

Placed beside `agentAllowedTools`, whose shape it copies: exported, pure, one
input in and one value out, so the test needs no repository and no subprocess.

```ts
export function agentEnvironment(
  id: string,
  base: Record<string, string | undefined>,
): Record<string, string | undefined>
```

Behaviour, exactly:

1. Return a shallow copy of `base`. Never mutate the argument — the caller
   passes `process.env`.
2. Set `OTEL_RESOURCE_ATTRIBUTES` to the existing value with `,wp.id=<id>`
   appended.
3. When `base` has no `OTEL_RESOURCE_ATTRIBUTES`, or has it set to the empty
   string, the result is `wp.id=<id>` with no leading comma. A leading comma
   produces one empty attribute pair, which some collectors reject outright.
4. Every other key passes through untouched.

**Append, never replace.** `OTEL_RESOURCE_ATTRIBUTES` is a general-purpose
variable; an operator may already carry `department=eng,team.id=platform` in it.
Replacing it would silently drop their tags, and the loss is invisible — the
viewer simply stops offering a filter that used to work.

The value is not escaped or validated. `wp.id` values come from the stem
grammar (`wp-` plus `[a-z][0-9]+` segments), which contains no comma, no equals
sign and no whitespace, so there is nothing to escape. This is stated rather
than defended in code.

### 4.2 `execute` gains an optional environment

`execute` (section 3) is the only `Bun.spawn` call site and stays so:

```ts
async function execute(
  command: readonly string[],
  cwd: string,
  environment?: Record<string, string | undefined>,
): Promise<CommandResult>
```

It forwards `env` to `Bun.spawn` only when the argument is given, so every
existing caller — `wp`, git, the gate — is byte-for-byte unchanged.

**The trap, written down because it is invisible when hit:** `Bun.spawn`
*replaces* the entire child environment when `env` is passed; it does not merge.
A caller that passes `{ OTEL_RESOURCE_ATTRIBUTES: ... }` alone gives the agent
no `PATH`, no `HOME` and no credentials, and `claude` fails to start for reasons
that read as an auth problem. Spreading the base environment is therefore
`agentEnvironment`'s job, not an optional nicety, and it is why the function
takes a `base` argument instead of building the one variable it cares about.

### 4.3 One call site

In `createDriver`'s `work` (section 4), the existing `execute(...)` call gains a
third argument:

```ts
const result = await execute(
  [AGENT_COMMAND, "-p", prompt, "--permission-mode", "acceptEdits",
   "--allowedTools", ...allowedTools],
  worktreePath(repositoryRoot, id),
  agentEnvironment(id, process.env),
);
```

`process.env` is read here, in `createDriver`, and nowhere else. `orchestrate.ts`
already touches `process.*` legitimately, so no module boundary moves and the
four `grep` rules — which scope to `wp.ts src/` — are unaffected.

The tag is added unconditionally, whether or not telemetry is enabled. With
telemetry off, `OTEL_RESOURCE_ATTRIBUTES` is a variable nothing reads, so there
is no state to branch on and no flag to keep in sync.

## 5. `docs/observability.md`

A new document, and the only user-facing surface of this change. Contents:

1. **The one-paragraph why** — a wave is several agents at once; `wp.id` is what
   tells them apart.
2. **The viewer.** `otel-desktop-viewer`: one binary, no docker, listens on 4317
   and 4318, serves a trace waterfall on `http://localhost:8000`. Both install
   routes (`go install`, or a GitHub release download) are named, with a note
   that a corporate proxy may need arranging for either.
3. **The export block**, verbatim and copy-pasteable:

   ```sh
   export CLAUDE_CODE_ENABLE_TELEMETRY=1
   export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
   export OTEL_TRACES_EXPORTER=otlp
   export OTEL_LOGS_EXPORTER=otlp
   export OTEL_METRICS_EXPORTER=otlp
   export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
   ```

4. **The export interval caveat.** Metrics default to a 60 s export interval,
   which is longer than some agents live. `OTEL_METRIC_EXPORT_INTERVAL=5000` and
   `OTEL_LOGS_EXPORT_INTERVAL=1000` are given as the values to use while
   watching a live run.
5. **The version floor.** Spans are beta and need
   `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`. Verified working on Claude Code
   2.1.260. An older build still yields metrics and events, but no waterfall.
6. **Content flags, and their cost.** `OTEL_LOG_TOOL_DETAILS=1` is what turns
   `Bash` spans from `Bash` into the actual command, which is most of the value
   of watching a run. `OTEL_LOG_USER_PROMPTS=1` and
   `OTEL_LOG_ASSISTANT_RESPONSES=1` are named as opt-in, with the warning that
   they put full prompt and response text into the collector.
7. **What to look at.** `wp.id` as the filter; `claude_code.token.usage` and
   `claude_code.cost.usage` as the per-work-package sums; `claude_code.api_error`
   as the first place to look when an agent stalls.

`CLAUDE.md` gains one row in the repository-layout table pointing at it, listed
with the other `docs/` entries.

## 6. Testing

All three tests go in `tests/orchestrate.test.ts` — this pins the orchestrator's
spawn contract, not the CLI. Given/When/Then in name and body, per the existing
file.

**Two pure tests on `agentEnvironment`:**

1. Given a base environment with no `OTEL_RESOURCE_ATTRIBUTES`, when called with
   `wp-m1e1u1`, then the result is exactly `wp.id=wp-m1e1u1` — no leading comma —
   and every other key of the base survives.
2. Given a base environment already carrying `department=eng`, when called, then
   the result is `department=eng,wp.id=wp-m1e1u1`, and the base object itself is
   unchanged.

**One end-to-end test through a real spawn.** This is the one that matters: the
pure tests would both still pass if `work` forgot to pass the environment on.

- `RepositoryFixture.givenFakeAgent` takes an optional shell body, defaulting to
  today's `exit 0`, so all existing call sites stay as they are. The new test
  passes a body that prints `$OTEL_RESOURCE_ATTRIBUTES`.
- A new `RepositoryFixture.logOf(id)` reads `log/<id>.log`.
- The test builds a repository with **one ready leaf**, then runs `orchestrate.ts`
  as a subprocess through the existing `runOrchestrator`, which is already what
  puts the fake `claude` on `PATH`.
- It asserts `logOf("wp-m1e1")` contains `wp.id=wp-m1e1`.

The run itself fails, and the test asserts nothing about the exit code. A fake
agent commits nothing, so its branch is an ancestor of `HEAD` and `merge`
refuses it by rule 4. That refusal happens *after* `work` has written the log,
so the assertion is unaffected — and this is the first test in the suite that
spawns the fake agent at all, so the comment saying why the failure is expected
is part of the deliverable.

Full gate before this is called done: `bun test` and `bun run typecheck`, both
green. `typecheck` alone is not verification — `@types/bun` is pinned to
`latest`, so it can pass against an API the installed runtime lacks.

## 7. Risks

| Risk | Assessment |
|---|---|
| Passing `env` breaks agent spawning in some environment we did not test | This is the only real risk, and the end-to-end test is aimed straight at it: it spawns a real subprocess with the constructed environment and asserts the child both started and received the tag. |
| Spans are beta and may change shape or disappear | The change here is one resource attribute, which is stable OTel, not a beta surface. If spans go away, metrics and events still carry `wp.id` and the doc's floor note is the thing that needs editing. |
| An operator sets `OTEL_RESOURCE_ATTRIBUTES` to something malformed | Their string is passed through as-is and their collector reports it. Not this tool's business to validate. |
| Telemetry endpoint unreachable, e.g. no viewer running | Claude Code's exporter fails quietly and the agent's work is unaffected. Nothing in `orchestrate.ts` waits on the collector. Worth one line in the doc so a silent viewer is not read as a broken run. |
