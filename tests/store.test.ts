/**
 * Invariant 6: one writer, one line. `setStatus` only ever *replaces* an existing
 * `status:` line — it never inserts one and never re-serializes the frontmatter, so a
 * comment, an unknown key, CRLF endings and a missing final newline all survive a
 * write untouched.
 *
 * `store.ts` also owns the read path; `parseWp` is covered by `frontmatter.test.ts`
 * and `loadGraph` by `graph.test.ts` through the shared fixture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FrontmatterError, setStatus } from "../wp.ts";
import { cleanupFixtures, Fixture } from "./helpers.ts";

afterEach(cleanupFixtures);

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
