# Watching a wave — `wp.id` on every agent

Date: 2026-09-04
Status: adopted
Source: `execution-model.md` (what a wave is), `docs/superpowers/specs/2026-09-04-agent-observability-design.md`

## 1. Why

A wave is several `claude -p` processes at once. `log/<id>.log` is written only
*after* an agent exits, so for the minutes it actually works there is nothing to
see — and every agent reports itself to a collector identically, so a viewer shows
four anonymous sessions.

Claude Code already emits OpenTelemetry metrics, events and (in beta) spans. The
missing piece was never collection, it was **attribution**. So `orchestrate.ts`
sets one resource attribute per spawned agent:

```
wp.id=<work package id>
```

That is the whole feature. With it, any OTLP viewer groups, filters and sums by
work package:

```
wp-m1e1u1  ──────────────  3m12s
  Read src/foo.ts    ▖        0.2s
  api_request        ▄▄▄      8.1s
  Edit src/foo.ts     ▖       0.3s
  Bash bun test        ▄▄▄▄▄  41s

wp-m1e1u2  ──────────       2m01s
```

The tag is added on every run, whether or not telemetry is switched on. With it
off, `OTEL_RESOURCE_ATTRIBUTES` is a variable nothing reads.

An existing `OTEL_RESOURCE_ATTRIBUTES` is **appended to, never replaced**, so tags
you already carry (`department=eng`, `team.id=platform`) survive.

## 2. The viewer

There is no receiver in this repository and none is planned — the board stays a
reader over `wps/` (`board.md`). Use a real trace UI; it is one binary away.

[`otel-desktop-viewer`](https://github.com/CtrlSpice/otel-desktop-viewer): no
docker, listens on 4317 and 4318, serves a waterfall on `http://localhost:8000`.

```sh
go install github.com/CtrlSpice/otel-desktop-viewer@latest
otel-desktop-viewer
```

Or download a release binary from the project's GitHub releases page. Behind a
corporate proxy, either route may need arranging first.

## 3. Turning it on

In the shell you run `orchestrate.ts` from:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_TRACES_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

The operator owns this, not the tool. There is deliberately no `--otel` flag and
no endpoint default: per D10 the project owns as few inputs as it can, and owning
Claude Code's telemetry surface would mean tracking it as Claude changes, for no
behaviour of our own.

If nothing is listening, Claude Code's exporter fails quietly and the agents work
as normal. A silent viewer is not a broken run.

### Export intervals

Metrics default to a 60 s export interval, which is longer than some agents live.
While watching a live run:

```sh
export OTEL_METRIC_EXPORT_INTERVAL=5000
export OTEL_LOGS_EXPORT_INTERVAL=1000
```

### Version floor

Spans are beta and need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`. Verified working
on Claude Code 2.1.260. An older build still yields metrics and events carrying
`wp.id`, but no waterfall.

### Content flags, and their cost

```sh
export OTEL_LOG_TOOL_DETAILS=1        # turns a `Bash` span into the actual command
export OTEL_LOG_USER_PROMPTS=1        # opt-in: full prompt text into the collector
export OTEL_LOG_ASSISTANT_RESPONSES=1 # opt-in: full response text into the collector
```

`OTEL_LOG_TOOL_DETAILS=1` is most of the value of watching a run — without it every
shell call is just `Bash`. The other two put whole prompts and replies into the
collector; enable them knowingly.

## 4. What to look at

| Question | Where |
|---|---|
| Which agent is this? | filter on `wp.id` |
| Which work package burned the tokens? | `claude_code.token.usage`, summed by `wp.id` |
| What did a work package cost? | `claude_code.cost.usage`, summed by `wp.id` |
| Why is an agent stuck? | `claude_code.api_error` first, then its last span |

## 5. What this deliberately does not do

Recorded so the omissions read as decisions, not oversights.

| Not built | Why |
|---|---|
| A `--otel` flag, or any exporter / endpoint default | §3: the operator turns telemetry on in their own shell. |
| An OTLP receiver in `board.ts` | The board stays a reader over `wps/`. Reimplementing a waterfall against zero dependencies costs more than it returns. |
| A `service.name` override | Claude Code owns that name, and a viewer keys its whole navigation on it. `wp.id` is additive and cannot blank a UI. |
| A second tag (`wp.wave`, `wp.branch`, `wp.scope`) | The wave number lives in `runQueue` and `Driver.work(id)` never receives it; passing it means changing the `Driver` seam for a number a viewer can read off timestamps. Branch and scope are functions of the id. |
| Telemetry for the orchestrator itself | It is not a `claude` process and has no OTel SDK. Its own report lines on stdout are the record of what it did. |
| Anything in `install.sh` | Nothing to install. This document is the deliverable. |

## 6. Where it lives in the code

Two functions in `orchestrate.ts`, both tested in `tests/orchestrate.test.ts`:

- **`agentEnvironment(id, base)`** — section 1, pure, beside `agentAllowedTools`.
  Returns a copy of `base` with `wp.id=<id>` appended to
  `OTEL_RESOURCE_ATTRIBUTES`, and no leading comma when there was nothing there:
  an empty attribute pair is rejected outright by some collectors.
- **`execute(command, cwd, environment?)`** — section 3, the one `Bun.spawn` call
  site. It forwards `env` only when the argument is given, so `wp`, git and the
  gate are unchanged.

**The trap, written down because it is invisible when hit:** `Bun.spawn`
*replaces* the child environment when `env` is passed — it does not merge. Handing
an agent `{ OTEL_RESOURCE_ATTRIBUTES: ... }` alone leaves it with no `PATH`, no
`HOME` and no credentials, and `claude` then fails to start for reasons that read
as an auth problem. Spreading the base environment is `agentEnvironment`'s job,
which is why it takes a `base` argument at all.

`process.env` is read in `createDriver` and nowhere else. `orchestrate.ts` already
touches `process.*` legitimately, so no module boundary moves and the four `grep`
rules — which scope to `wp.ts src/` — are unaffected.
