#!/usr/bin/env bun
/**
 * Serves a live view of `wps/` in a browser, as specified by `docs/board.md`: one
 * HTML page, one JSON route, and no writes ever. `wp start` and `wp done` remain
 * the only write path (invariant 6); nothing here opens a work-package file.
 *
 * Like `orchestrate.ts` it is an entry point of its own and not part of the CLI:
 * it drives `wp.ts` as a subprocess and imports nothing from `src/`, so the JSON
 * `wp tree` prints is the contract between the two, not a function signature.
 *
 * There is no file watcher (§2). The client polls and the server rescans per poll
 * by spawning the CLI, which buys three things a watcher does not get for free:
 * no partial-write handling (`fs.watch` fires while an agent is halfway through a
 * file, whereas a poll either catches a valid tree or catches an error, and §7
 * says what to do with the error), restart resilience (kill the server and the
 * open tab recovers on its next poll, with no reconnect logic), and no debounce
 * to tune (a write-temp-then-rename is a burst of watch events and exactly one
 * changed poll).
 *
 * Read it in five passes, top to bottom:
 *   1. vocabulary       — the five states, the rows, the payload, the constants
 *   2. the board state  — `boardState`, the one pure function holding §3–§5
 *   3. reading the tree — the one `Bun.spawn` wrapper and the tolerant parser
 *   4. the routes       — `/` and `/api/state`, and no more
 *   5. the command line — argv, `--open`, main
 */

import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// ── 1. Vocabulary ────────────────────────────────────────────────────────────

const TOOL_DIRECTORY = import.meta.dir;
const CLI_PATH = join(TOOL_DIRECTORY, "wp.ts");
/** The whole client, one self-contained file, read from disk beside this one. */
const CLIENT_FILENAME = "board.html";
const CLIENT_PATH = join(TOOL_DIRECTORY, CLIENT_FILENAME);
const DEFAULT_PORT = 4400;
const DEFAULT_DIRECTORY = "wps";
/**
 * Loopback only, and no authentication anywhere in this file: a local
 * development tool with no reachable surface has nothing to protect. Binding
 * anything wider is what would create the problem a password then solves (§10).
 */
const HOSTNAME = "127.0.0.1";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const MAXIMUM_PORT = 65535;

export class BoardError extends Error {}

/** One row of `wp tree --json`, as much of it as the board reads. */
export interface TreeRow {
  readonly id: string;
  readonly parent: string | null;
  readonly depth: number;
  /** `null` is a container whose children carry no status — `wp check`'s problem. */
  readonly status: string | null;
  readonly short_description: string;
  readonly unmet_blockers: readonly string[];
}

export type BoardRowState =
  | "container"
  | "done"
  | "doing"
  | "ready"
  | "blocked"
  | "invalid";

export interface BoardRow {
  readonly id: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly state: BoardRowState;
  readonly short_description: string;
  readonly unmet_blockers: readonly string[];
  readonly leaves_done: number;
  readonly leaves_total: number;
}

export interface BoardSummary {
  readonly done: number;
  readonly doing: number;
  readonly ready: number;
  readonly blocked: number;
  readonly total: number;
}

export interface BoardState {
  readonly hash: string;
  readonly ok: true;
  readonly summary: BoardSummary;
  readonly rows: readonly BoardRow[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 2. The board state — pure: no filesystem, no network, no clock ───────────

/**
 * Leaf descendants of one container, at any depth. Mutable where the rest of this
 * file is `readonly`, because the counts accumulate one leaf at a time.
 */
interface LeafTally {
  done: number;
  total: number;
}

/** What a leaf row reports: `0` and `0`. Frozen by its type, since it is shared. */
const EMPTY_TALLY: Readonly<LeafTally> = { done: 0, total: 0 };

/**
 * Each row's parent as the wire will carry it: the id it names, or `null` when no
 * row carries that id.
 *
 * A dangling `parent` is a normal state, not a corrupt one: `wp tree` renders a
 * work package whose parent *file* is missing — which `wp check` reports and
 * explains — and `wp tree --scope` names a scope root's parent, which is outside
 * the scope by definition. Such a row becomes a root rather than being dropped, so
 * a broken tree stays visible. Do not "fix" this into dropping the row: nesting on
 * `parent === null` is the only thing the client knows about hierarchy, and a
 * dropped row is a work package that has silently vanished.
 */
function parentMap(treeRows: readonly TreeRow[]): Map<string, string | null> {
  const ids = new Set(treeRows.map((row) => row.id));
  return new Map(
    treeRows.map((row): [string, string | null] => [
      row.id,
      row.parent !== null && ids.has(row.parent) ? row.parent : null,
    ]),
  );
}

/**
 * Every id above this one. `parent` crosses a JSON boundary, so it is not
 * necessarily the strictly shorter stem `parentId` returned when it was written;
 * the seen set is what stops a garbled tree from hanging the server in a cycle.
 */
function* ancestorsOf(
  id: string,
  parentOf: ReadonlyMap<string, string | null>,
): Generator<string> {
  const seen = new Set([id]);
  let current = parentOf.get(id) ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = parentOf.get(current) ?? null;
  }
}

/**
 * The state of a leaf, in precedence order — and that order is the point.
 * `done` and `doing` outrank blocked: work already under way is reported as it
 * stands, and only a work package that has not started reads as unstartable.
 * Inherited from `statusGlyph` in `src/tree.ts` (§4), and it must not drift from
 * it, or the board and the tree disagree about the same file.
 *
 * `unmet_blockers` is the source, never the raw `blocked_by`: it is the list
 * `wp start` refuses on, so the board can never call something `ready` that
 * `wp start` would refuse.
 *
 * Anything else — `null`, or a status that is not one of the three — is
 * `invalid`. That is a problem `wp check` reports, and the board's job is to show
 * it rather than to guess which of the five states was meant.
 */
function leafState(row: TreeRow): BoardRowState {
  if (row.status === "done") return "done";
  if (row.status === "doing") return "doing";
  if (row.status === "todo") return row.unmet_blockers.length === 0 ? "ready" : "blocked";
  return "invalid";
}

/**
 * `leaves_done` / `leaves_total` per container: leaf descendants at **any** depth,
 * reached by walking the parent map transitively.
 *
 * `wp tree` counts direct children — a milestone of three epics prints `0/3` with
 * eight of its nine stories done — which is right for a dense one-screen tree and
 * wrong for a progress bar, which is read as "how far along is this". The
 * divergence is deliberate (§5) and it will eventually be reported as a bug, so
 * do not "fix" it into agreement with the tree.
 *
 * Leaves are the only rows that carry work, so they are the only sound unit to
 * count, and `doing` fills neither half of the bar: the bar is `done / total`, and
 * the summary's state counts carry the rest.
 */
function leafTallies(
  treeRows: readonly TreeRow[],
  parentOf: ReadonlyMap<string, string | null>,
  stateOf: ReadonlyMap<string, BoardRowState>,
): Map<string, LeafTally> {
  const tallies = new Map<string, LeafTally>();
  for (const row of treeRows) {
    const state = stateOf.get(row.id) ?? "invalid";
    if (state === "container") continue;
    for (const ancestor of ancestorsOf(row.id, parentOf)) {
      const tally = tallies.get(ancestor) ?? { done: 0, total: 0 };
      tally.total += 1;
      if (state === "done") tally.done += 1;
      tallies.set(ancestor, tally);
    }
  }
  return tallies;
}

/**
 * The whole payload, minus the one field it cannot know: `project`, which the
 * route adds.
 *
 * Every rule of §3, §4 and §5 lives in here, and it touches no filesystem, no
 * network and no clock — that is what makes the board testable against literal
 * arrays, and what leaves the untestable client with nothing but rendering (§9).
 */
export function boardState(treeRows: readonly TreeRow[]): BoardState {
  const parentOf = parentMap(treeRows);
  /**
   * A container is an id some row names as its parent. Never derived from the id
   * string — `"wp-m10e1".startsWith("wp-m1")` is `true`, so a prefix match sweeps
   * a whole other milestone into this one's progress bar — and never from the row
   * order, which a missing parent file silently shifts. Every other row is a leaf,
   * and leaves are the only rows that carry work.
   */
  const containers = new Set(
    [...parentOf.values()].filter((id): id is string => id !== null),
  );

  const stateOf = new Map<string, BoardRowState>(
    // A container keeps `container` even when it carries unmet blockers of its
    // own: it still shows them, but the bar is the more useful thing in that row
    // (§4), so it does not take the `blocked` state.
    treeRows.map((row): [string, BoardRowState] => [
      row.id,
      containers.has(row.id) ? "container" : leafState(row),
    ]),
  );
  const tallies = leafTallies(treeRows, parentOf, stateOf);

  // Row order is the input's, which is `wp tree`'s own pre-order: parents first,
  // which is what lets the client nest as it walks.
  const rows = treeRows.map((row): BoardRow => {
    const tally = tallies.get(row.id) ?? EMPTY_TALLY;
    return {
      id: row.id,
      parent: parentOf.get(row.id) ?? null,
      depth: row.depth,
      state: stateOf.get(row.id) ?? "invalid",
      short_description: row.short_description,
      unmet_blockers: row.unmet_blockers,
      leaves_done: tally.done,
      leaves_total: tally.total,
    };
  });

  const leaves = rows.filter((row) => row.state !== "container");
  const leavesIn = (state: BoardRowState): number =>
    leaves.filter((row) => row.state === state).length;

  return {
    // Over the serialized rows, so the client can skip a re-render — and
    // therefore skip destroying DOM the user is mid-scroll in — on the unchanged
    // tree almost every poll returns. It is also why the payload carries no
    // timestamp: one would change every poll and defeat this entirely (§6).
    hash: Bun.hash(JSON.stringify(rows)).toString(16),
    ok: true,
    summary: {
      done: leavesIn("done"),
      doing: leavesIn("doing"),
      ready: leavesIn("ready"),
      blocked: leavesIn("blocked"),
      // Leaves, so the header bar reads `done / total leaves` (§5). An `invalid`
      // leaf is counted here and in none of the four above, which is why they can
      // sum to less than this.
      total: leaves.length,
    },
    rows,
  };
}

// ── 3. Reading the tree — the only place `Bun.spawn` is called ───────────────

/**
 * Either a tree or the one line explaining why there isn't one. A non-zero exit
 * is a normal event, not an exception: agents write these files while the board
 * watches, so catching a half-written one is expected, and §7 turns it into a
 * banner over the last good tree rather than a crash.
 */
type TreeRead =
  | { readonly ok: true; readonly rows: readonly TreeRow[] }
  | { readonly ok: false; readonly error: string };

/**
 * Whatever `wp tree --json` printed, tolerantly. A row with no `id` is the one
 * thing worth refusing outright — everything else the board can render as-is,
 * because a tree that is odd but readable is more use on screen than an error.
 */
export function parseTreeRows(json: string): TreeRow[] {
  const trimmed = json.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new BoardError(`cannot read the tree: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new BoardError("cannot read the tree: expected a JSON array");
  }

  return parsed.map((entry): TreeRow => {
    const fields = (typeof entry === "object" && entry !== null ? entry : {}) as {
      id?: unknown;
      parent?: unknown;
      depth?: unknown;
      status?: unknown;
      short_description?: unknown;
      unmet_blockers?: unknown;
    };
    if (typeof fields.id !== "string" || !fields.id) {
      throw new BoardError("cannot read the tree: a row has no id");
    }
    return {
      id: fields.id,
      // A root has `parent: null`, and an older `wp` has no such key at all;
      // both are the same thing here. The stem is never consulted to fill it in —
      // this file must not know the stem grammar, which is the whole reason the
      // field is on the wire (§3).
      parent: typeof fields.parent === "string" ? fields.parent : null,
      depth: typeof fields.depth === "number" ? fields.depth : 0,
      // `null` is a container whose children carry no status — `wp check`'s problem.
      status: typeof fields.status === "string" ? fields.status : null,
      short_description:
        typeof fields.short_description === "string" ? fields.short_description : "",
      unmet_blockers: Array.isArray(fields.unmet_blockers)
        ? fields.unmet_blockers.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    };
  });
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run one command with no shell in between; an argument list has nothing to quote. */
async function execute(command: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [...command],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

/**
 * Why a poll failed, in one line: stderr if it said anything, else stdout, else
 * the exit code alone. `||` and not `??`, because an empty first line is `""`.
 *
 * No prefix is added — `wp` already prefixes its own stderr with `wp: `, and the
 * banner should read like the CLI the reader would run by hand to see the same
 * thing.
 */
function failureLine(result: CommandResult): string {
  const firstLine = (output: string): string =>
    (output.split("\n").find((line) => line.trim()) ?? "").trim();
  return firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`;
}

/**
 * One rescan: spawn the CLI and read its rows. Run through this same Bun binary
 * rather than the shebang, exactly as `orchestrate.ts` does, so the file mode of
 * `wp.ts` is nobody's problem.
 *
 * A spawn that throws and JSON that will not parse land in the same place as a
 * non-zero exit, because to the reader waiting for a banner they are one event.
 */
async function readTree(wpsDirectory: string): Promise<TreeRead> {
  try {
    const result = await execute([
      process.execPath,
      CLI_PATH,
      "--dir",
      wpsDirectory,
      "tree",
      "--json",
    ]);
    if (result.exitCode !== 0) return { ok: false, error: failureLine(result) };
    return { ok: true, rows: parseTreeRows(result.stdout) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ── 4. The routes — two, and no more ─────────────────────────────────────────

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": TEXT_CONTENT_TYPE } });
}

/**
 * The client, re-read per request: editing `board.html` and reloading the tab is
 * the whole client development loop, and caching the file in memory would put a
 * server restart in the middle of it.
 */
function clientResponse(): Response {
  try {
    return new Response(readFileSync(CLIENT_PATH, "utf8"), {
      headers: { "Content-Type": HTML_CONTENT_TYPE },
    });
  } catch (error) {
    // Name the path. A silently blank page is worse than any message, because it
    // looks like the board found nothing rather than like a broken install.
    return textResponse(`cannot read ${CLIENT_PATH}: ${errorMessage(error)}\n`, 500);
  }
}

/**
 * The payload of §6, or the failure payload of §7 — and both with HTTP **200**.
 * A 4xx or 5xx would make the browser's own machinery report it and make the
 * board itself look broken; the client has to be able to read the message, keep
 * the last good tree on screen underneath a banner, and clear it on the next
 * poll. `project` is added here rather than inside `boardState` because it is the
 * one field that comes from the process, and `boardState` stays pure.
 */
async function stateResponse(wpsDirectory: string, project: string): Promise<Response> {
  const read = await readTree(wpsDirectory);
  const payload = read.ok
    ? { ...boardState(read.rows), project }
    : { ok: false, error: read.error, project };
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      // Without this a poll every second is answered from the browser's cache and
      // a live board looks frozen.
      "Cache-Control": "no-store",
    },
  });
}

/** The two routes of §6, and the 404 that is every other path. */
function handleRequest(
  request: Request,
  wpsDirectory: string,
  project: string,
): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/") return clientResponse();
  if (pathname === "/api/state") return stateResponse(wpsDirectory, project);
  return textResponse(`no route ${pathname}\n`, 404);
}

/** Listen, or say which port is taken. Never returns the server: nothing stops it. */
function serveBoard(port: number, wpsDirectory: string, project: string): void {
  try {
    Bun.serve({
      hostname: HOSTNAME,
      port,
      fetch: (request) => handleRequest(request, wpsDirectory, project),
    });
  } catch (error) {
    // `EADDRINUSE` on its own is not an answer, and the usual cause is a board
    // already serving this port — so name it.
    throw new BoardError(`cannot listen on port ${port}: ${errorMessage(error)}`);
  }
}

// ── 5. The command line — argv, --open, main ─────────────────────────────────

function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface CliArguments {
  readonly directory: string;
  readonly port: number;
  readonly open: boolean;
}

const HELP = `usage: wp-board [--dir PATH] [--port N] [--open]

Serve a live view of the work-package tree in a browser: one page, one JSON
route, and no writes — wp start and wp done remain the only write path.

options:
  --dir PATH   work-package directory (default: ./${DEFAULT_DIRECTORY})
  --port N     port to listen on, loopback only (default: ${DEFAULT_PORT})
  --open       open the default browser at startup
  -h, --help   show this help message

exit codes:
  0            nothing to serve — this help
  2            usage error, or the port is already in use

A board that starts serving runs until interrupted, and then exits on the signal
that stopped it: 130 for Ctrl-C, never 0.`;

/** `--port=4400` -> `["--port", "4400"]`; `--port` -> `["--port", null]`. */
function splitFlag(argument: string): readonly [string, string | null] {
  const separator = argument.indexOf("=");
  return separator === -1
    ? [argument, null]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}

/** A flag value that is present but empty is still a missing one. */
function requireValue(value: string, name: string): string {
  if (value === "") throw new BoardError(`argument ${name}: expected one value`);
  return value;
}

/** A bad port is a usage error, not a crash at bind time. */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > MAXIMUM_PORT) {
    throw new BoardError(`argument --port: expected 1..${MAXIMUM_PORT}, not ${value}`);
  }
  return port;
}

/** Returns null when help was requested; throws `BoardError` on a bad argv. */
function parseArguments(argv: readonly string[]): CliArguments | null {
  let directory = DEFAULT_DIRECTORY;
  let port = DEFAULT_PORT;
  let open = false;

  /** The value a flag needs. Another flag is not a value, it is a missing one. */
  const valueAfter = (index: number, name: string): string => {
    const value = argv[index];
    if (value === undefined || value.startsWith("-")) {
      throw new BoardError(`argument ${name}: expected one value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--help" || argument === "-h") return null;
    if (argument === "--open") {
      open = true;
      continue;
    }

    // `--flag=value` and `--flag value` are one option, so split the `=` form once
    // and read the value from whichever side carried it — lazily, so that an
    // unrecognized flag reports itself instead of a missing value.
    const [name, inline] = splitFlag(argument);
    const flagValue = (): string => inline ?? valueAfter(index + 1, name);

    // An empty value is a missing one, not the current directory: `--dir=` would
    // otherwise resolve to the cwd and every poll would answer with a banner
    // blaming whatever unrelated file it found there. `--port=` is already refused
    // by `parsePort`, so this keeps the two flags consistent.
    if (name === "--dir") directory = requireValue(flagValue(), name);
    else if (name === "--port") port = parsePort(flagValue());
    // The whole argument, not the split name: `--host=0.0.0.0` must echo back what
    // the user actually typed.
    else throw new BoardError(`unrecognized argument: ${argument}`);

    // The `--flag value` form spent the next argument as well.
    if (inline === null) index += 1;
  }

  return { directory, port, open };
}

/** Whatever this platform calls "open this in the browser I already use". */
function openerFor(url: string): string[] {
  if (process.platform === "darwin") return ["open", url];
  // The empty string is the window title `start` would otherwise take the URL
  // for, which opens a console window and no browser.
  if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

/**
 * Best effort, and never fatal: a machine with no opener — a container, a bare
 * server, WSL without `wslu` — must still get a working board and the printed URL.
 */
function openBrowser(url: string): void {
  try {
    Bun.spawn({
      cmd: openerFor(url),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Nothing to open with. The URL is on stdout, which is the fallback.
  }
}

/**
 * There is no exit code `1` here, deliberately: a tree that cannot be read is a
 * payload the client shows as a banner (§7), not a verdict about the run. The
 * only refusals are before the first request is served.
 *
 * The `0` this returns after `serveBoard` is never the process's status either:
 * `Bun.serve` holds the event loop open, so the run ends on whatever signal stops
 * it — 130 for Ctrl-C. `0` is reachable only through `--help`.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args === null) {
      printLine(HELP);
      return 0;
    }

    const wpsDirectory = resolve(process.cwd(), args.directory);
    // The one field `boardState` cannot derive, and a constant rather than a
    // clock, so it does not defeat `hash` (§6). §8 puts it in the header.
    const project = basename(process.cwd());
    serveBoard(args.port, wpsDirectory, project);

    const url = `http://${HOSTNAME}:${args.port}`;
    printLine(`serving ${url}`);
    printLine(`reading ${wpsDirectory}`);
    if (args.open) openBrowser(url);
    // `Bun.serve` holds the event loop open, so the process stays up after this
    // resolves and ends on Ctrl-C.
    return 0;
  } catch (error) {
    if (error instanceof BoardError) {
      process.stderr.write(`board: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  // Both halves are load-bearing for the two reasons recorded in CLAUDE.md: a
  // reader that closes the pipe early raises EPIPE at flush time, where a
  // try/catch around `main` cannot see it, and `process.exit()` would discard
  // buffered stdout past 128 KiB.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });

  process.exitCode = await main();
}
