import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  check,
  finishWp,
  FrontmatterError,
  FrontmatterParseError,
  loadGraph,
  parentId,
  parseWp,
  scanDirectory,
  setStatus,
  startWp,
  TransitionError,
  UnknownWpError,
  type Problem,
  type WpGraph,
} from "../wp.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const CLI_PATH = join(PROJECT_ROOT, "wp.ts");
const temporaryDirectories: string[] = [];

interface WpOptions {
  readonly status?: string | null;
  readonly description?: string | null;
  readonly blockedBy?: readonly string[] | null;
  readonly extraFrontmatter?: string;
  readonly body?: string;
}

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

class Fixture {
  readonly root: string;
  readonly directory: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "wp-test-"));
    temporaryDirectories.push(this.root);
    this.directory = join(this.root, "wps");
    mkdirSync(this.directory);
  }

  givenWp(id: string, options: WpOptions = {}): string {
    const {
      status = "todo",
      description = null,
      blockedBy = null,
      extraFrontmatter = "",
      body = "\n## Context\nWork package body.\n",
    } = options;
    const lines = ["---"];
    if (status !== null) lines.push(`status: ${status}`);
    if (blockedBy !== null) lines.push(`blocked_by: [${blockedBy.join(", ")}]`);
    if (description !== null) lines.push(`short_description: "${description}"`);
    if (extraFrontmatter) lines.push(...extraFrontmatter.trim().split("\n"));
    lines.push("---");
    return this.givenRawFile(`${id}.md`, lines.join("\n") + body);
  }

  givenRawFile(filename: string, content: string): string {
    const path = join(this.directory, filename);
    writeFileSync(path, content, "utf8");
    return path;
  }

  whenChecked(): Problem[] {
    return check(scanDirectory(this.directory));
  }

  givenGraph(): WpGraph {
    return loadGraph(this.directory);
  }

  contentOf(filename: string): string {
    return readFileSync(join(this.directory, filename), "utf8");
  }

  runCli(...arguments_: string[]): CliResult {
    const result = Bun.spawnSync({
      cmd: [process.execPath, CLI_PATH, ...arguments_],
      stdout: "pipe",
      stderr: "pipe",
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

function expectProblem(fixture: Fixture, expected: string): void {
  const messages = fixture.whenChecked().map((problem) => problem.message);
  expect(messages.some((message) => message.includes(expected))).toBe(true);
}

describe("parse", () => {
  test("given a valid leaf when parsed then its fields and body are returned", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenWp("wp-m1", {
      description: "First milestone task",
      body: "\nTicket body\n",
    });

    // When
    const workPackage = parseWp(path);

    // Then
    expect(workPackage.id).toBe("wp-m1");
    expect(workPackage.status).toBe("todo");
    expect(workPackage.shortDescription).toBe("First milestone task");
    expect(workPackage.body).toBe("Ticket body\n");
  });

  test("given a valid container when parsed then blocked_by defaults to empty", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenWp("wp-m1", {
      status: null,
      description: "Authentication milestone",
    });

    // When
    const workPackage = parseWp(path);

    // Then
    expect(workPackage.blockedBy).toEqual([]);
  });

  test("given inline blocked_by when parsed then dependencies are returned", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenWp("wp-m1", {
      description: "Dependent work",
      blockedBy: ["wp-m2", "wp-m10e2"],
    });

    // When
    const workPackage = parseWp(path);

    // Then
    expect(workPackage.blockedBy).toEqual(["wp-m2", "wp-m10e2"]);
  });

  test("given a blocked_by block list when parsed then dependencies are returned", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      `---
status: todo
blocked_by:
  - wp-m2
  - 'wp-m3'
short_description: Block list
---
Body
`,
    );

    // When
    const workPackage = parseWp(path);

    // Then
    expect(workPackage.blockedBy).toEqual(["wp-m2", "wp-m3"]);
  });

  test("given an unknown scalar field when parsed then it is preserved", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenWp("wp-m1", {
      description: "Extensible work package",
      extraFrontmatter: "priority: high",
    });

    // When
    const workPackage = parseWp(path);

    // Then
    expect(workPackage.fields.priority).toBe("high");
  });

  test("given missing frontmatter when parsed then a clear error is raised", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile("wp-m1.md", "No frontmatter\n");

    // When / Then
    expect(() => parseWp(path)).toThrow(FrontmatterError);
    expect(() => parseWp(path)).toThrow("missing");
  });

  test("given unterminated frontmatter when parsed then a clear error is raised", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      "---\nstatus: todo\nshort_description: Work\n",
    );

    // When / Then
    expect(() => parseWp(path)).toThrow(FrontmatterError);
    expect(() => parseWp(path)).toThrow("unterminated");
  });

  test("given a line without a colon when parsed then a subset error is raised", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      "---\nstatus todo\nshort_description: Work\n---\n",
    );

    // When / Then
    expect(() => parseWp(path)).toThrow(FrontmatterParseError);
    expect(() => parseWp(path)).toThrow("key: value");
  });

  test("given a nested map when parsed then a subset error is raised", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      "---\nstatus: todo\nshort_description: Work\nmetadata:\n  owner: agent\n---\n",
    );

    // When / Then
    expect(() => parseWp(path)).toThrow(FrontmatterParseError);
  });

  test("given a multiline scalar when parsed then a subset error is raised", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      "---\nstatus: todo\nshort_description: |\n  Multiple lines\n---\n",
    );

    // When / Then
    expect(() => parseWp(path)).toThrow("unsupported YAML");
  });

  test("given an anchor when parsed then a subset error is raised", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      "---\nstatus: todo\nshort_description: &summary Work\n---\n",
    );

    // When / Then
    expect(() => parseWp(path)).toThrow("unsupported YAML");
  });
});

describe("graph", () => {
  test("given a hierarchy when its graph is built then parent children and types are derived", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: null, description: "Epic" });
    fixture.givenWp("wp-m1e1u1", { description: "Story" });
    fixture.givenWp("wp-m1e1u1t1", { description: "Task" });

    // When
    const graph = fixture.givenGraph();

    // Then
    expect(parentId("wp-m1e1u1")).toBe("wp-m1e1");
    expect(graph.children.get("wp-m1")).toEqual(["wp-m1e1"]);
    expect(graph.typeName("wp-m1")).toBe("milestone");
    expect(graph.typeName("wp-m1e1")).toBe("epic");
    expect(graph.typeName("wp-m1e1u1")).toBe("story");
    expect(graph.typeName("wp-m1e1u1t1")).toBe("task");
  });

  test("given dependencies when a graph is built then blocks are inverted", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { description: "Second" });
    fixture.givenWp("wp-m3", { description: "Third", blockedBy: ["wp-m2"] });

    // When
    const graph = fixture.givenGraph();

    // Then
    expect(graph.blocks.get("wp-m2")).toEqual(["wp-m1", "wp-m3"]);
  });

  test("given a self edge when cycles are detected then its member is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", {
      description: "Self cycle",
      blockedBy: ["wp-m1"],
    });

    // When
    const cycles = fixture.givenGraph().dependencyCycles();

    // Then
    expect(cycles).toEqual([["wp-m1"]]);
  });

  test("given a two-node cycle when cycles are detected then both members are reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { description: "Second", blockedBy: ["wp-m1"] });

    // When
    const cycles = fixture.givenGraph().dependencyCycles();

    // Then
    expect(cycles).toEqual([["wp-m1", "wp-m2"]]);
  });

  test("given a long cycle when cycles are detected then all members are reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { description: "Second", blockedBy: ["wp-m3"] });
    fixture.givenWp("wp-m3", { description: "Third", blockedBy: ["wp-m1"] });

    // When
    const cycles = fixture.givenGraph().dependencyCycles();

    // Then
    expect(cycles).toEqual([["wp-m1", "wp-m2", "wp-m3"]]);
  });
});

function givenContainerWithChildStatuses(...statuses: string[]): WpGraph {
  const fixture = new Fixture();
  fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
  statuses.forEach((status, index) => {
    fixture.givenWp(`wp-m1e${index + 1}`, {
      status,
      description: `Child ${index + 1}`,
    });
  });
  return fixture.givenGraph();
}

describe("query", () => {
  test("given all todo children when status is resolved then the container is todo", () => {
    // Given
    const graph = givenContainerWithChildStatuses("todo", "todo");

    // When
    const status = graph.resolvedStatus("wp-m1");

    // Then
    expect(status).toBe("todo");
  });

  test("given a doing child when status is resolved then the container is doing", () => {
    // Given
    const graph = givenContainerWithChildStatuses("todo", "doing");

    // When
    const status = graph.resolvedStatus("wp-m1");

    // Then
    expect(status).toBe("doing");
  });

  test("given done and todo children when status is resolved then the container is doing", () => {
    // Given
    const graph = givenContainerWithChildStatuses("done", "todo");

    // When
    const status = graph.resolvedStatus("wp-m1");

    // Then
    expect(status).toBe("doing");
  });

  test("given all done children when status is resolved then the container is done", () => {
    // Given
    const graph = givenContainerWithChildStatuses("done", "done");

    // When
    const status = graph.resolvedStatus("wp-m1");

    // Then
    expect(status).toBe("done");
  });

  test("given an unfinished leaf dependency when readiness is queried then the leaf is blocked", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "Dependent", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { status: "doing", description: "Dependency" });

    // When
    const ready = fixture.givenGraph().isReady("wp-m1");

    // Then
    expect(ready).toBe(false);
  });

  test("given a done container dependency when readiness is queried then the leaf is ready", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "Dependent", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { status: null, description: "Dependency milestone" });
    fixture.givenWp("wp-m2e1", { status: "done", description: "Done dependency" });

    // When
    const ready = fixture.givenGraph().isReady("wp-m1");

    // Then
    expect(ready).toBe(true);
  });

  test("given an ancestor dependency when readiness is queried then its descendant is blocked", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", {
      status: null,
      description: "Blocked milestone",
      blockedBy: ["wp-m2"],
    });
    fixture.givenWp("wp-m1e1", { description: "Otherwise ready leaf" });
    fixture.givenWp("wp-m2", { status: "todo", description: "Dependency" });

    // When
    const ready = fixture.givenGraph().isReady("wp-m1e1");

    // Then
    expect(ready).toBe(false);
  });

  test("given m2 and m10 when the ready queue is built then natural order is used", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m10", { description: "Tenth" });
    fixture.givenWp("wp-m2", { description: "Second" });

    // When
    const readyIds = fixture.givenGraph().readyQueue().map((wp) => wp.id);

    // Then
    expect(readyIds).toEqual(["wp-m2", "wp-m10"]);
  });

  test("given no todo leaves when the ready queue is built then it is empty", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "done", description: "Completed" });

    // When
    const ready = fixture.givenGraph().readyQueue();

    // Then
    expect(ready).toEqual([]);
  });
});

describe("check", () => {
  test("given a bad filename when checked then a filename problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenRawFile(
      "milestone.md",
      "---\nstatus: todo\nshort_description: Work\n---\n",
    );

    // When / Then
    expectProblem(fixture, "filename does not match");
  });

  test("given missing frontmatter when checked then a missing problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenRawFile("wp-m1.md", "Ticket body\n");

    // When / Then
    expectProblem(fixture, "frontmatter block missing");
  });

  test("given unterminated frontmatter when checked then an unterminated problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenRawFile("wp-m1.md", "---\nstatus: todo\n");

    // When / Then
    expectProblem(fixture, "frontmatter block unterminated");
  });

  test("given invalid subset YAML when checked then a parse problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenRawFile(
      "wp-m1.md",
      "---\nstatus todo\nshort_description: Work\n---\n",
    );

    // When / Then
    expectProblem(fixture, "expected 'key: value'");
  });

  test("given an empty description when checked then a description problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "" });

    // When / Then
    expectProblem(fixture, "short_description missing or empty");
  });

  test("given a leaf without status when checked then a missing status problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Leaf" });

    // When / Then
    expectProblem(fixture, "status missing on leaf");
  });

  test("given a container with status when checked then its status problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "Container" });
    fixture.givenWp("wp-m1e1", { description: "Child" });

    // When / Then
    expectProblem(fixture, "status present on container");
  });

  test("given an invalid status when checked then allowed statuses are reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "cancelled", description: "Invalid state" });

    // When / Then
    expectProblem(fixture, "todo, doing, done");
  });

  test("given an unknown dependency when checked then a reference problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", {
      description: "Unknown dependency",
      blockedBy: ["wp-m99"],
    });

    // When / Then
    expectProblem(fixture, "references unknown WP wp-m99");
  });

  test("given a self dependency when checked then a self-reference problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", {
      description: "Self dependency",
      blockedBy: ["wp-m1"],
    });

    // When / Then
    expectProblem(fixture, "references the WP itself");
  });

  test("given a dependency cycle when checked then all cycle members are reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { description: "Second", blockedBy: ["wp-m1"] });

    // When / Then
    expectProblem(fixture, "blocked_by cycle: wp-m1, wp-m2");
  });

  test("given a missing parent when checked then an orphan problem is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1e1u1", { description: "Orphan" });

    // When / Then
    expectProblem(fixture, "parent WP wp-m1e1 has no file");
  });

  test("given a valid folder when checked then no problems are returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: "done", description: "Completed epic" });
    fixture.givenWp("wp-m2", {
      description: "Ready after milestone",
      blockedBy: ["wp-m1"],
    });

    // When
    const problems = fixture.whenChecked();

    // Then
    expect(problems).toEqual([]);
  });
});

describe("CLI", () => {
  test("given ready work when next runs then the first natural item is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m10", { description: "Tenth" });
    fixture.givenWp("wp-m2", { description: "Second" });

    // When
    const result = fixture.runCli("next", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("wp-m2\ttodo\tSecond\n");
  });

  test("given ready work when next all JSON runs then a stable array is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m2", { description: "Second" });
    fixture.givenWp("wp-m1", { status: "done", description: "Completed" });

    // When
    const result = fixture.runCli(
      "next",
      "--all",
      "--json",
      "--dir",
      fixture.directory,
    );

    // Then
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "wp-m2", short_description: "Second", status: "todo" },
    ]);
  });

  test("given an empty queue when next JSON runs then nothing and success are returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "done", description: "Completed" });

    // When
    const result = fixture.runCli("--dir", fixture.directory, "--json", "next");

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("given a known container when show JSON runs then its derived shape is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: "done", description: "Completed child" });

    // When
    const result = fixture.runCli(
      "show",
      "wp-m1",
      "--json",
      "--dir",
      fixture.directory,
    );
    const payload = JSON.parse(result.stdout);

    // Then
    expect(result.exitCode).toBe(0);
    expect(payload.rolled_up_status).toBe("done");
    expect(payload.children).toEqual(["wp-m1e1"]);
    expect(payload.is_leaf).toBe(false);
    expect(payload.ready).toBe(false);
  });

  test("given an unknown ID when show runs then exit two is returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "Known" });

    // When
    const result = fixture.runCli("show", "wp-m2", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown work-package ID");
  });

  test("given a hierarchy when tree runs then an indented rollup is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: "doing", description: "Child" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "wp-m1\tdoing\tMilestone\n  wp-m1e1\tdoing\tChild\n",
    );
  });

  test("given an invalid folder when check runs then problems and exit one are returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Leaf without status" });

    // When
    const result = fixture.runCli("check", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("wp-m1.md: status missing on leaf");
  });

  test("given a valid folder when check JSON runs then an empty array and success are returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "Valid" });

    // When
    const result = fixture.runCli("check", "--json", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  test("given a missing directory when a command runs then exit two is returned", () => {
    // Given
    const fixture = new Fixture();
    const missingDirectory = join(fixture.directory, "missing");

    // When
    const result = fixture.runCli("next", "--dir", missingDirectory);

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot read directory");
  });
});

describe("write", () => {
  test("given a leaf with a body and extra keys when its status is set then only the status line changes", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      "---\n# a comment\nstatus: todo\nowner: agent-7\nshort_description: \"First\"\n---\n\n## Context\nstatus: not this one.\n",
    );

    // When
    setStatus(path, "doing");

    // Then
    expect(fixture.contentOf("wp-m1.md")).toBe(
      "---\n# a comment\nstatus: doing\nowner: agent-7\nshort_description: \"First\"\n---\n\n## Context\nstatus: not this one.\n",
    );
  });

  test("given carriage return line endings when the status is set then the endings are preserved", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      "---\r\nstatus: todo\r\nshort_description: \"First\"\r\n---\r\nBody\r\n",
    );

    // When
    setStatus(path, "done");

    // Then
    expect(fixture.contentOf("wp-m1.md")).toBe(
      "---\r\nstatus: done\r\nshort_description: \"First\"\r\n---\r\nBody\r\n",
    );
  });

  test("given a file without a trailing newline when the status is set then none is added", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenRawFile(
      "wp-m1.md",
      "---\nstatus: todo\nshort_description: \"First\"\n---\nNo trailing newline",
    );

    // When
    setStatus(path, "doing");

    // Then
    expect(fixture.contentOf("wp-m1.md")).toBe(
      "---\nstatus: doing\nshort_description: \"First\"\n---\nNo trailing newline",
    );
  });

  test("given a leaf without a status field when its status is set then a frontmatter error is raised", () => {
    // Given
    const fixture = new Fixture();
    const path = fixture.givenWp("wp-m1", { status: null, description: "First" });

    // When / Then
    expect(() => setStatus(path, "doing")).toThrow(FrontmatterError);
    expect(fixture.contentOf("wp-m1.md")).not.toContain("status:");
  });
});

describe("start", () => {
  test("given a ready leaf when started then its file records doing", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });

    // When
    const started = startWp(fixture.givenGraph(), "wp-m1");

    // Then
    expect(started.status).toBe("doing");
    expect(fixture.contentOf("wp-m1.md")).toContain("status: doing");
  });

  test("given a leaf already doing when started again then it stays doing", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "doing", description: "First" });
    const before = fixture.contentOf("wp-m1.md");

    // When
    const started = startWp(fixture.givenGraph(), "wp-m1");

    // Then
    expect(started.status).toBe("doing");
    expect(fixture.contentOf("wp-m1.md")).toBe(before);
  });

  test("given a container when started then a transition error is raised", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { description: "Story" });
    const graph = fixture.givenGraph();

    // When / Then
    expect(() => startWp(graph, "wp-m1")).toThrow(TransitionError);
    expect(() => startWp(graph, "wp-m1")).toThrow("container");
  });

  test("given another leaf already doing when a second is started then both are doing", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "doing", description: "First" });
    fixture.givenWp("wp-m2", { description: "Second" });

    // When
    const started = startWp(fixture.givenGraph(), "wp-m2");

    // Then
    expect(started.status).toBe("doing");
    expect(fixture.contentOf("wp-m1.md")).toContain("status: doing");
  });

  test("given a blocked leaf when started then the blocker is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });
    fixture.givenWp("wp-m2", { description: "Second", blockedBy: ["wp-m1"] });
    const graph = fixture.givenGraph();

    // When / Then
    expect(() => startWp(graph, "wp-m2")).toThrow("blocked by wp-m1");
    expect(fixture.contentOf("wp-m2.md")).toContain("status: todo");
  });

  test("given a leaf whose ancestor is blocked when started then the blocker is reported", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });
    fixture.givenWp("wp-m2", {
      status: null,
      description: "Second",
      blockedBy: ["wp-m1"],
    });
    fixture.givenWp("wp-m2e1", { description: "Second epic" });
    const graph = fixture.givenGraph();

    // When / Then
    expect(() => startWp(graph, "wp-m2e1")).toThrow("blocked by wp-m1");
  });

  test("given a done leaf when started then it is reopened as doing", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "done", description: "First" });

    // When
    const started = startWp(fixture.givenGraph(), "wp-m1");

    // Then
    expect(started.status).toBe("doing");
    expect(fixture.contentOf("wp-m1.md")).toContain("status: doing");
  });

  test("given a blocked leaf when started with force then its file records doing", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });
    fixture.givenWp("wp-m2", { description: "Second", blockedBy: ["wp-m1"] });

    // When
    const started = startWp(fixture.givenGraph(), "wp-m2", true);

    // Then
    expect(started.status).toBe("doing");
    expect(fixture.contentOf("wp-m2.md")).toContain("status: doing");
  });

  test("given a doing story under one epic when a story under another is started then it succeeds", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: null, description: "Epic one" });
    fixture.givenWp("wp-m1e1u1", { status: "doing", description: "Story one" });
    fixture.givenWp("wp-m1e2", { status: null, description: "Epic two" });
    fixture.givenWp("wp-m1e2u1", { description: "Story two" });

    // When
    const started = startWp(fixture.givenGraph(), "wp-m1e2u1");

    // Then
    expect(started.status).toBe("doing");
    expect(fixture.contentOf("wp-m1e1u1.md")).toContain("status: doing");
  });

  test("given an unknown ID when started then an unknown work-package error is raised", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });
    const graph = fixture.givenGraph();

    // When / Then
    expect(() => startWp(graph, "wp-m9")).toThrow(UnknownWpError);
  });
});

describe("done", () => {
  test("given a doing leaf when finished then its file records done", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "doing", description: "First" });

    // When
    const finished = finishWp(fixture.givenGraph(), "wp-m1");

    // Then
    expect(finished.status).toBe("done");
    expect(fixture.contentOf("wp-m1.md")).toContain("status: done");
  });

  test("given a leaf already done when finished again then it stays done", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "done", description: "First" });
    const before = fixture.contentOf("wp-m1.md");

    // When
    const finished = finishWp(fixture.givenGraph(), "wp-m1");

    // Then
    expect(finished.status).toBe("done");
    expect(fixture.contentOf("wp-m1.md")).toBe(before);
  });

  test("given a todo leaf when finished then it is reported as not started", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });
    const graph = fixture.givenGraph();

    // When / Then
    expect(() => finishWp(graph, "wp-m1")).toThrow("is todo, not doing");
    expect(fixture.contentOf("wp-m1.md")).toContain("status: todo");
  });

  test("given a container when finished then a transition error is raised", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { description: "Story" });
    const graph = fixture.givenGraph();

    // When / Then
    expect(() => finishWp(graph, "wp-m1")).toThrow(TransitionError);
  });

  test("given a todo leaf when finished with force then its file records done", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });

    // When
    const finished = finishWp(fixture.givenGraph(), "wp-m1", true);

    // Then
    expect(finished.status).toBe("done");
    expect(fixture.contentOf("wp-m1.md")).toContain("status: done");
  });
});

describe("CLI transitions", () => {
  test("given a ready leaf when start runs then the row is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });

    // When
    const result = fixture.runCli("start", "wp-m1", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("wp-m1\tdoing\tFirst\n");
  });

  test("given a ready leaf when start JSON runs then the queue shape is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });

    // When
    const result = fixture.runCli(
      "start",
      "wp-m1",
      "--json",
      "--dir",
      fixture.directory,
    );

    // Then
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: "wp-m1",
      short_description: "First",
      status: "doing",
    });
  });

  test("given a started story when tree runs then its ancestors roll up to doing", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: null, description: "Epic" });
    fixture.givenWp("wp-m1e1u1", { description: "Story one" });
    fixture.givenWp("wp-m1e1u2", { description: "Story two" });

    // When
    fixture.runCli("start", "wp-m1e1u1", "--dir", fixture.directory);
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "wp-m1\tdoing\tMilestone\n" +
        "  wp-m1e1\tdoing\tEpic\n" +
        "    wp-m1e1u1\tdoing\tStory one\n" +
        "    wp-m1e1u2\ttodo\tStory two\n",
    );
  });

  test("given a blocked leaf when start runs then exit two reports the blocker", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });
    fixture.givenWp("wp-m2", { description: "Second", blockedBy: ["wp-m1"] });

    // When
    const result = fixture.runCli("start", "wp-m2", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("wp: wp-m2 is blocked by wp-m1");
  });

  test("given a blocked leaf when start runs with force then exit zero is returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });
    fixture.givenWp("wp-m2", { description: "Second", blockedBy: ["wp-m1"] });

    // When
    const result = fixture.runCli(
      "start",
      "wp-m2",
      "--force",
      "--dir",
      fixture.directory,
    );

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("wp-m2\tdoing\tSecond\n");
  });

  test("given a doing leaf when done runs then the row is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "doing", description: "First" });

    // When
    const result = fixture.runCli("done", "wp-m1", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("wp-m1\tdone\tFirst\n");
  });

  test("given no ID when start runs then exit two is returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });

    // When
    const result = fixture.runCli("start", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("start requires exactly one ID");
  });

  test("given force on next when it runs then exit two is returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });

    // When
    const result = fixture.runCli("next", "--force", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unrecognized argument: --force");
  });

  test("given an unparseable file when start runs then exit two is returned", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "First" });
    fixture.givenRawFile("wp-m2.md", "no frontmatter here\n");

    // When
    const result = fixture.runCli("start", "wp-m1", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("run 'wp check'");
    expect(fixture.contentOf("wp-m1.md")).toContain("status: todo");
  });
});
