/**
 * Shared fixture for the suite: real work-package files in a real temp directory.
 *
 * `afterEach(cleanupFixtures)` is deliberately NOT registered in this module. Bun
 * evaluates a module once per test process, so a hook registered here at import time
 * would attach to whichever test file imported it first and every other file would
 * leak its temp directories. Each test file registers the hook itself instead — one
 * line, and it works however the runner isolates files.
 *
 * Note that `cleanupFixtures` then removes every directory registered in this *process*,
 * not just the calling file's. That is safe only because Bun runs test files serially
 * with synchronous bodies, so no other file holds a live fixture when the hook fires. If
 * that ever changes, scope the registry per file — do not widen the hook.
 */
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check, loadGraph, scanDirectory, type Problem, type WpGraph } from "../wp.ts";

export const PROJECT_ROOT = dirname(import.meta.dir);
export const CLI_PATH = join(PROJECT_ROOT, "wp.ts");

const temporaryDirectories: string[] = [];

export interface WpOptions {
  readonly status?: string | null;
  readonly description?: string | null;
  readonly blockedBy?: readonly string[] | null;
  readonly extraFrontmatter?: string;
  readonly body?: string;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class Fixture {
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

export function cleanupFixtures(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function expectProblem(fixture: Fixture, expected: string): void {
  const messages = fixture.whenChecked().map((problem) => problem.message);
  expect(messages.some((message) => message.includes(expected))).toBe(true);
}
