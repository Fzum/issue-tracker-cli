# Architecture rules

## Input boundary

Use `docs/prd.md` as the only product input.

Treat `ready` as the expected PRD status.

Treat a missing or `draft` PRD as an input gap.

The builder can confirm an exception when provisional technical work is useful.

Record the exception and its risk under `## Inputs`.

Do not invent a product outcome, a scope boundary, or a quality target.

Record a blocker when a technical decision needs a product decision, and recommend `/vision` for it.

Do not edit `docs/prd.md` in this skill.

## Architectural drivers

Create a `DRV` item only when the input can change a technical decision.

Use one driver type: critical flow, quality attribute, constraint, or external dependency.

Link a product-derived driver to the `OUT` or `ASM` item it comes from.

Name the source of a legal, operational, organizational, or existing-system constraint.

For a quality attribute, state the stimulus, the operating context, the required response, and the measure.

Record an unknown measure as a gap.

Do not accept `fast`, `secure`, `scalable`, or `reliable` as a complete driver.

Prioritize drivers by decision impact.

Do not optimize every quality attribute equally.

## System shape

Choose the simplest logical topology that satisfies the active drivers.

Prefer one deployable application with explicit modules for a new product.

Require a positive driver for each extra process, service, queue, or independently deployed unit.

A positive driver can be independent deployment, strict isolation, separate ownership, distinct scaling, or an external boundary.

Do not accept future scale alone as a positive driver.

Do not design a speculative future system.

State an evolution boundary only when a current choice preserves a credible future option.

## Boundaries and data

Start from product language, business rules, data ownership, and change patterns.

Define each boundary by its responsibility and its invariants.

State which other boundaries it can depend on.

Avoid a cyclic dependency.

Assign exactly one authoritative owner to each important data concept.

Keep a shared module small and free of business rules.

Do not use technical layers as the only boundary.

Do not force Domain-Driven Design onto a simple domain.

Keep an external system outside the product ownership boundary.

Do not invent an integration contract.

## Technology selection

Select a technology only for a category the confirmed system shape requires.

Do not select a technology before the builder confirms the system shape.

Compare at least two credible candidates against the active drivers and the same criteria.

Verify every time-sensitive fact with a dated primary source from the vendor or the project.

Time-sensitive facts include the supported version, the end-of-life date, compatibility, licensing, quotas, and regional availability.

Record the source and the verification date in the stack table.

Say "I need to check" instead of stating an unverified version or support fact.

Review the existing repository baseline first, and state whether you retain, replace, or constrain each existing technology.

Prefer a retained technology when driver support is otherwise similar.

Prefer a reversible selection when driver support is otherwise similar.

Check every pair of technologies that must interact for a compatibility constraint.

Reopen the system shape when a selection needs a new deployable unit, store, or trust boundary.

Do not select a technology for a problem no active driver states.

## Decisions and ADRs

Compare at least two credible options for a consequential decision.

State how each option affects the active drivers.

Write a separate ADR when one or more statements are true:

- The decision is costly to reverse.
- The decision affects several boundaries.
- The decision establishes a system-wide constraint.
- The decision resolves a material risk.
- The decision rejects a credible alternative because of an important trade-off.

Keep a local and reversible decision in `docs/architecture.md`.

Name an ADR file `docs/adr/NNN-<slug>.md`, and start `NNN` at `001`.

Number an ADR once, and never reuse or renumber it.

Mark an ADR as `accepted` only after builder confirmation.

Do not delete a superseded ADR. Set its `status` to `superseded`, and record the replacement.

## Risks and validation

Separate a known constraint from an uncertain technical risk.

State the decision or selection the uncertainty can change.

Choose the smallest validation action that can reduce the uncertainty.

Do not run a spike, benchmark, security test, account change, purchase, deployment, or external mutation without builder authorization.

Record the expected evidence and the stopping condition.

## Readiness gate

Set `status` to `ready` only when all statements are true:

- Every active `DRV` item states a source and an implication.
- Every quality driver states a measure, or records the missing measure as a gap.
- The chosen system shape states a rationale against the active drivers.
- Every extra deployable unit names a positive driver.
- Every boundary states its responsibility, its data, and its allowed dependencies.
- Every important data concept has exactly one authoritative owner.
- No boundary dependency forms a cycle.
- Every required technology category holds a selection with a version policy and a dated primary source.
- Every technology pair that must interact holds compatibility evidence, or records a gap.
- Every consequential decision holds an ADR, or a local-decision row with an alternative.
- No section holds a bracketed placeholder.
- No open risk can invalidate the system shape or a consequential selection.

Keep `status` as `draft` when one statement is false, and report which one.
