import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentAllowedTools,
  agentEnvironment,
  branchName,
  composePrompt,
  createDriver,
  firstLine,
  mergeMessage,
  OrchestratorError,
  parseReadyQueue,
  runQueue,
  verifyMessage,
  worktreePath,
  type Driver,
} from "../orchestrate.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const ORCHESTRATOR_PATH = join(PROJECT_ROOT, "orchestrate.ts");
const temporaryDirectories: string[] = [];

type Step =
  | "claim"
  | "prepare"
  | "work"
  | "merge"
  | "verify"
  | "undoMerge"
  | "release"
  | "discard";

interface Fault {
  readonly step: Step;
  /** The work package being integrated when the step is reached. */
  readonly id: string;
}

/**
 * A driver that records the order it was called in and refuses on demand, so a
 * test can assert the wave and merge order without git or an agent.
 */
class FakeDriver implements Driver {
  readonly calls: string[] = [];
  private waveIndex = 0;
  private integrating = "";

  constructor(
    private readonly waves: readonly (readonly string[])[],
    private readonly faults: readonly Fault[] = [],
  ) {}

  private refuseIf(step: Step, id: string): void {
    if (this.faults.some((fault) => fault.step === step && fault.id === id)) {
      throw new Error(`${step} refused for ${id}`);
    }
  }

  async ready(): Promise<string[]> {
    const wave = this.waves[this.waveIndex] ?? [];
    this.waveIndex += 1;
    this.calls.push(`ready ${wave.length === 0 ? "-" : wave.join(",")}`);
    return [...wave];
  }

  async claim(id: string): Promise<void> {
    this.calls.push(`claim ${id}`);
    this.refuseIf("claim", id);
  }

  async prepare(id: string): Promise<void> {
    this.calls.push(`prepare ${id}`);
    this.refuseIf("prepare", id);
  }

  async work(id: string): Promise<void> {
    this.calls.push(`work ${id}`);
    this.refuseIf("work", id);
  }

  async merge(id: string): Promise<void> {
    this.integrating = id;
    this.calls.push(`merge ${id}`);
    this.refuseIf("merge", id);
  }

  async verify(): Promise<void> {
    this.calls.push(`verify ${this.integrating}`);
    this.refuseIf("verify", this.integrating);
  }

  async undoMerge(): Promise<void> {
    this.calls.push(`undoMerge ${this.integrating}`);
    this.refuseIf("undoMerge", this.integrating);
  }

  async release(id: string): Promise<void> {
    this.calls.push(`release ${id}`);
    this.refuseIf("release", id);
  }

  async discard(id: string): Promise<void> {
    this.calls.push(`discard ${id}`);
    this.refuseIf("discard", id);
  }
}

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A throwaway git repository with the three things a project must bring: a
 * work-package directory, a worker role prompt, and a verify command.
 */
class RepositoryFixture {
  readonly root: string;
  readonly directory: string;
  readonly rolePath: string;
  private readonly binDirectory: string;
  private hasFakeAgent = false;

  constructor() {
    const base = mkdtempSync(join(tmpdir(), "orchestrate-test-"));
    temporaryDirectories.push(base);
    this.binDirectory = join(base, "bin");
    // The repository sits one level down, because an agent worktree is its
    // sibling: `wt-<id>` must land inside the directory afterEach deletes.
    this.root = join(base, "repo");
    mkdirSync(this.root);
    this.directory = join(this.root, "wps");
    mkdirSync(this.directory);
    this.rolePath = join(this.root, "prompts", "worker.md");
    mkdirSync(dirname(this.rolePath));
    writeFileSync(this.rolePath, "# Role\n\nDo one work package.\n", "utf8");
  }

  whenRolePromptIsRemoved(): void {
    rmSync(this.rolePath);
  }

  givenBranch(name: string): void {
    this.git("branch", name);
  }

  givenStaged(path: string): void {
    this.git("add", path);
  }

  /** A WP with children carries no status of its own (invariant 4). */
  givenContainer(id: string, description: string): void {
    const lines = ["---", `short_description: "${description}"`, "---", "", "Ticket body.", ""];
    writeFileSync(join(this.directory, `${id}.md`), lines.join("\n"), "utf8");
  }

  /**
   * A `claude` on PATH. `main` refuses to start without one, so a run that is
   * expected to spawn no agent at all still needs it to exist — which is why the
   * body defaults to doing nothing. Pass one to look at what the agent was given.
   */
  givenFakeAgent(body = "exit 0"): void {
    mkdirSync(this.binDirectory, { recursive: true });
    const path = join(this.binDirectory, "claude");
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { encoding: "utf8", mode: 0o755 });
    this.hasFakeAgent = true;
  }

  /** What the agent printed, as `work` saved it. */
  logOf(id: string): string {
    return readFileSync(join(this.root, "log", `${id}.log`), "utf8");
  }

  givenWp(id: string, description: string, blockedBy: readonly string[] = []): void {
    const lines = ["---", "status: todo"];
    if (blockedBy.length > 0) lines.push(`blocked_by: [${blockedBy.join(", ")}]`);
    lines.push(`short_description: "${description}"`, "---", "", "Ticket body.", "");
    writeFileSync(join(this.directory, `${id}.md`), lines.join("\n"), "utf8");
  }

  givenCommittedRepository(): void {
    this.git("init", "-q");
    // Local config, not just `-c` on the fixture's own calls: the driver runs
    // `git merge` itself, and that merge commit needs an author and must not
    // wait for a GPG passphrase.
    this.git("config", "user.name", "Test");
    this.git("config", "user.email", "test@example.com");
    this.git("config", "commit.gpgsign", "false");
    this.git("add", "-A");
    this.git("commit", "-q", "-m", "work packages");
  }

  /** A branch with one commit on it, as an agent would leave behind. */
  givenAgentCommitOn(branch: string, file: string, content: string): void {
    this.git("checkout", "-q", "-b", branch);
    writeFileSync(join(this.root, file), content, "utf8");
    this.git("add", "-A");
    this.git("commit", "-q", "-m", `feat: ${file}`);
    this.git("checkout", "-q", "-");
  }

  headSubject(): string {
    return this.git("log", "-1", "--format=%s").trim();
  }

  branches(): string[] {
    return this.git("branch", "--format=%(refname:short)")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** The real driver, pointed at this repository. */
  driver(verifyCommand = "true", scope: string | null = null): Driver {
    return createDriver({
      repositoryRoot: this.root,
      wpsDirectory: this.directory,
      role: "# Role\n",
      verifyCommand,
      scope,
    });
  }

  isMidMerge(): boolean {
    return existsSync(join(this.root, ".git", "MERGE_HEAD"));
  }

  givenUntrackedFile(name: string): void {
    writeFileSync(join(this.root, name), "scratch\n", "utf8");
  }

  contentOf(id: string): string {
    return readFileSync(join(this.directory, `${id}.md`), "utf8");
  }

  private git(...arguments_: string[]): string {
    const result = Bun.spawnSync({
      cmd: [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...arguments_,
      ],
      cwd: this.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.toString()}`);
    }
    return result.stdout.toString();
  }

  runOrchestrator(...arguments_: string[]): CliResult {
    const result = Bun.spawnSync({
      cmd: [process.execPath, ORCHESTRATOR_PATH, ...arguments_],
      cwd: this.root,
      stdout: "pipe",
      stderr: "pipe",
      ...(this.hasFakeAgent
        ? { env: { ...process.env, PATH: `${this.binDirectory}:${process.env.PATH ?? ""}` } }
        : {}),
    });
    const decoder = new TextDecoder();
    return {
      exitCode: result.exitCode,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function indexOfCall(calls: readonly string[], call: string): number {
  return calls.indexOf(call);
}

describe("the wave loop", () => {
  test("given a queue that drains in two waves when the loop runs then every leaf is claimed, worked and merged", async () => {
    // Given
    const driver = new FakeDriver([["wp-m1e1u1", "wp-m1e1u2"], ["wp-m1e2u1"], []]);

    // When
    const report = await runQueue(driver);

    // Then
    expect(report.waves).toBe(2);
    expect(report.merged).toEqual(["wp-m1e1u1", "wp-m1e1u2", "wp-m1e2u1"]);
    expect(report.failed).toEqual([]);
    // Claimed in queue order, before any agent starts. Agents inside one wave
    // interleave, so only the integration order is fixed.
    expect(driver.calls.filter((call) => call.startsWith("claim"))).toEqual([
      "claim wp-m1e1u1",
      "claim wp-m1e1u2",
      "claim wp-m1e2u1",
    ]);
    expect(
      driver.calls.filter((call) => /^(merge|verify|release|discard) /.test(call)),
    ).toEqual([
      "merge wp-m1e1u1",
      "verify wp-m1e1u1",
      "release wp-m1e1u1",
      "discard wp-m1e1u1",
      "merge wp-m1e1u2",
      "verify wp-m1e1u2",
      "release wp-m1e1u2",
      "discard wp-m1e1u2",
      "merge wp-m1e2u1",
      "verify wp-m1e2u1",
      "release wp-m1e2u1",
      "discard wp-m1e2u1",
    ]);
    expect(driver.calls.filter((call) => call.startsWith("ready"))).toEqual([
      "ready wp-m1e1u1,wp-m1e1u2",
      "ready wp-m1e2u1",
      "ready -",
    ]);
    expect(indexOfCall(driver.calls, "claim wp-m1e1u2")).toBeLessThan(
      indexOfCall(driver.calls, "prepare wp-m1e1u1"),
    );
    // The next wave is asked for only after this one is released, because that
    // release is what unlocks it (execution model §2).
    expect(indexOfCall(driver.calls, "release wp-m1e1u2")).toBeLessThan(
      indexOfCall(driver.calls, "ready wp-m1e2u1"),
    );
  });

  test("given an empty queue when the loop runs then nothing is claimed", async () => {
    // Given
    const driver = new FakeDriver([[]]);

    // When
    const report = await runQueue(driver);

    // Then
    expect(report).toEqual({ waves: 0, merged: [], failed: [] });
    expect(driver.calls).toEqual(["ready -"]);
  });

  test("given a wave of three when the loop runs then no branch is merged before the last agent finished", async () => {
    // Given
    const driver = new FakeDriver([["wp-m1e1u1", "wp-m1e1u2", "wp-m1e1u3"], []]);

    // When
    await runQueue(driver);

    // Then
    const lastWork = indexOfCall(driver.calls, "work wp-m1e1u3");
    const firstMerge = indexOfCall(driver.calls, "merge wp-m1e1u1");
    expect(lastWork).toBeGreaterThan(0);
    expect(firstMerge).toBeGreaterThan(lastWork);
  });

  test("given a claim that keeps failing when the loop runs then it stops instead of asking again", async () => {
    // Given the same leaf is offered for ever, because nothing ever claims it
    const driver = new FakeDriver(
      [["wp-m1e1u1"], ["wp-m1e1u1"], ["wp-m1e1u1"]],
      [{ step: "claim", id: "wp-m1e1u1" }],
    );

    // When
    const report = await runQueue(driver);

    // Then
    expect(driver.calls).toEqual(["ready wp-m1e1u1", "claim wp-m1e1u1"]);
    expect(report.merged).toEqual([]);
    expect(report.failed).toEqual([
      { id: "wp-m1e1u1", stage: "start", message: "claim refused for wp-m1e1u1" },
    ]);
  });
});

describe("integration failures", () => {
  test("given a red suite when the loop runs then the leaf is not released and the merge is undone", async () => {
    // Given
    const driver = new FakeDriver(
      [["wp-m1e1u1", "wp-m1e1u2", "wp-m1e1u3"], []],
      [{ step: "verify", id: "wp-m1e1u2" }],
    );

    // When
    const report = await runQueue(driver);

    // Then the culprit is left doing, with its branch, and the next one still lands
    expect(report.merged).toEqual(["wp-m1e1u1", "wp-m1e1u3"]);
    expect(report.failed.map((failure) => [failure.id, failure.stage])).toEqual([
      ["wp-m1e1u2", "verify"],
    ]);
    expect(driver.calls).toContain("undoMerge wp-m1e1u2");
    expect(driver.calls).not.toContain("release wp-m1e1u2");
    expect(driver.calls).not.toContain("discard wp-m1e1u2");
    expect(indexOfCall(driver.calls, "undoMerge wp-m1e1u2")).toBeLessThan(
      indexOfCall(driver.calls, "merge wp-m1e1u3"),
    );
  });

  test("given a merge conflict when the loop runs then the suite is not run and the next branch still merges", async () => {
    // Given
    const driver = new FakeDriver(
      [["wp-m1e1u1", "wp-m1e1u2"], []],
      [{ step: "merge", id: "wp-m1e1u1" }],
    );

    // When
    const report = await runQueue(driver);

    // Then
    expect(report.merged).toEqual(["wp-m1e1u2"]);
    expect(report.failed.map((failure) => failure.stage)).toEqual(["merge"]);
    expect(driver.calls).not.toContain("verify wp-m1e1u1");
    expect(driver.calls).not.toContain("release wp-m1e1u1");
  });

  test("given an agent that dies when the loop runs then its branch is never merged", async () => {
    // Given
    const driver = new FakeDriver(
      [["wp-m1e1u1", "wp-m1e1u2"], []],
      [{ step: "work", id: "wp-m1e1u1" }],
    );

    // When
    const report = await runQueue(driver);

    // Then
    expect(report.merged).toEqual(["wp-m1e1u2"]);
    expect(report.failed.map((failure) => failure.stage)).toEqual(["agent"]);
    expect(driver.calls).not.toContain("merge wp-m1e1u1");
    expect(driver.calls).toContain("work wp-m1e1u2");
  });

  test("given a worktree that cannot be created when the loop runs then no agent is spawned for it", async () => {
    // Given
    const driver = new FakeDriver(
      [["wp-m1e1u1", "wp-m1e1u2"], []],
      [{ step: "prepare", id: "wp-m1e1u1" }],
    );

    // When
    const report = await runQueue(driver);

    // Then
    expect(report.failed.map((failure) => failure.stage)).toEqual(["setup"]);
    expect(driver.calls).not.toContain("work wp-m1e1u1");
    expect(report.merged).toEqual(["wp-m1e1u2"]);
  });

  test("given cleanup that fails when the loop runs then the leaf still counts as merged", async () => {
    // Given
    const driver = new FakeDriver(
      [["wp-m1e1u1"], []],
      [{ step: "discard", id: "wp-m1e1u1" }],
    );

    // When
    const report = await runQueue(driver);

    // Then
    expect(report.merged).toEqual(["wp-m1e1u1"]);
    expect(report.failed).toEqual([]);
  });

  test("given a merge that cannot be undone when the loop runs then it stops with an error", async () => {
    // Given
    const driver = new FakeDriver(
      [["wp-m1e1u1", "wp-m1e1u2"], []],
      [
        { step: "verify", id: "wp-m1e1u1" },
        { step: "undoMerge", id: "wp-m1e1u1" },
      ],
    );

    // When / Then the next branch must not be merged onto a broken main
    await expect(runQueue(driver)).rejects.toThrow(OrchestratorError);
    expect(driver.calls).not.toContain("merge wp-m1e1u2");
  });
});

describe("prompts and names", () => {
  test("given a role and a ticket when a prompt is composed then the role comes first", () => {
    // Given
    const role = "Role text.\n\n";
    const brief = "id: wp-m1e1u1\nshort_description: Parse frontmatter\n";

    // When
    const prompt = composePrompt(role, brief);

    // Then
    expect(prompt).toBe(
      "Role text.\n\n---\n\nid: wp-m1e1u1\nshort_description: Parse frontmatter\n",
    );
  });

  test("given a gate when the agent's tools are allowed then git and every program in it are listed", () => {
    // Given
    const verifyCommand = "bun test && bun run typecheck";

    // When
    const allowed = agentAllowedTools(verifyCommand);

    // Then
    expect(allowed).toEqual(["Bash(git:*)", "Bash(bun:*)"]);
  });

  test("given a gate that is only git when the agent's tools are allowed then git is listed once", () => {
    // Given
    const verifyCommand = "git diff --exit-code";

    // When
    const allowed = agentAllowedTools(verifyCommand);

    // Then
    expect(allowed).toEqual(["Bash(git:*)"]);
  });

  test("given an id when the workspace is named then the worktree is a sibling and the branch is namespaced", () => {
    // Given
    const repositoryRoot = "/home/dev/project";

    // When
    const worktree = worktreePath(repositoryRoot, "wp-m1e1u1");
    const branch = branchName("wp-m1e1u1");

    // Then
    expect(worktree).toBe("/home/dev/wt-wp-m1e1u1");
    expect(branch).toBe("wp/wp-m1e1u1");
  });

  test("given a red suite when the reason is taken then the failure count is used, not the first header", () => {
    // Given
    const result = {
      exitCode: 1,
      stdout: "",
      stderr: "tests/broken.test.ts:\nerror: expect(1).toBe(2)\n 1 pass\n 1 fail\n",
    };

    // When
    const message = verifyMessage(result);

    // Then
    expect(message).toBe("1 fail");
  });

  test("given output with no failure count when the reason is taken then the first line is used", () => {
    // Given
    const result = { exitCode: 3, stdout: "", stderr: "bun: command not found\n" };

    // When / Then
    expect(verifyMessage(result)).toBe("bun: command not found");
  });

  test("given a conflicting merge when the reason is taken then the CONFLICT line is used", () => {
    // Given
    const result = {
      exitCode: 1,
      stdout: "Auto-merging cart.ts\nCONFLICT (content): Merge conflict in cart.ts\n",
      stderr: "",
    };

    // When / Then
    expect(mergeMessage(result)).toBe("CONFLICT (content): Merge conflict in cart.ts");
  });

  test("given long output when a message is taken then the first non-empty line is used", () => {
    // Given
    const output = `\n\n${"x".repeat(300)}\nsecond line\n`;

    // When
    const message = firstLine(output);

    // Then
    expect(message).toBe(`${"x".repeat(200)}…`);
  });
});

describe("the agent environment", () => {
  test("given no telemetry attributes when an agent's environment is built then only the work package is tagged", () => {
    // Given
    const base = { PATH: "/usr/bin", HOME: "/home/dev" };

    // When
    const environment = agentEnvironment("wp-m1e1u1", base);

    // Then no leading comma: an empty attribute pair is rejected by some collectors
    expect(environment.OTEL_RESOURCE_ATTRIBUTES).toBe("wp.id=wp-m1e1u1");
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.HOME).toBe("/home/dev");
  });

  test("given attributes the operator already set when an agent's environment is built then the tag is appended", () => {
    // Given
    const base = { OTEL_RESOURCE_ATTRIBUTES: "department=eng" };

    // When
    const environment = agentEnvironment("wp-m1e1u1", base);

    // Then their own tags survive, and the caller's object is untouched
    expect(environment.OTEL_RESOURCE_ATTRIBUTES).toBe("department=eng,wp.id=wp-m1e1u1");
    expect(base.OTEL_RESOURCE_ATTRIBUTES).toBe("department=eng");
  });

  test("given a spawned agent when it reads its environment then it carries its own work-package id", () => {
    // Given a fake agent that reports the attributes it was handed
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    fixture.givenFakeAgent('printf "%s\\n" "$OTEL_RESOURCE_ATTRIBUTES"');

    // When
    fixture.runOrchestrator();

    // Then the tag reached the child process. The run itself fails and the exit
    // code is deliberately not asserted: a fake agent commits nothing, so its
    // branch is an ancestor of HEAD and `merge` refuses it — which happens after
    // `work` has already written this log.
    expect(fixture.logOf("wp-m1e1")).toContain("wp.id=wp-m1e1");
  });
});

describe("the ready queue", () => {
  test("given the json queue when parsed then ids and descriptions are returned in order", () => {
    // Given
    const json = `[
      { "id": "wp-m1e1u1", "short_description": "Parse frontmatter", "status": "todo" },
      { "id": "wp-m1e2", "short_description": "Write path", "status": "todo" }
    ]`;

    // When
    const queue = parseReadyQueue(json);

    // Then
    expect(queue).toEqual([
      { id: "wp-m1e1u1", description: "Parse frontmatter" },
      { id: "wp-m1e2", description: "Write path" },
    ]);
  });

  test("given an empty queue when parsed then it is empty", () => {
    // Given / When / Then
    expect(parseReadyQueue("[]")).toEqual([]);
    expect(parseReadyQueue("  ")).toEqual([]);
  });

  test("given output that is not a queue when parsed then it is refused", () => {
    // Given / When / Then
    expect(() => parseReadyQueue("{}")).toThrow(OrchestratorError);
    expect(() => parseReadyQueue("[{}]")).toThrow(OrchestratorError);
    expect(() => parseReadyQueue("not json")).toThrow(OrchestratorError);
  });
});

describe("the git driver", () => {
  test("given a branch with no commits of its own when it is merged then the agent is reported as having committed nothing", async () => {
    // Given a real repository and a branch an agent never committed on
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    fixture.givenBranch("wp/wp-m1e1");
    const driver = fixture.driver();

    // When / Then merging it would be a no-op, so it must not reach `wp done`
    await expect(driver.merge("wp-m1e1")).rejects.toThrow(/committed nothing/);
  });

  test("given uncommitted tracker edits when a merge is undone then the merge is gone and the edits survive", async () => {
    // Given a merged agent branch, plus the `wp start` edit nobody committed
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    fixture.givenAgentCommitOn("wp/wp-m1e1", "src.txt", "agent work\n");
    writeFileSync(
      join(fixture.directory, "wp-m1e1.md"),
      fixture.contentOf("wp-m1e1").replace("status: todo", "status: doing"),
      "utf8",
    );
    const driver = fixture.driver();
    await driver.merge("wp-m1e1");
    expect(fixture.headSubject()).toContain("Merge branch");

    // When
    await driver.undoMerge();

    // Then `--keep`, not `--hard`: the queue's own bookkeeping must survive
    expect(fixture.headSubject()).not.toContain("Merge branch");
    expect(fixture.contentOf("wp-m1e1")).toContain("status: doing");
  });

  test("given two branches that touch the same line when the second is merged then the merge is aborted", async () => {
    // Given two agents that both edited cart.txt
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "First");
    fixture.givenWp("wp-m1e2", "Second");
    fixture.givenCommittedRepository();
    fixture.givenAgentCommitOn("wp/wp-m1e1", "cart.txt", "written by one\n");
    fixture.givenAgentCommitOn("wp/wp-m1e2", "cart.txt", "written by two\n");
    const driver = fixture.driver();
    await driver.merge("wp-m1e1");

    // When
    const second = driver.merge("wp-m1e2");

    // Then the worktree is left mergeable for the next branch in the wave
    await expect(second).rejects.toThrow(/CONFLICT/);
    expect(fixture.isMidMerge()).toBe(false);
    expect(fixture.headSubject()).toContain("Merge branch 'wp/wp-m1e1'");
  });

  test("given a merged work package when it is discarded then the worktree and the branch both go", async () => {
    // Given an integrated branch whose worktree still has junk in it
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    const driver = fixture.driver();
    await driver.prepare("wp-m1e1");
    writeFileSync(join(worktreePath(fixture.root, "wp-m1e1"), "junk.txt"), "junk\n", "utf8");

    // When
    await driver.discard("wp-m1e1");

    // Then a leftover file must not block cleanup, or `prepare` refuses this id for ever
    expect(existsSync(worktreePath(fixture.root, "wp-m1e1"))).toBe(false);
    expect(fixture.branches()).not.toContain("wp/wp-m1e1");
  });
});

describe("the command line", () => {
  test("given --help when run then the usage is printed", () => {
    // Given
    const fixture = new RepositoryFixture();

    // When
    const result = fixture.runOrchestrator("--help");

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: orchestrate");
  });

  test("given an unknown flag when run then it is a usage error", () => {
    // Given
    const fixture = new RepositoryFixture();

    // When
    const result = fixture.runOrchestrator("--wave-plan");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("orchestrate: unrecognized argument: --wave-plan");
  });

  test("given a directory outside a git repository when run then it refuses", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not inside a git repository");
  });

  test("given unrelated local changes when run then it refuses before starting anything", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    fixture.givenUntrackedFile("scratch.txt");

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("the main worktree is not clean");
    expect(result.stderr).toContain("scratch.txt");
  });

  test("given agent logs from an earlier run when run then they do not count as unclean", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    mkdirSync(join(fixture.root, "log"));
    writeFileSync(join(fixture.root, "log", "wp-m1e1.log"), "agent output\n", "utf8");

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then
    expect(result.exitCode).toBe(0);
  });

  test("given a staged tracker change when run then it refuses, because every merge would fail", () => {
    // Given the tracker edits are staged, not just written
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    writeFileSync(
      join(fixture.directory, "wp-m1e1.md"),
      fixture.contentOf("wp-m1e1").replace("status: todo", "status: doing"),
      "utf8",
    );
    fixture.givenStaged("wps/wp-m1e1.md");

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then `git merge` refuses while anything is staged, so this must not start
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("the main worktree is not clean");
    expect(result.stderr).toContain("wps/wp-m1e1.md");
  });

  test("given tracker changes from an earlier run when run then they do not count as unclean", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    writeFileSync(
      join(fixture.directory, "wp-m1e1.md"),
      fixture.contentOf("wp-m1e1").replace("status: todo", "status: doing"),
      "utf8",
    );

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then
    expect(result.exitCode).toBe(0);
  });

  test("given a ready queue when a dry run is asked for then the plan is printed and nothing is claimed", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenWp("wp-m1e2", "Build the graph", ["wp-m1e1"]);
    fixture.givenCommittedRepository();

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then only the unblocked leaf is planned, and no status was written
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry run: nothing is claimed, spawned or merged");
    expect(result.stdout).toContain("wave 1: 1 ready");
    expect(result.stdout).toContain("wp-m1e1  Parse frontmatter");
    expect(result.stdout).toContain("wt-wp-m1e1 -b wp/wp-m1e1");
    expect(result.stdout).toContain("git merge --no-ff wp/wp-m1e1 && bun test && wp done wp-m1e1");
    expect(result.stdout).not.toContain("wp-m1e2");
    expect(fixture.contentOf("wp-m1e1")).toContain("status: todo");
  });

  test("given an empty queue when a dry run is asked for then it says so", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    writeFileSync(
      join(fixture.directory, "wp-m1e1.md"),
      readFileSync(join(fixture.directory, "wp-m1e1.md"), "utf8").replace(
        "status: todo",
        "status: done",
      ),
      "utf8",
    );
    fixture.givenCommittedRepository();

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("the queue is empty");
  });

  test("given a project with no role prompt when run then it says where the template is", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();
    fixture.whenRolePromptIsRemoved();

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no worker role prompt at");
    expect(result.stderr).toContain("copy the template from");
  });

  test("given --role and --verify when a dry run is asked for then both are used", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    writeFileSync(join(fixture.root, "other-role.md"), "# Other role\n", "utf8");
    fixture.givenCommittedRepository();

    // When
    const result = fixture.runOrchestrator(
      "--dry-run",
      "--role",
      "other-role.md",
      "--verify",
      "make check",
    );

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("&& make check && wp done wp-m1e1");
  });

  test("given a broken work-package directory when run then the wp error is reported", () => {
    // Given
    const fixture = new RepositoryFixture();
    writeFileSync(join(fixture.directory, "notes.md"), "no frontmatter here\n", "utf8");
    fixture.givenCommittedRepository();

    // When
    const result = fixture.runOrchestrator("--dry-run");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("run 'wp check'");
  });
});

describe("scoped runs", () => {
  test("given a scope when the driver is asked what is ready then only that subtree comes back", async () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenContainer("wp-m1", "Milestone");
    fixture.givenWp("wp-m1e1", "In scope");
    fixture.givenWp("wp-m10", "Tenth milestone");
    fixture.givenWp("wp-m2", "Out of scope");
    fixture.givenCommittedRepository();

    // When
    const ready = await fixture.driver("true", "wp-m1").ready();

    // Then
    expect(ready).toEqual(["wp-m1e1"]);
  });

  test("given a scope when a dry run is asked for then only that subtree is planned", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenContainer("wp-m1", "Milestone");
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenWp("wp-m2", "Somewhere else entirely");
    fixture.givenCommittedRepository();

    // When
    const result = fixture.runOrchestrator("--dry-run", "--scope", "wp-m1");

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wave 1: 1 ready");
    expect(result.stdout).toContain("wp-m1e1  Parse frontmatter");
    expect(result.stdout).not.toContain("wp-m2");
  });

  test("given a scope with nothing ready when a dry run is asked for then it says why", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenContainer("wp-m1", "Milestone");
    fixture.givenContainer("wp-m1e1", "Login epic");
    fixture.givenWp("wp-m1e1u1", "Blocked from outside", ["wp-m2e1"]);
    fixture.givenWp("wp-m1e1u2", "Already finished");
    writeFileSync(
      join(fixture.directory, "wp-m1e1u2.md"),
      readFileSync(join(fixture.directory, "wp-m1e1u2.md"), "utf8").replace(
        "status: todo",
        "status: done",
      ),
      "utf8",
    );
    fixture.givenContainer("wp-m2", "Other milestone");
    fixture.givenWp("wp-m2e1", "The blocker");
    fixture.givenCommittedRepository();

    // When
    const result = fixture.runOrchestrator("--dry-run", "--scope", "wp-m1e1");

    // Then every leaf in scope is accounted for, and the blocker is named as unreachable
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wave 1: nothing ready in scope wp-m1e1 (epic)");
    expect(result.stdout).toContain("wp-m1e1u1  blocked by wp-m2e1 (outside scope)");
    expect(result.stdout).toContain("wp-m1e1u2  done");
    expect(result.stdout).not.toContain("the queue is empty");
  });

  test("given a scope with nothing ready when the run starts then it explains and still succeeds", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenContainer("wp-m1", "Milestone");
    fixture.givenWp("wp-m1e1", "Blocked from outside", ["wp-m2"]);
    fixture.givenWp("wp-m2", "The blocker");
    fixture.givenCommittedRepository();
    fixture.givenFakeAgent();

    // When
    const result = fixture.runOrchestrator("--scope", "wp-m1");

    // Then an empty queue stays a success; the report is what changes
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wave 1: nothing ready in scope wp-m1 (milestone)");
    expect(result.stdout).toContain("wp-m1e1  blocked by wp-m2 (outside scope)");
    expect(result.stdout).toContain("queue empty after 0 wave(s)");
    expect(fixture.contentOf("wp-m1e1")).toContain("status: todo");
  });

  test("given a story scope with nothing ready when the run starts then the story itself is reported", () => {
    // Given a scope that is its own only row
    const fixture = new RepositoryFixture();
    fixture.givenContainer("wp-m1", "Milestone");
    fixture.givenContainer("wp-m1e1", "Epic");
    fixture.givenWp("wp-m1e1u1", "Blocked", ["wp-m1e1u2"]);
    fixture.givenWp("wp-m1e1u2", "The blocker");
    fixture.givenCommittedRepository();
    fixture.givenFakeAgent();

    // When
    const result = fixture.runOrchestrator("--scope", "wp-m1e1u1");

    // Then the blocker is a sibling story: inside the epic, outside this scope
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wave 1: nothing ready in scope wp-m1e1u1 (story)");
    expect(result.stdout).toContain("wp-m1e1u1  blocked by wp-m1e1u2 (outside scope)");
  });

  test("given a scope with no file when run then it is refused before anything starts", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();

    // When
    const result = fixture.runOrchestrator("--dry-run", "--scope", "wp-m9");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown work-package ID: wp-m9");
  });

  test("given --scope with no value when run then one value is demanded", () => {
    // Given
    const fixture = new RepositoryFixture();
    fixture.givenWp("wp-m1e1", "Parse frontmatter");
    fixture.givenCommittedRepository();

    // When
    const result = fixture.runOrchestrator("--dry-run", "--scope");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("argument --scope: expected one value");
  });
});
