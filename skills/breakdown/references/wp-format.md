# Work-package file format

These rules come from the `wp` tracker. The tracker rejects a file that breaks one of them.

[`docs/design.md`](../../../docs/design.md) is the authority. This file is the short form for a breakdown session. Change `docs/design.md` first when the two disagree, then correct this file.

## Directory

Put every work-package file in one flat directory.

Use `wps/` when the builder states no other directory.

Do not create a subdirectory.

## Filename and identity

A filename is `wp-`, then one or more segments, then `.md`.

A segment is one lowercase letter, then one or more digits.

```
stem    := "wp-" segment+
segment := [a-z][0-9]+
```

The stem without `.md` is the ID of the work package. `wp-m1e1u1.md` has the ID `wp-m1e1u1`.

Do not write an `id` field. The filename is the ID.

Use these segment letters:

| Depth | Level | Segment letter | Example |
| --- | --- | --- | --- |
| 1 | milestone | `m` | `wp-m1.md` |
| 2 | epic | `e` | `wp-m1e1.md` |
| 3 | story | `u` | `wp-m1e1u1.md` |

Depth alone decides the level. The letter is a convention that keeps a stem readable.

Number each level from `1` inside its parent. The second epic of the first milestone is `wp-m1e2`.

Every parent file must exist. `wp-m1e1u1.md` requires `wp-m1e1.md` and `wp-m1.md`.

## Leaf and container

A work package is a **leaf** when no other stem extends it. A leaf is real work.

A work package is a **container** when another stem extends it. A milestone and an epic are containers.

An epic with no story is a leaf, so it carries a `status`. Prefer to give an epic at least two stories.

## Frontmatter

The block starts with `---` on the very first line of the file, and ends with the next `---`.

Each line inside is `key: value`, at column 0.

### Leaf fields

```yaml
---
status: todo
blocked_by: []
short_description: "One line a business reader understands"
---
```

| Field | Required | Value |
| --- | --- | --- |
| `status` | yes | `todo`, `doing`, or `done` |
| `blocked_by` | no, defaults to `[]` | flat list of stems that must finish first |
| `short_description` | yes | one non-empty line |

### Container fields

```yaml
---
short_description: "Milestone 1 — customers can sign up and get value"
---
```

A container must **not** carry `status`. A `status` on a container fails the check.

A container may carry `blocked_by`. It then applies to every descendant.

## Frontmatter limits

Write exactly the fields above, and no other field.

Write `blocked_by` as an inline list `[wp-m1e1u1, wp-m2e1]`, or as a block list:

```yaml
blocked_by:
  - wp-m1e1u1
  - wp-m2e1
```

Only `blocked_by` may take an empty value with a block list under it. Every other key needs a value on its own line.

Do not indent a key.

Do not write the same key twice.

Do not use a nested map, a multi-line scalar, an anchor, or a comment inside a value.

Wrap `short_description` in double quotes when it holds a colon.

## Dependencies

Point `blocked_by` at a stem, and never at a filename.

A container target counts as finished only when every descendant is finished.

Do not point a work package at itself.

Do not create a cycle.

Put a dependency on the container when it applies to every child. Put it on the story when it applies to one story.

## Body

Everything below the closing `---` is free markdown. The tracker does not read it.

Use the section shapes in [wp-templates.md](../assets/wp-templates.md).

## The check

Run the check on the directory, and require exit code `0`. Use the tracker command the session confirmed.

```
<tracker command> check --dir <work-package directory>
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | clean |
| 1 | the check found a problem |
| 2 | usage error, unknown ID, or unreadable directory |

The check reports these problems:

1. The filename does not match the stem grammar.
2. The frontmatter block is missing or has no closing `---`.
3. The frontmatter does not parse.
4. `short_description` is missing or empty.
5. `status` is missing on a leaf.
6. `status` is present on a container.
7. `status` is not `todo`, `doing`, or `done`.
8. A `blocked_by` entry names a stem with no file.
9. A `blocked_by` entry names the work package itself.
10. The `blocked_by` graph holds a cycle.
11. A stem has no parent file.

## Ordering

The tracker sorts by stem. It compares each segment by letter, then by number.

`wp-m2` sorts before `wp-m10`.

## Status ownership

The tracker owns the word in a `status:` line.

Write `status: todo` on a new story.

Do not change a `status:` line the tracker or the builder set to `doing` or `done`.
