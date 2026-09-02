/**
 * The argv grammar, the printed rows and the exit codes: `0` success (including an
 * empty queue), `1` only from `wp check` finding problems, `2` usage error / unknown ID
 * / unreadable directory.
 *
 * The JSON shapes asserted here are a stability contract for agent consumers.
 *
 * The glyph tree has its own file, and so does the large-output pipe behaviour — with one
 * exception: the rollup-after-`start` case below needs both commands in one test, so it
 * byte-pins tree output here too. A change to tree's columns fails that test as well as
 * the ones in `tree.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupFixtures, Fixture } from "./helpers.ts";

afterEach(cleanupFixtures);

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
      "▶  Milestone        0/1  wp-m1\n" +
        "▶  └─ Epic          0/2  wp-m1e1\n" +
        "▶     ├─ Story one       wp-m1e1u1\n" +
        "○     └─ Story two       wp-m1e1u2\n",
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
