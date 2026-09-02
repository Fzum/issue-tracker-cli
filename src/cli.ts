/**
 * The process contract: the argv grammar, the help text, dispatch, the colour probe,
 * the only stdout/stderr writes, and the exit codes.
 *
 * Exit codes: 0 success (including an empty queue), 1 only from `wp check` finding
 * problems, 2 usage error / unknown ID / unreadable directory. `WpError` subclasses
 * are what this module converts into exit 2; anything else propagates as a crash.
 *
 * The entry guard deliberately lives in wp.ts, NOT here: it is only true in the
 * process entry file, so moving it would make the CLI a silent no-op.
 */

import { UsageError, WpError } from "./model.ts";
import { loadGraph, scanDirectory } from "./store.ts";
import { check } from "./check.ts";
import { finishWp, startWp } from "./transitions.ts";
import {
  formatCheck,
  formatNext,
  formatShow,
  formatTransition,
} from "./render.ts";
import { formatTree, formatTreeJson } from "./tree.ts";

interface CliArguments {
  readonly command: "next" | "show" | "tree" | "check" | "start" | "done";
  readonly directory: string;
  readonly asJson: boolean;
  readonly allReady: boolean;
  readonly force: boolean;
  readonly id: string | null;
  readonly scope: string | null;
}

const COMMANDS = ["next", "show", "tree", "check", "start", "done"] as const;
const ID_COMMANDS = new Set(["show", "start", "done"]);
/** The two commands that read a queue, and so are the two `--scope` can narrow. */
const SCOPED_COMMANDS = new Set(["next", "tree"]);

const HELP = `usage: wp [--dir PATH] [--json] {next,show,tree,check,start,done} ...

Markdown-native work-package tracker.

commands:
  next              print ready work
  show ID           show one work package
  tree              show the work-package tree
  check             validate work packages
  start ID          claim a ready leaf by setting status: doing
  done ID           release a claimed leaf by setting status: done

options:
  --dir PATH        work-package directory (default: ./wps)
  --json            emit machine-readable JSON
  --all             with next, print the whole ready queue
  --scope ID        with next or tree, restrict to ID and everything under it
  --force           with start or done, skip the readiness and claim checks
  -h, --help        show this help message`;

/** Colour only for a real terminal, and never when NO_COLOR is set. */
function useColour(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/** Returns null when help was requested; throws `UsageError` on a bad argv. */
function parseArguments(argv: readonly string[]): CliArguments | null {
  let directory = "wps";
  let asJson = false;
  let allReady = false;
  let force = false;
  let scope: string | null = null;
  let command: CliArguments["command"] | null = null;
  const commandArguments: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--help" || argument === "-h") {
      return null;
    } else if (argument === "--json") {
      asJson = true;
    } else if (argument === "--all") {
      if (command !== "next") throw new UsageError("unrecognized argument: --all");
      allReady = true;
    } else if (argument === "--force") {
      if (command !== "start" && command !== "done") {
        throw new UsageError("unrecognized argument: --force");
      }
      force = true;
    } else if (argument === "--scope" || argument.startsWith("--scope=")) {
      // A scope is the ID of a milestone, an epic or a single story; which of the
      // three it is falls out of the stem depth, so there is nothing to declare.
      if (command === null || !SCOPED_COMMANDS.has(command)) {
        throw new UsageError("unrecognized argument: --scope");
      }
      const inline = argument.startsWith("--scope=")
        ? argument.slice("--scope=".length)
        : null;
      const value = inline ?? argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new UsageError("argument --scope: expected one value");
      }
      scope = value;
      if (inline === null) index += 1;
    } else if (argument === "--dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("argument --dir: expected one value");
      }
      directory = value;
      index += 1;
    } else if (argument.startsWith("--dir=")) {
      directory = argument.slice("--dir=".length);
    } else if (argument.startsWith("-")) {
      throw new UsageError(`unrecognized argument: ${argument}`);
    } else if (command === null) {
      if (!(COMMANDS as readonly string[]).includes(argument)) {
        throw new UsageError(`unknown command: ${argument}`);
      }
      command = argument as CliArguments["command"];
    } else {
      commandArguments.push(argument);
    }
  }

  if (command === null) throw new UsageError("a command is required");

  if (ID_COMMANDS.has(command)) {
    if (commandArguments.length !== 1) {
      throw new UsageError(`${command} requires exactly one ID`);
    }
  } else if (commandArguments.length !== 0) {
    throw new UsageError(`${command} does not accept positional arguments`);
  }

  return {
    command,
    directory,
    asJson,
    allReady,
    force,
    id: ID_COMMANDS.has(command) ? (commandArguments[0] ?? null) : null,
    scope,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const args = parseArguments(argv);
    if (args === null) {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }

    // `check` reads the scan directly so it can report on files loadGraph refuses.
    if (args.command === "check") {
      const problems = check(scanDirectory(args.directory));
      process.stdout.write(formatCheck(problems, args.asJson));
      return problems.length > 0 ? 1 : 0;
    }

    const graph = loadGraph(args.directory);
    if (args.command === "next") {
      process.stdout.write(formatNext(graph, args.allReady, args.asJson, args.scope));
    }
    if (args.command === "show") {
      process.stdout.write(formatShow(graph, args.id as string, args.asJson));
    }
    if (args.command === "tree") {
      process.stdout.write(
        args.asJson
          ? formatTreeJson(graph, args.scope)
          : formatTree(graph, useColour(), args.scope),
      );
    }
    if (args.command === "start") {
      process.stdout.write(
        formatTransition(startWp(graph, args.id as string, args.force), args.asJson),
      );
    }
    if (args.command === "done") {
      process.stdout.write(
        formatTransition(finishWp(graph, args.id as string, args.force), args.asJson),
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof WpError) {
      process.stderr.write(`wp: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}
