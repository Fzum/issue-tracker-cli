#!/usr/bin/env bun
/**
 * Runs the work queue with parallel agents, as specified by
 * `docs/execution-model.md`: spawn everything `wp next --all` offers, wait for
 * the wave, then merge the branches back one at a time.
 *
 * Nothing here plans. Readiness is recomputed by `wp next` on every wave, so a
 * dependency enforces itself by simply not appearing in the queue.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const TOOL_DIRECTORY = import.meta.dir;
const CLI_PATH = join(TOOL_DIRECTORY, "wp.ts");
/**
 * The role prompt is the project's, not the tool's (D10): it names the project's
 * verification gate and its house rules. The tool ships one as a template.
 */
const ROLE_RELATIVE_PATH = join("prompts", "worker.md");
const ROLE_TEMPLATE_PATH = join(TOOL_DIRECTORY, ROLE_RELATIVE_PATH);
/** Glued between the role prompt and `wp show` output (execution model §8.1). */
const PROMPT_SEPARATOR = "\n\n---\n\n";
const LOG_DIRECTORY_NAME = "log";
const AGENT_COMMAND = "claude";
const DEFAULT_VERIFY_COMMAND = "bun test";
const MESSAGE_LIMIT = 200;

export class OrchestratorError extends Error {}

/** The step a work package fell over at, in the order the loop runs them. */
export type Stage = "start" | "setup" | "agent" | "merge" | "verify" | "release";

export interface Failure {
  readonly id: string;
  readonly stage: Stage;
  readonly message: string;
}

export interface RunReport {
  readonly waves: number;
  readonly merged: readonly string[];
  readonly failed: readonly Failure[];
}

export interface QueueEntry {
  readonly id: string;
  readonly description: string;
}

/**
 * Every side effect the loop needs, in the order it calls them. The loop owns
 * the bookkeeping and the driver owns the commands, so wave order and merge
 * order can be tested without git, an agent, or a repository.
 */
export interface Driver {
  /** Leaves that can be picked up right now, in queue order. */
  ready(): Promise<string[]>;
  /** Claim a leaf (`wp start`) before any agent sees it. */
  claim(id: string): Promise<void>;
  /** Give one agent a private worktree and branch. */
  prepare(id: string): Promise<void>;
  /** Run one agent to completion inside its own worktree. */
  work(id: string): Promise<void>;
  /** Merge one finished branch into the main worktree. */
  merge(id: string): Promise<void>;
  /** The verification gate, run in the main worktree after a merge. */
  verify(): Promise<void>;
  /** Undo the merge just made, leaving the branch alone. */
  undoMerge(): Promise<void>;
  /** Release a leaf (`wp done`) — only ever after a green `verify`. */
  release(id: string): Promise<void>;
  /** Drop the worktree and branch of an integrated work package. */
  discard(id: string): Promise<void>;
}

export type Reporter = (line: string) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string): string {
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text;
}

/** The first non-empty line of command output, short enough for one report line. */
export function firstLine(output: string): string {
  return truncate((output.split("\n").find((line) => line.trim()) ?? "").trim());
}

/** The worktree of one agent, a sibling of the repository (execution model §6). */
export function worktreePath(repositoryRoot: string, id: string): string {
  return resolve(repositoryRoot, "..", `wt-${id}`);
}

/** The branch of one agent. One agent, one worktree, one branch, one WP. */
export function branchName(id: string): string {
  return `wp/${id}`;
}

/**
 * The prompt for one agent: a hand-written role that never changes, plus the
 * ticket itself. No prompt is written per work package — the WP is the prompt.
 */
export function composePrompt(role: string, brief: string): string {
  return `${role.trimEnd()}${PROMPT_SEPARATOR}${brief.trimEnd()}\n`;
}

/** Read `wp next --all --json`, which is the whole scheduler. */
export function parseReadyQueue(json: string): QueueEntry[] {
  const trimmed = json.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new OrchestratorError(`cannot read the ready queue: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new OrchestratorError("cannot read the ready queue: expected a JSON array");
  }

  return parsed.map((entry): QueueEntry => {
    const fields = (typeof entry === "object" && entry !== null ? entry : {}) as {
      id?: unknown;
      short_description?: unknown;
    };
    if (typeof fields.id !== "string" || !fields.id) {
      throw new OrchestratorError("cannot read the ready queue: an entry has no id");
    }
    return {
      id: fields.id,
      description:
        typeof fields.short_description === "string" ? fields.short_description : "",
    };
  });
}

interface AgentResult {
  readonly id: string;
  readonly failure: Failure | null;
}

/**
 * Set up a worktree and run one agent in it. Never rejects: one agent dying
 * must not abandon the rest of the wave, so its outcome is returned instead.
 */
async function runAgent(driver: Driver, id: string, report: Reporter): Promise<AgentResult> {
  try {
    await driver.prepare(id);
  } catch (error) {
    report(`  ${id}  setup failed: ${errorMessage(error)}`);
    return { id, failure: { id, stage: "setup", message: errorMessage(error) } };
  }

  try {
    await driver.work(id);
  } catch (error) {
    // The WP stays `doing` and the branch survives, so nothing is lost (§7).
    report(`  ${id}  agent failed: ${errorMessage(error)}`);
    return { id, failure: { id, stage: "agent", message: errorMessage(error) } };
  }

  report(`  ${id}  agent finished`);
  return { id, failure: null };
}

/**
 * Drain the queue. Each round asks what is ready, hands all of it to agents at
 * once, then integrates the finished branches serially.
 *
 * The loop terminates because claiming a leaf writes `status: doing`, and
 * `wp next` only ever offers `todo` leaves.
 */
export async function runQueue(
  driver: Driver,
  report: Reporter = () => {},
): Promise<RunReport> {
  const merged: string[] = [];
  const failed: Failure[] = [];
  let waves = 0;

  for (;;) {
    const ready = await driver.ready();
    if (ready.length === 0) break;
    waves += 1;
    report(`wave ${waves}: ${ready.length} ready — ${ready.join(", ")}`);

    // Claim first, serially, before any agent starts. A leaf that stays `todo`
    // comes back next wave for ever, so this is what makes the loop terminate.
    const claimed: string[] = [];
    for (const id of ready) {
      try {
        await driver.claim(id);
        claimed.push(id);
      } catch (error) {
        report(`  ${id}  start failed: ${errorMessage(error)}`);
        failed.push({ id, stage: "start", message: errorMessage(error) });
      }
    }
    if (claimed.length === 0) {
      report("nothing could be claimed; stopping instead of asking again");
      break;
    }

    // The wave: everything the queue offered, running at once.
    const results = await Promise.all(claimed.map((id) => runAgent(driver, id, report)));
    for (const result of results) {
      if (result.failure) failed.push(result.failure);
    }

    // Integration: one branch at a time, in queue order. That is what buys back
    // attribution — if the suite goes red it is the branch just merged, because
    // nothing else changed (§6 rule 3).
    for (const { id, failure } of results) {
      if (failure) continue;

      try {
        await driver.merge(id);
      } catch (error) {
        report(`  ${id}  merge failed: ${errorMessage(error)} — ${branchName(id)} kept`);
        failed.push({ id, stage: "merge", message: errorMessage(error) });
        continue;
      }

      try {
        await driver.verify();
      } catch (error) {
        // Undo the merge, or every later branch in this wave inherits the red
        // suite and gets blamed for it.
        report(`  ${id}  verify failed: ${errorMessage(error)} — ${branchName(id)} kept`);
        failed.push({ id, stage: "verify", message: errorMessage(error) });
        try {
          await driver.undoMerge();
        } catch (undoError) {
          throw new OrchestratorError(
            `${id} left the main worktree mid-merge and it could not be undone: ${errorMessage(undoError)}`,
          );
        }
        continue;
      }

      try {
        await driver.release(id);
      } catch (error) {
        report(`  ${id}  done failed: ${errorMessage(error)}`);
        failed.push({ id, stage: "release", message: errorMessage(error) });
        continue;
      }

      merged.push(id);
      report(`  ${id}  merged, suite green, done`);

      try {
        await driver.discard(id);
      } catch (error) {
        report(`  ${id}  cleanup left behind: ${errorMessage(error)}`);
      }
    }
  }

  return { waves, merged, failed };
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one command with no shell in between. §8.2 of the execution model picks a
 * program over shell because quoting a multi-paragraph prompt is what breaks;
 * an argument list has nothing to quote.
 */
async function execute(command: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
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

async function checkedExecute(
  command: readonly string[],
  cwd: string,
  label: string,
): Promise<string> {
  const result = await execute(command, cwd);
  if (result.exitCode !== 0) {
    throw new OrchestratorError(
      `${label}: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout;
}

function reasonFor(result: CommandResult, pattern: RegExp): string {
  const line = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => pattern.test(candidate));
  if (line) return truncate(line);
  return firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`;
}

/**
 * Why the suite went red, in one line. Both git and `bun test` print the useful
 * line last, after a header the reader does not need, so the first line of
 * output is the wrong thing to report.
 */
export function verifyMessage(result: CommandResult): string {
  return reasonFor(result, /^\d+ fail/);
}

/** Why a merge failed, in one line. */
export function mergeMessage(result: CommandResult): string {
  return reasonFor(result, /^(CONFLICT|error:|fatal:)/);
}

export interface DriverConfig {
  /** Main worktree: the orchestrator stays here and owns `main` and `wps/`. */
  readonly repositoryRoot: string;
  readonly wpsDirectory: string;
  /** Contents of the project's `prompts/worker.md`, identical for every agent. */
  readonly role: string;
  /** The project's gate, run through `sh -c` so `&&` works. */
  readonly verifyCommand: string;
}

/** The real driver: `wp` for the tracker, git for isolation, `claude -p` for work. */
export function createDriver(config: DriverConfig): Driver {
  const { repositoryRoot, wpsDirectory, role, verifyCommand } = config;
  const logDirectory = join(repositoryRoot, LOG_DIRECTORY_NAME);

  const wp = (arguments_: readonly string[], label: string): Promise<string> =>
    checkedExecute(
      [process.execPath, CLI_PATH, "--dir", wpsDirectory, ...arguments_],
      repositoryRoot,
      label,
    );
  const git = (arguments_: readonly string[], label: string): Promise<string> =>
    checkedExecute(["git", ...arguments_], repositoryRoot, label);

  return {
    ready: async () => parseReadyQueue(await wp(["next", "--all", "--json"], "wp next")).map(
      (entry) => entry.id,
    ),

    claim: async (id) => {
      await wp(["start", id], `wp start ${id}`);
    },

    prepare: async (id) => {
      const worktree = worktreePath(repositoryRoot, id);
      if (existsSync(worktree)) {
        throw new OrchestratorError(`${worktree} already exists; remove it first`);
      }
      await git(["worktree", "add", worktree, "-b", branchName(id)], "git worktree add");
      // Only a Bun project needs this, and the tool is meant to drop into any
      // project (D10). Anything further is the role prompt's business.
      if (existsSync(join(worktree, "package.json"))) {
        await checkedExecute(["bun", "install"], worktree, "bun install");
      }
    },

    work: async (id) => {
      const brief = await wp(["show", id], `wp show ${id}`);
      const prompt = composePrompt(role, brief);
      const logPath = join(logDirectory, `${id}.log`);
      mkdirSync(logDirectory, { recursive: true });

      const result = await execute(
        [AGENT_COMMAND, "-p", prompt, "--permission-mode", "acceptEdits"],
        worktreePath(repositoryRoot, id),
      );
      await Bun.write(logPath, `${result.stdout}${result.stderr}`);
      if (result.exitCode !== 0) {
        throw new OrchestratorError(
          `agent exited ${result.exitCode}; see ${relative(repositoryRoot, logPath)}`,
        );
      }
    },

    merge: async (id) => {
      // An agent can exit 0 having committed nothing. Merging that branch is
      // "Already up to date": no merge commit, so `done` would claim work that
      // never landed (rule 4) and the undo below would have no merge to undo.
      const contained = await execute(
        ["git", "merge-base", "--is-ancestor", branchName(id), "HEAD"],
        repositoryRoot,
      );
      if (contained.exitCode === 0) {
        throw new OrchestratorError(
          `${branchName(id)} has no commits of its own; the agent committed nothing`,
        );
      }

      const result = await execute(
        ["git", "merge", "--no-ff", "--no-edit", branchName(id)],
        repositoryRoot,
      );
      if (result.exitCode === 0) return;
      // Leave the main worktree mergeable for the next branch in the wave.
      await execute(["git", "merge", "--abort"], repositoryRoot);
      throw new OrchestratorError(mergeMessage(result));
    },

    verify: async () => {
      const result = await execute(["sh", "-c", verifyCommand], repositoryRoot);
      if (result.exitCode !== 0) throw new OrchestratorError(verifyMessage(result));
    },

    // `--keep` and not `--hard`: the tracker edits made by `wp start` are still
    // uncommitted in this worktree, and `--hard` would throw them away.
    undoMerge: async () => {
      await git(["reset", "--keep", "ORIG_HEAD"], "git reset --keep ORIG_HEAD");
    },

    release: async (id) => {
      await wp(["done", id], `wp done ${id}`);
    },

    // `--force`, and the branch deleted independently of the worktree. By this
    // point the WP is merged and green, so whatever is still in the worktree is
    // junk — and `bun install` alone dirties a tracked lockfile, which would
    // make a plain `remove` fail for every WP and leak the branch with it.
    discard: async (id) => {
      const removal = await execute(
        ["git", "worktree", "remove", "--force", worktreePath(repositoryRoot, id)],
        repositoryRoot,
      );
      const deletion = await execute(
        ["git", "branch", "-d", branchName(id)],
        repositoryRoot,
      );
      const problems = [
        removal.exitCode === 0 ? "" : `worktree: ${firstLine(removal.stderr)}`,
        deletion.exitCode === 0 ? "" : `branch: ${firstLine(deletion.stderr)}`,
      ].filter(Boolean);
      if (problems.length > 0) throw new OrchestratorError(problems.join("; "));
    },
  };
}

function writeLine(value = ""): void {
  process.stdout.write(`${value}\n`);
}

async function repositoryRootOf(directory: string): Promise<string> {
  const result = await execute(["git", "rev-parse", "--show-toplevel"], directory);
  if (result.exitCode !== 0) {
    throw new OrchestratorError(`${directory} is not inside a git repository`);
  }
  return result.stdout.trim();
}

/**
 * Refuse to start with unrelated local changes: every wave merges into this
 * worktree and runs the suite here. The work-package directory and the agent
 * logs are the orchestrator's own output, so they are allowed.
 */
async function requireCleanWorktree(
  repositoryRoot: string,
  wpsDirectory: string,
): Promise<void> {
  const status = await checkedExecute(
    ["git", "status", "--porcelain"],
    repositoryRoot,
    "git status",
  );
  const owned = [relative(repositoryRoot, wpsDirectory), LOG_DIRECTORY_NAME];
  const dirty = status
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({
      // The index column. `git merge` refuses while anything at all is staged,
      // even a path the merge never touches, so a staged file is never "owned"
      // however it is named. `?` marks untracked, which is not staged.
      staged: !" ?".includes(line[0] ?? " "),
      path: line.slice(3).split(" -> ").at(-1) ?? "",
    }))
    .filter(
      ({ staged, path }) =>
        path &&
        (staged ||
          !owned.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))),
    )
    .map(({ path }) => path);

  if (dirty.length > 0) {
    throw new OrchestratorError(
      `commit or stash first, the main worktree is not clean: ${dirty.slice(0, 5).join(", ")}`,
    );
  }
}

/**
 * The role half of every prompt. A project brings its own, because it names the
 * project's gate and house rules; the tool only ships a template.
 */
function readRole(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new OrchestratorError(
      `no worker role prompt at ${path}; copy the template from ${ROLE_TEMPLATE_PATH}`,
    );
  }
}

/** Print what the first wave would do, then stop. No claim, no agent, no merge. */
async function printPlan(
  repositoryRoot: string,
  wpsDirectory: string,
  role: string,
  verifyCommand: string,
): Promise<void> {
  const queue = parseReadyQueue(
    await checkedExecute(
      [process.execPath, CLI_PATH, "--dir", wpsDirectory, "next", "--all", "--json"],
      repositoryRoot,
      "wp next",
    ),
  );
  writeLine("dry run: nothing is claimed, spawned or merged");
  if (queue.length === 0) {
    writeLine("wave 1: nothing ready — the queue is empty");
    return;
  }

  writeLine(`wave 1: ${queue.length} ready`);
  for (const entry of queue) {
    const brief = await checkedExecute(
      [process.execPath, CLI_PATH, "--dir", wpsDirectory, "show", entry.id],
      repositoryRoot,
      `wp show ${entry.id}`,
    );
    const prompt = composePrompt(role, brief);
    writeLine(`  ${entry.id}  ${entry.description}`);
    writeLine(`    wp start ${entry.id}`);
    writeLine(
      `    git worktree add ${worktreePath(repositoryRoot, entry.id)} -b ${branchName(entry.id)}`,
    );
    writeLine(
      `    ${AGENT_COMMAND} -p <prompt> --permission-mode acceptEdits  (${prompt.length} chars, log: ${LOG_DIRECTORY_NAME}/${entry.id}.log)`,
    );
  }
  writeLine("  then, one branch at a time:");
  for (const entry of queue) {
    writeLine(
      `    git merge --no-ff ${branchName(entry.id)} && ${verifyCommand} && wp done ${entry.id}`,
    );
  }
}

function requireAgentCommand(): void {
  if (!Bun.which(AGENT_COMMAND)) {
    throw new OrchestratorError(`${AGENT_COMMAND} is not on PATH; agents cannot be spawned`);
  }
}

interface CliArguments {
  readonly directory: string;
  readonly role: string | null;
  readonly verifyCommand: string;
  readonly dryRun: boolean;
}

const HELP = `usage: orchestrate [--dir PATH] [--role PATH] [--verify COMMAND] [--dry-run]

Run the work queue with parallel agents: one worktree per ready work package,
then merge the branches back one at a time.

options:
  --dir PATH        work-package directory (default: ./wps)
  --role PATH       worker role prompt (default: ./${ROLE_RELATIVE_PATH})
  --verify COMMAND  the gate a merge must pass, run through sh -c
                    (default: ${DEFAULT_VERIFY_COMMAND})
  --dry-run         print the first wave's plan and stop
  -h, --help        show this help message

exit codes:
  0                 the queue drained and everything merged green
  1                 the queue drained but something needs a human
  2                 usage error, or the repository is not ready`;

function parseArguments(argv: readonly string[]): CliArguments | null {
  let directory = "wps";
  let role: string | null = null;
  let verifyCommand = DEFAULT_VERIFY_COMMAND;
  let dryRun = false;

  const valueOf = (index: number, name: string): string => {
    const value = argv[index];
    if (value === undefined || value.startsWith("-")) {
      throw new OrchestratorError(`argument ${name}: expected one value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--help" || argument === "-h") {
      return null;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--dir") {
      directory = valueOf(index + 1, "--dir");
      index += 1;
    } else if (argument.startsWith("--dir=")) {
      directory = argument.slice("--dir=".length);
    } else if (argument === "--role") {
      role = valueOf(index + 1, "--role");
      index += 1;
    } else if (argument.startsWith("--role=")) {
      role = argument.slice("--role=".length);
    } else if (argument === "--verify") {
      verifyCommand = valueOf(index + 1, "--verify");
      index += 1;
    } else if (argument.startsWith("--verify=")) {
      verifyCommand = argument.slice("--verify=".length);
    } else {
      throw new OrchestratorError(`unrecognized argument: ${argument}`);
    }
  }

  return { directory, role, verifyCommand, dryRun };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args === null) {
      writeLine(HELP);
      return 0;
    }

    const repositoryRoot = await repositoryRootOf(process.cwd());
    const wpsDirectory = resolve(process.cwd(), args.directory);
    const role = readRole(
      args.role === null ? join(repositoryRoot, ROLE_RELATIVE_PATH) : resolve(args.role),
    );
    await requireCleanWorktree(repositoryRoot, wpsDirectory);

    if (args.dryRun) {
      await printPlan(repositoryRoot, wpsDirectory, role, args.verifyCommand);
      return 0;
    }

    requireAgentCommand();
    const report = await runQueue(
      createDriver({
        repositoryRoot,
        wpsDirectory,
        role,
        verifyCommand: args.verifyCommand,
      }),
      writeLine,
    );
    writeLine(
      `queue empty after ${report.waves} wave(s): ${report.merged.length} merged, ${report.failed.length} left for a human`,
    );
    for (const failure of report.failed) {
      writeLine(`  ${failure.id}  ${failure.stage}: ${failure.message}`);
    }
    return report.failed.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof OrchestratorError) {
      process.stderr.write(`orchestrate: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  // Same two reasons as `wp.ts`: a reader that closes the pipe early (`orchestrate
  // | head`) raises EPIPE at flush time, where a try/catch around `main` cannot see
  // it, and `process.exit()` would discard buffered stdout past 128 KiB — which for
  // a long run is most of the report.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });

  process.exitCode = await main();
}
