/**
 * Invariant 7: the frontmatter parser is a YAML subset on purpose.
 *
 * These go through `store.parseWp` rather than `parseFrontmatter` directly, because
 * `parseWp` is the only path a real file takes into the parser — it owns the `---`
 * delimiters, the body split and the `blocked_by ??= []` default, and a subset
 * violation has to surface from there to fail `wp check`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FrontmatterError, FrontmatterParseError, parseWp } from "../wp.ts";
import { cleanupFixtures, Fixture } from "./helpers.ts";

afterEach(cleanupFixtures);

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
