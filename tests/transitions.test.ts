/**
 * The `start` / `done` guard policy, and exactly what `--force` overrides.
 *
 * An unmet `blocked_by` target is the only thing `wp start` refuses on — not the
 * current status, and not another leaf being `doing` (D9 records why that guard was
 * removed). `wp done` refuses anything that is not already `doing`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { finishWp, startWp, TransitionError, UnknownWpError } from "../wp.ts";
import { cleanupFixtures, Fixture } from "./helpers.ts";

afterEach(cleanupFixtures);

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
