# Skills — the planning half

Three Claude Code skills that produce the work the tracker runs. They ship in this
repository as the `delivery` plugin (`.claude-plugin/plugin.json`), because
`/breakdown` writes the `wps/` files `wp` reads — one repository means the format
rules and the parser that enforces them can never drift apart.

| Skill | Writes | Reads |
|---|---|---|
| `/vision` | `docs/prd.md` — vision, users, problem, outcomes (`OUT`), scope, assumptions | the builder, and existing code only to answer a question about current behaviour |
| `/architecture` | `docs/architecture.md` and `docs/adr/NNN-<slug>.md` | `docs/prd.md`, plus the repository as the existing baseline |
| `/breakdown` | `wps/wp-*.md` — milestones, epics, stories | `docs/prd.md` only |

`/breakdown` and `/architecture` are independent and may run in either order.
`/breakdown` deliberately never reads `docs/architecture.md`: a story records
business intent, so a technical decision cannot change it.

The full pipeline:

```
/vision → docs/prd.md → /breakdown → wps/ → wp next → orchestrate.ts → worker agents
                      ↘ /architecture → docs/architecture.md + docs/adr/
```

## Install

The skills must be available in **your product project**, not here. A plugin is
what makes that work; `.claude/skills/` would scope them to this repository only.

For one session:

```sh
claude --plugin-dir /path/to/issue-tracker-cli
```

To install persistently, from inside a Claude Code session:

```
/plugin install /path/to/issue-tracker-cli
```

Each skill answers to `/delivery:vision`, `/delivery:architecture` and
`/delivery:breakdown`. The bare `/vision`, `/architecture` and `/breakdown` also
work unless another command already claims the name.

Verify the manifest and the three skills before you commit a change to them:

```sh
claude plugin validate .
```

## How `/breakdown` reaches the tracker

`bun run wp` only resolves inside this directory, so a skill running in a product
project cannot use it. `skills/breakdown/SKILL.md` defaults the tracker command to
`bun "${CLAUDE_PLUGIN_ROOT}/wp.ts"` instead. Claude Code substitutes
`${CLAUDE_PLUGIN_ROOT}` with the plugin's install directory, which is this
repository — so the skill finds `wp.ts` wherever the plugin was installed from.

The builder may confirm a different command at the start of a session. Every later
reference calls it `<tracker command>`; no reference file hardcodes a path.

## Where the rules live

`skills/breakdown/references/wp-format.md` is the short form of the work-package
file format, written for a breakdown session. [`docs/design.md`](../docs/design.md)
is the authority — §2.1 for the stem grammar, §3 for the field reference, §7 for
the eleven `wp check` rules, §8.1 for the frontmatter subset. Change
`docs/design.md` first, then correct `wp-format.md`.

`docs/design.md` §9 describes this planning pass as a hypothetical "BA agent".
`skills/breakdown/` is that agent, with one difference worth knowing: §9 splits the
work into two passes, writing `blocked_by` only in the second. The skill does both
in one session, because it confirms every dependency with the builder as it goes.

## Layout

Each skill is a directory with `SKILL.md` plus two conventional folders:

```
skills/<name>/
├── SKILL.md          the procedure — frontmatter (name, description) and the session flow
├── references/       rules loaded on demand, when SKILL.md links to them
└── assets/           templates the skill fills in
```

Only `SKILL.md` loads up front. Everything under `references/` and `assets/` costs
nothing until a link is followed, so keep the long material there and keep
`SKILL.md` to the flow.
