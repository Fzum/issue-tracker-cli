# Breakdown rules

## Input boundary

Use `docs/prd.md` as the only input.

Treat `ready` as the expected PRD status.

Treat a missing or `draft` PRD as an input gap. Report it, and recommend `/vision`.

The builder can confirm an exception when a provisional breakdown is useful. Record the exception in the report.

Do not invent an outcome, a scope boundary, or a target user.

Do not edit `docs/prd.md` in this skill.

Report a blocker when a story needs a product decision, and recommend `/vision` for it.

Do not read `docs/architecture.md` or `docs/adr/`. A story holds no technical content, so the architecture cannot change it.

## Business language

Write every line in the words a user or a stakeholder would use.

Do not name a programming language, framework, library, vendor, cloud service, data store, protocol, message format, error code, HTTP status, endpoint, screen, button, or field.

Do not describe a mechanism. State the result a person gets.

Replace a technical word with the business result behind it:

| Do not write | Write |
| --- | --- |
| returns `401` | is told clearly that it failed, and is not let in |
| sets a session cookie | stays identified until they sign out |
| validates the form client-side | is told about a mistake before they submit |
| writes a row to the audit table | can later see who changed the record, and when |
| exposes a `GET /orders` endpoint | can see the list of their own orders |

Record a technical constraint the builder raises in the story `## Out of scope` section, or report it and recommend `/architecture`.

## Milestones

Create a milestone for a business theme that delivers one or more `OUT` items.

Give each milestone a result the business can name and can use.

Do not create a milestone for a technical layer, a phase, or a quarter.

Do not create a milestone named `Setup`, `Foundation`, `Infrastructure`, or `Cleanup`.

Prefer three to six milestones for a new product.

Order milestones so that the earliest one delivers real user value.

Make the first milestone the thinnest complete path a person can use.

Every `OUT` item in the PRD must be served by at least one milestone.

## Epics

Create an epic for one business capability inside the milestone.

Name the capability by what a person can do, not by a component.

Prefer two to five epics per milestone.

Give each epic at least two stories, so it stays a container.

Split an epic when it holds two unrelated capabilities.

## Stories

Create a story for one business intent a person can accept or reject alone.

Write the intent as `As a <role>, I want <result>, so that <benefit>`.

Take the role from the PRD `## Target users` table. Do not invent a role.

Give each story two to six acceptance criteria.

Write each criterion as an observable result in the user's world.

Include the unhappy path when a person can reasonably reach it.

Reject a criterion that names a mechanism, a screen, a code, or a technology.

Reject a criterion a business reader cannot judge.

Split a story when it holds two intents, or when it needs more than six criteria.

Do not create a story for a technical task. Fold the work into the story whose result needs it.

Keep the tree at three levels. Add a fourth level only when the builder asks for it.

## Dependencies

Record a `blocked_by` entry only when the later work has no business meaning before the earlier work.

Do not record a technical build order as a dependency.

Do not record a preference, a convenience, or a team habit as a dependency.

Put the entry on the container when it applies to every child.

Put the entry on the story when it applies to one story.

Prefer to express order through the stem number, and use `blocked_by` only for a real cross-branch dependency.

Verify that no cycle exists before you write the files.

## Rebreakdown

Use this route when the work-package directory already holds files.

1. Read every existing work-package file.
2. Record every file whose `status` is `doing` or `done`.
3. Match each existing file to the PRD by its stem and its `short_description`.
4. Classify each file as unchanged, changed, or no longer wanted.
5. Classify each PRD item with no file as new.
6. Write a new file for each new item. Use the next free number at that level.
7. Rewrite only the changed part of a changed file.
8. Write nothing for an unchanged file.
9. Leave every `status:` line exactly as you found it.
10. Ask the builder to confirm before you rewrite the body of a file whose `status` is `doing`.
11. Ask the builder to confirm before you retire a story.
12. Retire a story by setting `status: done` and by prefixing `short_description` with `[RETIRED]`.
13. Delete the `status:` line of a work package that now has a child, and write no status back.
14. Run the check, and repair only the files this session wrote.
15. Name every untouched file in the report, and say why it was untouched.

Do not rename a file. A rename changes the ID, and every reference to it breaks.

Do not delete a file. Retire it instead.

Do not renumber a stem.

Do not touch a work package the builder added by hand and the PRD does not describe. Name it in the report.

## Stop conditions

Stop and report when one statement is true:

- The PRD holds a bracketed placeholder in a section you need.
- The PRD contradicts itself about an outcome or a scope boundary.
- A story needs a product decision the PRD does not hold.
- The builder asks for a technical answer inside a story.
- The dependency graph holds a cycle you cannot resolve without a product decision.
- Two existing files claim the same stem.

## Readiness gate

Hand over the breakdown only when all statements are true:

- The check exits `0`.
- Every `OUT` item in the PRD is served by at least one milestone.
- Every milestone names a business theme, and not a technical phase.
- Every epic holds at least two stories, or the builder confirmed it as a leaf.
- Every story holds an intent with a role from the PRD.
- Every story holds two to six acceptance criteria.
- No line names a technology, screen, endpoint, or error code.
- No file holds a bracketed placeholder.
- Every new story holds `status: todo`.
- No container holds a `status` line.
- Every `blocked_by` entry names a stem that has a file.
- The dependency graph holds no cycle.

Report which statement is false when you cannot hand over.
