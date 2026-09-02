---
name: breakdown
description: Break an approved PRD into milestones, epics, and user stories, and write them directly as work-package files the wp issue tracker can read. Use for a first breakdown, a rebreakdown after a PRD change, or a breakdown review. Do not use for technical design, technology selection, acceptance-test detail, estimates, or implementation.
---

# Breakdown

Break the approved PRD into a tree of milestones, epics, and user stories. Write the tree directly as work-package files. The builder confirms every milestone, epic, and story.

The output is the business record of the work. A person from the business side must be able to read a story and approve it.

## Limits

- Write one work-package file per milestone, epic, and story in `wps/`.
- Use the PRD as the only input.
- Use business language only.
- Do not name a technology, framework, vendor, data store, protocol, error code, endpoint, screen, or button.
- Do not read or reference `docs/architecture.md` or `docs/adr/`.
- Do not change the PRD, an outcome, or a scope boundary.
- Do not create an estimate, a sprint, a date, or an implementation task.
- Do not change code, dependencies, or an external system.
- Do not run `wp start`, `wp done`, or `git`.
- Save useful work if the session stops.

## Select one route

Read [breakdown-rules.md](references/breakdown-rules.md) and [wp-format.md](references/wp-format.md).

Read `docs/prd.md`.

Ask the builder once to confirm the work-package directory and the tracker command.

Use `wps/` and `bun "${CLAUDE_PLUGIN_ROOT}/wp.ts"` when the builder states no other values.

Call the confirmed value the tracker command. Never use `bun run wp`, because that only resolves inside the tracker's own directory.

Apply the input rule in [breakdown-rules.md](references/breakdown-rules.md) when the PRD is missing or `draft`.

- The directory holds no work-package file: build the whole tree from the PRD.
- The directory already holds work-package files: apply `## Rebreakdown` in [breakdown-rules.md](references/breakdown-rules.md).

## Conduct the session

- Start from the `OUT` items in the PRD.
- Propose the milestone list first, and get builder confirmation before you go deeper.
- Propose the epics of one milestone at a time.
- Propose the stories of one epic at a time.
- Keep each story to one business intent a person can accept or reject.
- Write every acceptance criterion as an observable result in the user's world.
- Reject an acceptance criterion that names a mechanism, a screen, or a code.
- Record a boundary the builder raises in the story `## Out of scope` section.
- Record a dependency only when the later story has no business meaning before the earlier one.
- Order milestones by user value and by real business dependency.
- Keep the tree shallow. Prefer three levels.
- Emit frontmatter from [wp-templates.md](assets/wp-templates.md) instead of composing YAML.
- Replace every bracketed placeholder before you write a file.
- Ask one focused question at a time.
- Get builder confirmation before you retire a story.
- Preserve a stem once you write it.
- Update the work-package files instead of creating a session report.

## Finish

Run `<tracker command> check --dir <work-package directory>`.

Repair only the files this session wrote, and run the check again.

Do not hand over a directory where the check reports a problem.

Apply the readiness gate in [breakdown-rules.md](references/breakdown-rules.md).

Recommend `<tracker command> tree` to see the whole tree, and `<tracker command> next` to get the first ready story.

Recommend `/vision` when a stop condition needs a product decision.

Recommend `/architecture` when the builder wants the technical plan.

Do not run `/vision`, `/architecture`, `wp next`, `wp start`, or `wp done`.

Report created files, updated files, untouched files and why, retired stories, and every open question.
