#!/usr/bin/env bun
/**
 * Runs the work queue with parallel agents, as specified by
 * `docs/execution-model.md`: spawn everything `wp next --all` offers, wait for
 * the wave, then merge the branches back one at a time.
 *
 * Nothing here plans. Readiness is recomputed by `wp next` on every wave, so a
 * dependency enforces itself by simply not appearing in the queue.
 *
 * Read it in five passes, top to bottom:
 *   1. vocabulary       — ids, branches, worktrees, the prompt, the ready queue
 *   2. the wave loop    — runQueue -> runAgent -> integrate -> runStep
 *   3. running commands — the one `Bun.spawn` wrapper and the two reason readers
 *   4. the driver       — `wp`, git and `claude -p` behind the `Driver` seam
 *   5. the command line — argv, the preflights, the dry run, main
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ── 1. Vocabulary ────────────────────────────────────────────────────────────

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

/**
 * The `Bash` commands an agent is allowed to run, as `--allowedTools` rules.
 *
 * `--permission-mode acceptEdits` covers the edit tools and nothing else, and
 * `claude -p` is headless: there is nobody to answer a prompt, so an unlisted
 * `Bash` call is denied outright. An agent that cannot run `git commit` writes
 * its file and leaves an empty branch — which `merge` then refuses, so the work
 * is done, green in the worktree, and invisible. That failure was observed, not
 * imagined; it cost a whole wave.
 *
 * So the two things the role prompt *requires* are granted here, and nothing
 * else: git, and the project's own gate. The gate runs through `sh -c`, so it
 * may be several commands joined by `&&`, `||`, `;` or a pipe — the first word
 * of each segment is a program to allow.
 */
export function agentAllowedTools(verifyCommand: string): string[] {
  const programs = verifyCommand
    .split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? "")
    .filter((program) => program !== "");
  // `git` is in no gate, but rule 6 of the role prompt ends with "commit on this
  // branch", and rule 5 needs the gate. Those two are the whole list.
  return [...new Set(["git", ...programs])].map((program) => `Bash(${program}:*)`);
}

/**
 * The environment one agent runs in: the caller's own, plus `wp.id` as an OTel
 * resource attribute. That one tag is the whole of `docs/observability.md` —
 * every agent in a wave reports itself identically otherwise, so a viewer shows
 * four anonymous sessions and no way to ask which one burned the tokens.
 *
 * Appended, never replaced: `OTEL_RESOURCE_ATTRIBUTES` is general purpose and an
 * operator may already carry `department=eng` in it. Dropping theirs is invisible
 * — a filter that used to work simply stops being offered.
 *
 * `base` is spread rather than the one variable being returned alone, because
 * `Bun.spawn` *replaces* the child environment when `env` is passed instead of
 * merging: an agent handed this variable by itself gets no `PATH`, no `HOME` and
 * no credentials, and `claude` then fails to start in a way that reads as an auth
 * problem.
 *
 * Nothing is escaped. A `wp.id` comes from the stem grammar (`wp-` plus
 * `[a-z][0-9]+` segments), which holds no comma, equals sign or whitespace.
 */
export function agentEnvironment(
  id: string,
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const existing = base.OTEL_RESOURCE_ATTRIBUTES ?? "";
  // A leading comma is one empty attribute pair, which some collectors reject.
  const separator = existing === "" ? "" : ",";
  return { ...base, OTEL_RESOURCE_ATTRIBUTES: `${existing}${separator}wp.id=${id}` };
}

/** One `wp tree --json` row, as much of it as the stall report reads. */
interface TreeRow {
  readonly id: string;
  readonly status: string;
  readonly blockers: readonly string[];
}

/** Whatever `wp --json` printed, as an array. An empty queue prints nothing at all. */
function parseJsonArray(json: string, label: string): unknown[] {
  const trimmed = json.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new OrchestratorError(`cannot read ${label}: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new OrchestratorError(`cannot read ${label}: expected a JSON array`);
  }
  return parsed;
}

/** Read `wp next --all --json`, which is the whole scheduler. */
export function parseReadyQueue(json: string): QueueEntry[] {
  return parseJsonArray(json, "the ready queue").map((entry): QueueEntry => {
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

/** Read `wp tree --scope <id> --json`, which is why a scoped queue came back empty. */
export function parseTreeRows(json: string): TreeRow[] {
  return parseJsonArray(json, "the tree").map((entry): TreeRow => {
    const fields = (typeof entry === "object" && entry !== null ? entry : {}) as {
      id?: unknown;
      status?: unknown;
      unmet_blockers?: unknown;
    };
    if (typeof fields.id !== "string" || !fields.id) {
      throw new OrchestratorError("cannot read the tree: a row has no id");
    }
    return {
      id: fields.id,
      // `null` is a container whose children carry no status — `wp check`'s problem.
      status: typeof fields.status === "string" ? fields.status : "unknown",
      blockers: Array.isArray(fields.unmet_blockers)
        ? fields.unmet_blockers.filter((value): value is string => typeof value === "string")
        : [],
    };
  });
}

// ── 2. The wave loop — bookkeeping only: no git, no spawn, no `process.*` ─────

interface AgentResult {
  readonly id: string;
  readonly failure: Failure | null;
}

/** What a refused step prints: `  <id>  <note>: <message>`. */
interface StepReport {
  readonly id: string;
  readonly stage: Stage;
  /** The words before the colon, e.g. `merge failed`. */
  readonly note: string;
  /**
   * Set on the two refusals that leave an agent branch behind for a human (§7):
   * a conflicting merge and a red gate.
   */
  readonly keepsBranch?: boolean;
}

/**
 * Run one step of one work package. A refusal is a value, not an exception:
 * `null` means it worked, a `Failure` means give up on this work package and
 * move on to the next. Nothing here rethrows, because one dead agent or one red
 * branch must not abandon the rest of the wave (§7).
 */
async function runStep(
  action: () => Promise<void>,
  step: StepReport,
  report: Reporter,
): Promise<Failure | null> {
  try {
    await action();
    return null;
  } catch (error) {
    const message = errorMessage(error);
    const kept = step.keepsBranch === true ? ` — ${branchName(step.id)} kept` : "";
    report(`  ${step.id}  ${step.note}: ${message}${kept}`);
    return { id: step.id, stage: step.stage, message };
  }
}

/**
 * Set up a worktree and run one agent in it. Never rejects: one agent dying
 * must not abandon the rest of the wave, so its outcome is returned instead.
 */
async function runAgent(driver: Driver, id: string, report: Reporter): Promise<AgentResult> {
  const setup = await runStep(
    () => driver.prepare(id),
    { id, stage: "setup", note: "setup failed" },
    report,
  );
  if (setup) return { id, failure: setup };

  // If the agent dies the WP stays `doing` and the branch survives, so nothing
  // is lost (§7).
  const agent = await runStep(
    () => driver.work(id),
    { id, stage: "agent", note: "agent failed" },
    report,
  );
  if (agent) return { id, failure: agent };

  report(`  ${id}  agent finished`);
  return { id, failure: null };
}

/**
 * Merge one finished branch, run the gate, release the work package — stopping
 * at the first refusal. Returns that refusal, or `null` when the WP landed.
 *
 * The one thing that escapes as an exception is a merge that could not be
 * undone: after that the main worktree is broken and no later branch in the
 * wave may be merged onto it.
 */
async function integrate(driver: Driver, id: string, report: Reporter): Promise<Failure | null> {
  const merge = await runStep(
    () => driver.merge(id),
    { id, stage: "merge", note: "merge failed", keepsBranch: true },
    report,
  );
  if (merge) return merge;

  const gate = await runStep(
    () => driver.verify(),
    { id, stage: "verify", note: "verify failed", keepsBranch: true },
    report,
  );
  if (gate) {
    // Undo the merge, or every later branch in this wave inherits the red suite
    // and gets blamed for it (§8.4 rule 1).
    try {
      await driver.undoMerge();
    } catch (undoError) {
      throw new OrchestratorError(
        `${id} left the main worktree mid-merge and it could not be undone: ${errorMessage(undoError)}`,
      );
    }
    return gate;
  }

  // `wp done` only after a green gate, and only after a merge that really
  // merged something — `driver.merge` refuses a branch with no commits of its
  // own (§8.4 rule 2), so this cannot claim work that never landed.
  const release = await runStep(
    () => driver.release(id),
    { id, stage: "release", note: "done failed" },
    report,
  );
  if (release) return release;

  report(`  ${id}  merged, suite green, done`);

  // Best effort: by now the WP is merged, green and released, so a leftover
  // worktree is worth a line, not a verdict.
  try {
    await driver.discard(id);
  } catch (error) {
    report(`  ${id}  cleanup left behind: ${errorMessage(error)}`);
  }
  return null;
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
      const refusal = await runStep(
        () => driver.claim(id),
        { id, stage: "start", note: "start failed" },
        report,
      );
      if (refusal) failed.push(refusal);
      else claimed.push(id);
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

    // Integration: one branch at a time, in queue order — never `Promise.all`.
    // That is what buys back attribution — if the suite goes red it is the
    // branch just merged, because nothing else changed (§6 rule 3).
    for (const { id, failure } of results) {
      if (failure) continue; // its agent never finished; there is nothing to merge
      const refusal = await integrate(driver, id, report);
      if (refusal) failed.push(refusal);
      else merged.push(id);
    }
  }

  return { waves, merged, failed };
}

// ── 3. Running commands — the only place `Bun.spawn` is called ───────────────

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one command with no shell in between. §8.2 of the execution model picks a
 * program over shell because quoting a multi-paragraph prompt is what breaks;
 * an argument list has nothing to quote.
 *
 * `environment` is forwarded only when it is given, so `wp`, git and the gate
 * inherit this process's environment exactly as before. When it *is* given,
 * `Bun.spawn` replaces the child environment rather than merging — see
 * `agentEnvironment`, which is why the whole base is spread into it.
 */
async function execute(
  command: readonly string[],
  cwd: string,
  environment?: Record<string, string | undefined>,
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(environment === undefined ? {} : { env: environment }),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

/**
 * Why a command failed, in one line: stderr if it said anything, else stdout,
 * else just the exit code. `||` and not `??`, because `firstLine("")` is `""`.
 */
function failureLine(result: CommandResult): string {
  return firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`;
}

/** Run a command and take its stdout, or raise the reason it failed. */
async function executeOrThrow(
  command: readonly string[],
  cwd: string,
  label: string,
): Promise<string> {
  const result = await execute(command, cwd);
  if (result.exitCode !== 0) {
    throw new OrchestratorError(`${label}: ${failureLine(result)}`);
  }
  return result.stdout;
}

/** The first output line matching `pattern`, or failing that the generic reason. */
function reasonFor(result: CommandResult, pattern: RegExp): string {
  const line = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => pattern.test(candidate));
  if (line) return truncate(line);
  return failureLine(result);
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

// ── 4. The driver — `wp`, git and `claude -p` behind the `Driver` seam ───────

/** Invoke this tool's own `wp` against one work-package directory. */
type WpRunner = (arguments_: readonly string[], label: string) => Promise<string>;

/**
 * `wp` as a subprocess, run through this same Bun binary rather than the
 * shebang. The orchestrator imports nothing from `src/`, so the JSON `wp` prints
 * is the contract between the two entry points — which is why the command line
 * is assembled here once, for the driver and the dry run alike.
 */
function wpRunner(repositoryRoot: string, wpsDirectory: string): WpRunner {
  return (arguments_, label) =>
    executeOrThrow(
      [process.execPath, CLI_PATH, "--dir", wpsDirectory, ...arguments_],
      repositoryRoot,
      label,
    );
}

/**
 * `wp next --all --json` is the entire scheduler (execution model §2), and
 * `--scope` is the only thing that narrows it. The scope is one work-package ID;
 * whether that means a milestone, an epic or a single story is the stem's
 * business, not this file's.
 */
async function readyQueue(wp: WpRunner, scope: string | null): Promise<QueueEntry[]> {
  const scoped = scope === null ? [] : ["--scope", scope];
  return parseReadyQueue(await wp(["next", "--all", "--json", ...scoped], "wp next"));
}

/** The word for a scope — milestone, epic, story. `wp show` owns that derivation. */
async function scopeType(wp: WpRunner, scope: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await wp(["show", scope, "--json"], `wp show ${scope}`));
  } catch (error) {
    if (error instanceof OrchestratorError) throw error;
    return "work package";
  }
  const type = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    type?: unknown;
  };
  return typeof type.type === "string" ? type.type : "work package";
}

export interface DriverConfig {
  /** Main worktree: the orchestrator stays here and owns `main` and `wps/`. */
  readonly repositoryRoot: string;
  readonly wpsDirectory: string;
  /** Contents of the project's `prompts/worker.md`, identical for every agent. */
  readonly role: string;
  /** The project's gate, run through `sh -c` so `&&` works. */
  readonly verifyCommand: string;
  /** One work package to stay inside, with everything under it. `null` is the whole tree. */
  readonly scope: string | null;
}

/** The real driver: `wp` for the tracker, git for isolation, `claude -p` for work. */
export function createDriver(config: DriverConfig): Driver {
  const { repositoryRoot, wpsDirectory, role, verifyCommand, scope } = config;
  const logDirectory = join(repositoryRoot, LOG_DIRECTORY_NAME);
  const allowedTools = agentAllowedTools(verifyCommand);

  const wp = wpRunner(repositoryRoot, wpsDirectory);
  const git = (arguments_: readonly string[], label: string): Promise<string> =>
    executeOrThrow(["git", ...arguments_], repositoryRoot, label);

  return {
    ready: async () => (await readyQueue(wp, scope)).map((entry) => entry.id),

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
        await executeOrThrow(["bun", "install"], worktree, "bun install");
      }
    },

    work: async (id) => {
      const brief = await wp(["show", id], `wp show ${id}`);
      const prompt = composePrompt(role, brief);
      const logPath = join(logDirectory, `${id}.log`);
      mkdirSync(logDirectory, { recursive: true });

      const result = await execute(
        [
          AGENT_COMMAND,
          "-p",
          prompt,
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          ...allowedTools,
        ],
        worktreePath(repositoryRoot, id),
        // Unconditional: with telemetry off this is a variable nothing reads, so
        // there is no state to branch on and no flag to keep in sync.
        agentEnvironment(id, process.env),
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

    /**
     * `--keep` and not `--hard`: the tracker edits made by `wp start` are still
     * uncommitted in this worktree, and `--hard` would throw the queue's own
     * bookkeeping away.
     */
    undoMerge: async () => {
      await git(["reset", "--keep", "ORIG_HEAD"], "git reset --keep ORIG_HEAD");
    },

    release: async (id) => {
      await wp(["done", id], `wp done ${id}`);
    },

    /**
     * `--force`, and the branch deleted independently of the worktree. By this
     * point the WP is merged and green, so whatever is still in the worktree is
     * junk — and `bun install` alone dirties a tracked lockfile, which would
     * make a plain `remove` fail for every WP and leak the branch with it. A
     * leftover worktree also makes `prepare` refuse that id for ever, because
     * it checks `existsSync` first.
     */
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

// ── 5. The command line — argv, the preflights, the dry run, main ────────────

function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function repositoryRootOf(directory: string): Promise<string> {
  const result = await execute(["git", "rev-parse", "--show-toplevel"], directory);
  if (result.exitCode !== 0) {
    throw new OrchestratorError(`${directory} is not inside a git repository`);
  }
  return result.stdout.trim();
}

interface StatusEntry {
  readonly staged: boolean;
  readonly path: string;
}

/**
 * One `git status --porcelain` line. The first column is the index, and it is
 * the one that matters: `git merge` refuses to run while anything at all is
 * staged, even for a path the merge never touches, so a staged file is never
 * "owned" however it is named — admitting one means paying for a whole wave of
 * agents and then failing every merge. `?` in that column means untracked,
 * which is not staged. A rename prints `old -> new`; the new name is on disk.
 */
function parseStatusLine(line: string): StatusEntry {
  return {
    staged: !" ?".includes(line[0] ?? " "),
    path: line.slice(3).split(" -> ").at(-1) ?? "",
  };
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
  const status = await executeOrThrow(
    ["git", "status", "--porcelain"],
    repositoryRoot,
    "git status",
  );
  // Unstaged changes here are expected on every run but the first: they are the
  // orchestrator's own output, not somebody's work in progress.
  const owned = [relative(repositoryRoot, wpsDirectory), LOG_DIRECTORY_NAME];
  const isOwned = (path: string): boolean =>
    owned.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  const dirty = status
    .split("\n")
    .filter((line) => line.trim())
    .map(parseStatusLine)
    .filter(({ staged, path }) => path !== "" && (staged || !isOwned(path)))
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

/**
 * Why a scoped run did nothing. `wp next` answers "what can start"; when a scope
 * was named and the answer is "nothing", the useful next question is "why not",
 * and the scoped tree already holds that answer per work package.
 *
 * A blocker that is not itself in the scope can never be released by this run —
 * widening the scope is the only way out — so it is called out. That is set
 * membership over the rows that came back, not a second opinion here about the
 * stem grammar.
 */
async function printScopeStall(config: DriverConfig, scope: string): Promise<void> {
  const wp = wpRunner(config.repositoryRoot, config.wpsDirectory);
  const type = await scopeType(wp, scope);
  const rows = parseTreeRows(await wp(["tree", "--scope", scope, "--json"], "wp tree"));
  const inScope = new Set(rows.map((row) => row.id));

  printLine(`wave 1: nothing ready in scope ${scope} (${type})`);
  // The scope's own row says nothing its children do not — unless it is the only
  // row, which is exactly the case of a scope naming one story.
  for (const row of rows.length > 1 ? rows.slice(1) : rows) {
    const blockers = row.blockers.map((id) =>
      inScope.has(id) ? id : `${id} (outside scope)`,
    );
    const reason =
      blockers.length === 0 ? row.status : `blocked by ${blockers.join(", ")}`;
    printLine(`  ${row.id}  ${reason}`);
  }
}

/** Print what the first wave would do, then stop. No claim, no agent, no merge. */
async function printPlan(config: DriverConfig): Promise<void> {
  const { repositoryRoot, wpsDirectory, role, verifyCommand, scope } = config;
  const wp = wpRunner(repositoryRoot, wpsDirectory);
  const queue = await readyQueue(wp, scope);

  printLine("dry run: nothing is claimed, spawned or merged");
  if (queue.length === 0) {
    if (scope !== null) {
      await printScopeStall(config, scope);
      return;
    }
    printLine("wave 1: nothing ready — the queue is empty");
    return;
  }

  printLine(`wave 1: ${queue.length} ready`);
  const allowedTools = agentAllowedTools(verifyCommand).join(" ");
  for (const entry of queue) {
    const brief = await wp(["show", entry.id], `wp show ${entry.id}`);
    const prompt = composePrompt(role, brief);
    printLine(`  ${entry.id}  ${entry.description}`);
    printLine(`    wp start ${entry.id}`);
    printLine(
      `    git worktree add ${worktreePath(repositoryRoot, entry.id)} -b ${branchName(entry.id)}`,
    );
    printLine(
      `    ${AGENT_COMMAND} -p <prompt> --permission-mode acceptEdits --allowedTools ${allowedTools}  (${prompt.length} chars, log: ${LOG_DIRECTORY_NAME}/${entry.id}.log)`,
    );
  }
  printLine("  then, one branch at a time:");
  for (const entry of queue) {
    printLine(
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
  readonly scope: string | null;
  readonly dryRun: boolean;
}

const HELP = `usage: orchestrate [--dir PATH] [--role PATH] [--scope ID] [--verify COMMAND]
                   [--dry-run]

Run the work queue with parallel agents: one worktree per ready work package,
then merge the branches back one at a time.

Every spawned agent is tagged with its wp.id, so a trace viewer can tell one
apart from the rest of its wave. To send the traces somewhere, source
telemetry.env beside this script; docs/observability.md has the detail.

options:
  --dir PATH        work-package directory (default: ./wps)
  --role PATH       worker role prompt (default: ./${ROLE_RELATIVE_PATH})
  --scope ID        stay inside one work package and everything under it — a
                    milestone, an epic or a single story (default: the whole tree)
  --verify COMMAND  the gate a merge must pass, run through sh -c
                    (default: ${DEFAULT_VERIFY_COMMAND})
  --dry-run         print the first wave's plan and stop
  -h, --help        show this help message

exit codes:
  0                 the queue drained and everything merged green
  1                 the queue drained but something needs a human
  2                 usage error, or the repository is not ready`;

/** `--dir=wps` -> `["--dir", "wps"]`; `--dir` -> `["--dir", null]`. */
function splitFlag(argument: string): readonly [string, string | null] {
  const separator = argument.indexOf("=");
  return separator === -1
    ? [argument, null]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}

/** Returns null when help was requested; throws `OrchestratorError` on a bad argv. */
function parseArguments(argv: readonly string[]): CliArguments | null {
  let directory = "wps";
  let role: string | null = null;
  let verifyCommand = DEFAULT_VERIFY_COMMAND;
  let scope: string | null = null;
  let dryRun = false;

  /** The value a flag needs. Another flag is not a value, it is a missing one. */
  const valueAfter = (index: number, name: string): string => {
    const value = argv[index];
    if (value === undefined || value.startsWith("-")) {
      throw new OrchestratorError(`argument ${name}: expected one value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--help" || argument === "-h") return null;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }

    // `--flag=value` and `--flag value` are one option, so split the `=` form
    // once and read the value from whichever side carried it — lazily, so that
    // an unrecognized flag reports itself instead of a missing value.
    const [name, inline] = splitFlag(argument);
    const flagValue = (): string => inline ?? valueAfter(index + 1, name);

    if (name === "--dir") directory = flagValue();
    else if (name === "--role") role = flagValue();
    else if (name === "--verify") verifyCommand = flagValue();
    else if (name === "--scope") scope = flagValue();
    // The whole argument, not the split name: `--wave-plan=1` must echo back
    // what the user actually typed.
    else throw new OrchestratorError(`unrecognized argument: ${argument}`);

    // The `--flag value` form spent the next argument as well.
    if (inline === null) index += 1;
  }

  return { directory, role, verifyCommand, scope, dryRun };
}

/**
 * Everything a run needs, resolved from argv and the repository — plus every
 * reason to refuse, before anything is claimed or spawned. The order is
 * load-bearing: the repository must exist before a role path relative to it
 * means anything.
 */
async function prepareRun(args: CliArguments): Promise<DriverConfig> {
  const repositoryRoot = await repositoryRootOf(process.cwd());
  const wpsDirectory = resolve(process.cwd(), args.directory);
  const role = readRole(
    args.role === null ? join(repositoryRoot, ROLE_RELATIVE_PATH) : resolve(args.role),
  );
  await requireCleanWorktree(repositoryRoot, wpsDirectory);
  return {
    repositoryRoot,
    wpsDirectory,
    role,
    verifyCommand: args.verifyCommand,
    scope: args.scope,
  };
}

/** The last thing a run prints: one headline, then whatever needs a human. */
function printSummary(summary: RunReport): void {
  printLine(
    `queue empty after ${summary.waves} wave(s): ${summary.merged.length} merged, ${summary.failed.length} left for a human`,
  );
  for (const failure of summary.failed) {
    printLine(`  ${failure.id}  ${failure.stage}: ${failure.message}`);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args === null) {
      printLine(HELP);
      return 0;
    }

    const config = await prepareRun(args);
    if (args.dryRun) {
      await printPlan(config);
      return 0;
    }

    requireAgentCommand();
    const summary = await runQueue(createDriver(config), printLine);
    // A scoped run that never got a wave off the ground looks identical to a
    // finished one. Say which it was before the summary claims success.
    if (config.scope !== null && summary.waves === 0) {
      await printScopeStall(config, config.scope);
    }
    printSummary(summary);
    return summary.failed.length > 0 ? 1 : 0;
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
