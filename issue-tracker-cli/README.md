# Agentic Issue Tracker CLI

A read-only work-package tracker implemented as a single TypeScript module for
Bun 1.0+. It has no runtime dependencies.

## Development

Open this directory directly in IntelliJ IDEA, then install and verify the
project:

```sh
bun install
bun test
bun run typecheck
```

The tests use Given/When/Then naming and structure.

## Usage

Run from a project containing a `wps/` directory:

```sh
/path/to/issue-tracker-cli/wp.ts check
/path/to/issue-tracker-cli/wp.ts next
/path/to/issue-tracker-cli/wp.ts tree --json
```

Or run inside this directory and provide the work-package directory explicitly:

```sh
bun run wp --dir /path/to/project/wps check
```

Available commands are `next [--all]`, `show <id>`, `tree`, and `check`.
Every command supports `--json`; `--dir <path>` overrides the default `./wps`.

The full design is in [`docs/design.md`](docs/design.md); the brainstorming and
decision log behind it is in [`docs/vision.md`](docs/vision.md).
