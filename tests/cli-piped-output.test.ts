/**
 * `wp.ts` ends with `process.exitCode = main()` rather than `process.exit(main())`,
 * because the latter discards output past 128 KiB on a pipe. The cost is that stdout
 * EPIPE is no longer swallowed by the exit, so the entry guard installs a handler for
 * it. These two cases pin both halves: output must survive a draining reader, and an
 * early-closing reader must not turn into a crash. Both need output larger than the
 * ~64 KiB pipe buffer, so neither is visible on a small fixture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupFixtures, CLI_PATH, type CliResult, Fixture } from "./helpers.ts";

afterEach(cleanupFixtures);

describe("CLI piped output", () => {
  function givenLargeTree(fixture: Fixture): void {
    fixture.givenWp("wp-m1", { status: null, description: "Large milestone" });
    for (let index = 1; index <= 900; index += 1) {
      fixture.givenWp(`wp-m1e${index}`, {
        description: `Leaf ${index} with a description long enough to push the total output past the pipe buffer`,
      });
    }
  }

  function whenPipedThrough(fixture: Fixture, reader: string, ...arguments_: string[]): CliResult {
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `set -o pipefail; "$1" "$2" "\${@:3}" | ${reader}`,
        "bash",
        process.execPath,
        CLI_PATH,
        ...arguments_,
      ],
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

  /**
   * A file and a pipe must receive the same bytes. Only file redirection is immune to
   * the truncation, so comparing two pipes would pass even while both lost data.
   */
  function whenRedirectedToFile(fixture: Fixture, ...arguments_: string[]): string {
    const target = join(fixture.root, "redirected.out");
    Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'target="$3"; "$1" "$2" "${@:4}" > "$target"',
        "bash",
        process.execPath,
        CLI_PATH,
        target,
        ...arguments_,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    return readFileSync(target, "utf8");
  }

  test("given output past the pipe buffer when the reader drains it then nothing is truncated", () => {
    // Given
    const fixture = new Fixture();
    givenLargeTree(fixture);
    const expected = whenRedirectedToFile(fixture, "tree", "--json", "--dir", fixture.directory);
    expect(expected.length).toBeGreaterThan(128 * 1024);

    // When
    const piped = whenPipedThrough(fixture, "cat", "tree", "--json", "--dir", fixture.directory);

    // Then
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout).toBe(expected);
  });

  test("given output past the pipe buffer when the reader closes early then it exits cleanly", () => {
    // Given
    const fixture = new Fixture();
    givenLargeTree(fixture);

    // When
    const result = whenPipedThrough(fixture, "head -1", "tree", "--dir", fixture.directory);

    // Then
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("given check finds problems when the reader closes early then exit one still survives", () => {
    // Given
    // `status: bogus` trips two rules per file, so the report clears the pipe buffer.
    const fixture = new Fixture();
    for (let index = 1; index <= 900; index += 1) {
      fixture.givenRawFile(`wp-m${index}.md`, "---\nstatus: bogus\n---\n");
    }
    expect(fixture.runCli("check", "--dir", fixture.directory).stdout.length)
      .toBeGreaterThan(64 * 1024);

    // When
    const result = whenPipedThrough(fixture, "head -1", "check", "--dir", fixture.directory);

    // Then
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
  });
});
