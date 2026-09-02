/**
 * One test per `wp check` rule, plus the clean folder. `check` takes a scan rather than
 * a directory on purpose, so it can report on files that `loadGraph` would refuse.
 *
 * One input may legitimately trip several rules — a self edge is both a self reference
 * and a cycle — so these assert that a message is present, never that it is the only
 * one. `expectProblem` in `./helpers.ts` is that assertion.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFixtures, expectProblem, Fixture } from "./helpers.ts";

afterEach(cleanupFixtures);

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
