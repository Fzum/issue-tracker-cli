import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PROJECT_ROOT = dirname(import.meta.dir);
const INSTALL_PATH = join(PROJECT_ROOT, "install.sh");
const TEMPLATE_ROLE = readFileSync(join(PROJECT_ROOT, "prompts", "worker.md"), "utf8");
const temporaryDirectories: string[] = [];

interface InstallResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A throwaway target project plus a throwaway HOME, so the default bin
 * directory (`$HOME/.local/bin`) is as disposable as the explicit one.
 */
class ProjectFixture {
  readonly root: string;
  readonly home: string;
  readonly binDirectory: string;

  constructor() {
    const base = mkdtempSync(join(tmpdir(), "install-test-"));
    temporaryDirectories.push(base);
    this.root = join(base, "project");
    mkdirSync(this.root);
    this.home = join(base, "home");
    mkdirSync(this.home);
    // Deliberately not created: the script has to create it itself.
    this.binDirectory = join(base, "bin");
  }

  givenGitRepository(): void {
    const result = Bun.spawnSync({
      cmd: ["git", "init", "-q"],
      cwd: this.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git init failed: ${result.stderr.toString()}`);
    }
  }

  givenFile(path: string, content: string): void {
    const target = join(this.root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  contentOf(path: string): string {
    return readFileSync(join(this.root, path), "utf8");
  }

  has(path: string): boolean {
    return existsSync(join(this.root, path));
  }

  /** Where `<name>` in the bin directory points, or "" when it is absent. */
  linkTarget(name: string, binDirectory = this.binDirectory): string {
    const path = join(binDirectory, name);
    return existsSync(path) ? readlinkSync(path) : "";
  }

  runInstall(...arguments_: string[]): InstallResult {
    return this.runInstallWith(
      { PATH: process.env["PATH"] ?? "", HOME: this.home, WP_BIN_DIR: this.binDirectory },
      ...arguments_,
    );
  }

  runInstallWith(
    environment: Record<string, string>,
    ...arguments_: string[]
  ): InstallResult {
    const result = Bun.spawnSync({
      cmd: [INSTALL_PATH, ...arguments_],
      cwd: this.root,
      env: environment,
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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("installing into a fresh project", () => {
  test("given a git repository with nothing installed when install runs then the queue, the role prompt, the ignore rule and both links appear", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();

    // When
    const result = fixture.runInstall();

    // Then
    expect(result.exitCode).toBe(0);
    expect(fixture.has("wps")).toBe(true);
    expect(fixture.contentOf("prompts/worker.md")).toBe(TEMPLATE_ROLE);
    expect(fixture.contentOf(".gitignore")).toContain("log/");
    expect(fixture.linkTarget("wp")).toBe(join(PROJECT_ROOT, "wp.ts"));
    expect(fixture.linkTarget("orchestrate")).toBe(join(PROJECT_ROOT, "orchestrate.ts"));
    // The report names every change, so a reader can see what was touched.
    expect(result.stdout).toContain("+ wps/");
    expect(result.stdout).toContain("+ prompts/worker.md");
    expect(result.stdout).toContain("+ log/ in .gitignore");
    expect(result.stdout).toContain("wp check: clean");
  });

  test("given no WP_BIN_DIR when install runs then both commands are linked into $HOME/.local/bin", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();
    const defaultBin = join(fixture.home, ".local", "bin");

    // When
    const result = fixture.runInstallWith({
      PATH: process.env["PATH"] ?? "",
      HOME: fixture.home,
    });

    // Then
    expect(result.exitCode).toBe(0);
    expect(fixture.linkTarget("wp", defaultBin)).toBe(join(PROJECT_ROOT, "wp.ts"));
    expect(fixture.linkTarget("orchestrate", defaultBin)).toBe(
      join(PROJECT_ROOT, "orchestrate.ts"),
    );
  });

  test("given a directory that is not a git repository when install runs then it warns and installs anyway", () => {
    // Given
    const fixture = new ProjectFixture();

    // When
    const result = fixture.runInstall();

    // Then — wp needs no git; only the orchestrator does, so this is a warning.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("! not a git repository");
    expect(fixture.has("wps")).toBe(true);
  });
});

describe("running install twice", () => {
  test("given a worker role prompt of your own when install runs then it is kept byte for byte", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();
    fixture.givenFile("prompts/worker.md", "# My own role\n\nDo it my way.\n");

    // When
    const result = fixture.runInstall();

    // Then
    expect(result.exitCode).toBe(0);
    expect(fixture.contentOf("prompts/worker.md")).toBe("# My own role\n\nDo it my way.\n");
    expect(result.stdout).toContain("= prompts/worker.md");
  });

  test("given a .gitignore that already ignores log/ when install runs then the rule is not added twice", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();
    fixture.givenFile(".gitignore", "node_modules/\nlog/\n");

    // When
    fixture.runInstall();

    // Then
    expect(occurrences(fixture.contentOf(".gitignore"), "log/")).toBe(1);
  });

  test("given a .gitignore with CRLF line endings when install runs then the rule is not added twice", () => {
    // Given — what `core.autocrlf=true` checks out on Windows and WSL.
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();
    fixture.givenFile(".gitignore", "node_modules/\r\nlog/\r\n");

    // When
    const result = fixture.runInstall();

    // Then — `grep -qxF 'log/'` alone never matches `log/\r`.
    expect(occurrences(fixture.contentOf(".gitignore"), "log/")).toBe(1);
    expect(result.stdout).toContain("= log/ in .gitignore");
  });

  test("given a .gitignore with no final newline when install runs then log/ lands on its own line", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();
    fixture.givenFile(".gitignore", "node_modules/");

    // When
    fixture.runInstall();

    // Then
    expect(fixture.contentOf(".gitignore")).toContain("node_modules/\n");
    expect(fixture.contentOf(".gitignore").split("\n")).toContain("log/");
  });

  test("given a complete install when install runs a second time then it changes nothing", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();
    fixture.runInstall();
    const before = fixture.contentOf(".gitignore");

    // When
    const result = fixture.runInstall();

    // Then
    expect(result.exitCode).toBe(0);
    expect(fixture.contentOf(".gitignore")).toBe(before);
    expect(fixture.linkTarget("wp")).toBe(join(PROJECT_ROOT, "wp.ts"));
    expect(result.stdout).toContain("= wps/");
    expect(result.stdout).not.toContain("+ wps/");
  });

  test("given a wp link that points somewhere else when install runs then it is left alone", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();
    mkdirSync(fixture.binDirectory, { recursive: true });
    const foreign = join(fixture.root, "other-wp");
    writeFileSync(foreign, "#!/bin/sh\n", "utf8");
    symlinkSync(foreign, join(fixture.binDirectory, "wp"));

    // When
    const result = fixture.runInstall();

    // Then — clobbering another tool's command silently is worse than stopping.
    expect(fixture.linkTarget("wp")).toBe(foreign);
    expect(result.stdout).toContain("already points at");
  });
});

describe("--dry-run", () => {
  test("given --dry-run when install runs then it reports every change and writes nothing", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();

    // When
    const result = fixture.runInstall("--dry-run");

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toContain("+ wps/");
    expect(fixture.has("wps")).toBe(false);
    expect(fixture.has("prompts/worker.md")).toBe(false);
    expect(fixture.has(".gitignore")).toBe(false);
    expect(existsSync(fixture.binDirectory)).toBe(false);
  });
});

describe("the smoke test", () => {
  test("given a work-package directory with a problem when install runs then wp check reports it and the exit code is 1", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();
    fixture.givenFile("wps/notes.md", "not a work package\n");

    // When
    const result = fixture.runInstall();

    // Then — exit 1 is this project's "check found problems", nothing worse.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("notes.md");
    expect(fixture.has("prompts/worker.md")).toBe(true);
  });
});

describe("the PATH hint", () => {
  test("given a bin directory that is not on PATH when install runs then the export line is printed", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();

    // When
    const result = fixture.runInstall();

    // Then
    expect(result.stdout).toContain("is not on your PATH");
    expect(result.stdout).toContain(`export PATH="${fixture.binDirectory}:$PATH"`);
  });

  test("given a bin directory already on PATH when install runs then no export line is printed", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();

    // When
    const result = fixture.runInstallWith({
      PATH: `${fixture.binDirectory}:${process.env["PATH"] ?? ""}`,
      HOME: fixture.home,
      WP_BIN_DIR: fixture.binDirectory,
    });

    // Then
    expect(result.stdout).not.toContain("is not on your PATH");
    expect(result.stdout).not.toContain("export PATH");
  });
});

describe("refusals", () => {
  test("given bun is not on PATH when install runs then it refuses with exit 2 and writes nothing", () => {
    // Given
    const fixture = new ProjectFixture();
    fixture.givenGitRepository();

    // When
    const result = fixture.runInstallWith({
      PATH: "/nonexistent",
      HOME: fixture.home,
      WP_BIN_DIR: fixture.binDirectory,
    });

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("bun");
    expect(fixture.has("wps")).toBe(false);
  });

  test("given the issue-tracker-cli clone itself when install runs there then it refuses with exit 2", () => {
    // Given
    const fixture = new ProjectFixture();

    // When — the current directory is the tool's own clone, not a target project.
    const result = Bun.spawnSync({
      cmd: [INSTALL_PATH],
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: fixture.home,
        WP_BIN_DIR: fixture.binDirectory,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Then — it must refuse before it writes, or it would edit the tool repo.
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("clone itself");
    expect(existsSync(fixture.binDirectory)).toBe(false);
  });

  test("given an unknown option when install runs then it refuses with exit 2 and prints the usage", () => {
    // Given
    const fixture = new ProjectFixture();

    // When
    const result = fixture.runInstall("--wat");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--wat");
    expect(result.stderr).toContain("usage: install.sh");
  });

  test("given --help when install runs then it prints the usage and exits 0", () => {
    // Given
    const fixture = new ProjectFixture();

    // When
    const result = fixture.runInstall("--help");

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: install.sh");
    expect(fixture.has("wps")).toBe(false);
  });
});
