---
name: architecture
description: Decide how the product gets built, and record the system shape, boundaries, data ownership, integrations, named technology stack, and the decisions behind them as ADRs. Use for new technical work, a draft architecture, or an architecture review. Do not use for product scope, business outcomes, user stories, estimates, or a work breakdown.
---

# Architecture

Turn the approved PRD into a simple system shape, a named technology stack, and explicit decision records. The builder makes all consequential technical decisions.

## Limits

- Write one architecture at `docs/architecture.md`.
- Write one ADR per consequential decision at `docs/adr/NNN-<slug>.md`, and fill [adr-template.md](assets/adr-template.md).
- Define drivers, system shape, boundaries, data ownership, integrations, the technology stack, and risks.
- Use the PRD as the only product input.
- Do not change the PRD, a product outcome, or a scope boundary.
- Do not write user stories, estimates, or a work breakdown.
- Do not write to `docs/prd.md` or `wps/`.
- Do not run a spike, benchmark, deployment, purchase, or account change without builder authorization.
- Save useful draft work if the session stops.

## Select one route

Read [architecture-rules.md](references/architecture-rules.md).

Read `docs/prd.md`.

- No `docs/architecture.md`: fill [architecture-template.md](assets/architecture-template.md) in section order.
- Architecture `status` is `draft`: read it, and continue from the first incomplete section.
- Architecture `status` is `ready`: read it, and ask the builder which decision to review.

Read the repository when code, configuration, or dependencies already exist. Record what you find as the existing baseline.

Apply the input rule in [architecture-rules.md](references/architecture-rules.md) when the PRD is missing or `draft`.

## Conduct the session

- Start with the outcomes, scope, and constraints the PRD states.
- Record each decision-relevant need as a stable `DRV` item.
- State a quality driver as a measurable scenario, or record the missing measure as a gap.
- Choose the simplest system shape that satisfies the active drivers.
- Require a positive driver for each extra process, service, queue, or deployable unit.
- Define each boundary by responsibility, rules, data ownership, and allowed dependencies.
- Confirm the system shape before you select a technology.
- Select only the technology categories the confirmed shape requires.
- Compare credible candidates against the active drivers and the same criteria.
- Verify support, compatibility, licensing, and service facts with dated primary sources.
- Reopen the system shape when a selection needs a new deployable unit, store, or trust boundary.
- Check the whole stack for compatibility and operational coherence.
- Write an ADR when a decision meets the ADR threshold.
- Record unresolved technical risk with a validation action, or as a builder-accepted risk.
- Keep manual and external responsibilities visible.
- Ask one focused question at a time.
- Show clear trade-offs before each consequential choice.
- Get builder confirmation for the system shape, boundaries, data ownership, selections, and accepted risks.
- Preserve stable identifiers and manual additions.
- Update the canonical artifacts instead of creating a session report.

## Finish

Apply the readiness gate in [architecture-rules.md](references/architecture-rules.md).

Ask the builder to confirm a transition of `status` to `ready`.

Ask the builder to confirm a transition of each ADR to `accepted`.

Recommend `/breakdown` when no work breakdown exists.

Explain that `/breakdown` records business intent only, so it does not read this architecture.

Do not run `/breakdown`.

Report changed decisions, changed selections, open blockers, and accepted risks.
