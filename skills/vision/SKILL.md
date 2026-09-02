---
name: vision
description: Create or refine the product requirements document that holds the vision, target users, problem, intended outcomes, scope boundaries, and assumptions. Use for a new product idea, an existing product without a PRD, a draft PRD, or a PRD review. Do not use for technical decisions, architecture, technology selection, or a work breakdown.
---

# Vision

Turn an idea into one product requirements document. The builder makes all consequential product decisions.

## Limits

- Write one PRD at `docs/prd.md`.
- Define the vision, target users, problem, intended outcomes, scope boundaries, assumptions, and open questions.
- Use business language only.
- Do not name a technology, framework, vendor, data store, protocol, error code, or user-interface control.
- Do not design the system, select a technology, or write a work breakdown.
- Do not write to `docs/architecture.md`, `docs/adr/`, or `wps/`.
- Save useful draft work if the session stops.

## Select one route

Read [prd-rules.md](references/prd-rules.md).

- No `docs/prd.md`: interview the builder, and fill [prd-template.md](assets/prd-template.md) in section order.
- PRD `status` is `draft`: read the PRD, and continue from the first incomplete section.
- PRD `status` is `ready`: read the PRD, and ask the builder which section to review.

Read the repository only when the product already exists and the code answers a question about current behavior.

## Conduct the session

- Ask one focused question at a time.
- Challenge a vague, contradictory, or feature-first statement.
- Convert a proposed feature into the outcome it serves.
- Propose concise text after you understand an answer.
- Get builder confirmation for consequential text and for every inference.
- Record an unproven claim as an assumption, and never as a fact.
- Record a technical statement the builder makes as a constraint in `## Out of scope` or in `## Open questions`.
- Preserve stable identifiers and manual additions.
- Update `docs/prd.md` instead of creating a session report.

## Finish

Apply the readiness gate in [prd-rules.md](references/prd-rules.md).

Ask the builder to confirm a transition of `status` to `ready`.

Recommend `/breakdown` to turn the PRD into milestones, epics, and stories.

Recommend `/architecture` to decide how the product gets built.

Explain that `/breakdown` and `/architecture` are independent, so the builder can run them in any order.

Do not run `/breakdown` or `/architecture`.

Report changed sections, open questions, and downstream artifacts that can be stale.
