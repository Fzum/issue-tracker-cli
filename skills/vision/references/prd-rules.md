# PRD rules

## Business language

The PRD is the business record of the product. A person from the business side must be able to read it and approve it.

Write every statement in the words a user or a stakeholder would use.

Do not name a programming language, framework, library, vendor, cloud service, data store, protocol, message format, error code, or user-interface control.

Do not describe screens, buttons, fields, endpoints, or tables.

State what a person achieves, and never how the product does it.

Record a technical constraint the builder states as a named constraint in `## Out of scope`, and keep the reason with it.

Move a technical question to `## Open questions`, and recommend `/architecture` for it.

## Vision statement

State the change the product creates, and the people who receive it.

Do not state a feature list, a technology, or a market size.

Reject a vision that no target user would recognize as valuable.

## Target users

Name a specific group with a shared need.

Reject "everyone", "all users", and "any company".

State the obstacle that stops the group today.

Split a row when two groups need different results.

## Problem

State the problem from the user's side.

Do not state the absence of the solution as the problem.

Do not include a proposed answer.

## Intended outcomes

Create an `OUT` item for a change in the user's world.

Do not create an `OUT` item for a feature, a task, or a deliverable.

Write the outcome so that a person can tell whether it happened.

State the observable signal in `How we will know`, or record `Not yet decided`.

Keep the outcome count small. Prefer three to seven outcomes for a new product.

Record a rejected or dropped outcome as retired, and keep its ID.

## Scope boundaries

Put a capability in `## In scope` only when it serves a named `OUT` item.

Describe the capability as a business result, and not as a component.

Put a boundary in `## Out of scope` when a reader could reasonably expect it.

State the reason a boundary is out, so a later reader does not reopen it.

Treat `## Out of scope` as the strongest tool against scope creep. Use it often.

## Assumptions

Create an `ASM` item for a claim the product depends on and nobody has proven.

State what breaks if the claim is false.

State the cheapest check that could disprove it.

Do not convert an assumption into a fact without evidence the builder confirms.

Name the evidence and its date when an assumption becomes a fact.

## Identifiers

Use `OUT-01` for an outcome, and `ASM-01` for an assumption.

Number an ID once, and never reuse or renumber it.

Mark a removed item as retired, and keep its row.

## Readiness gate

Set `status` to `ready` only when all statements are true:

- The vision statement names a change and the people who receive it.
- Every target-user row names a specific group, a need, and an obstacle.
- The problem holds no proposed solution.
- At least one `OUT` item exists, and each one is a change in the user's world.
- Every `## In scope` item serves a named `OUT` item.
- `## Out of scope` holds at least one boundary with a reason.
- No section holds a bracketed placeholder.
- No statement names a technology, screen, or error code.
- No open question can change the vision, an outcome, or a scope boundary.

Keep `status` as `draft` when one statement is false, and report which one.

An open question that cannot change the vision, an outcome, or a scope boundary does not block readiness. Leave it recorded.
