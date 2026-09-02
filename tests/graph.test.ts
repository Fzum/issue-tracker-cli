/**
 * Invariants 3, 4 and 5: every derivation. Parent, children, type, inverted `blocks`,
 * dependency cycles, container rollup and readiness — nothing here is stored.
 *
 * The graphs come from `loadGraph`, so these read real files; `graphFromScan` is the
 * pure seam underneath and needs no separate fixture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isWithin, parentId, UnknownWpError, type WpGraph } from "../wp.ts";
import { cleanupFixtures, Fixture } from "./helpers.ts";

afterEach(cleanupFixtures);

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

describe("scope", () => {
  test("given m1 and m10 when membership is tested then segments decide, not string prefixes", () => {
    // Given a milestone whose id is a string prefix of another milestone's

    // When
    // Then
    expect(isWithin("wp-m1", "wp-m1")).toBe(true);
    expect(isWithin("wp-m1e2u3", "wp-m1")).toBe(true);
    expect(isWithin("wp-m10e1", "wp-m1")).toBe(false);
    expect(isWithin("wp-m1", "wp-m1e2")).toBe(false);
  });

  test("given a hierarchy when a subtree is taken then the root and its descendants come back in order", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e2", { status: null, description: "Epic" });
    fixture.givenWp("wp-m1e2u1", { description: "First story" });
    fixture.givenWp("wp-m1e2u10", { description: "Tenth story" });
    fixture.givenWp("wp-m1e2u2", { description: "Second story" });
    fixture.givenWp("wp-m10", { description: "Tenth milestone" });

    // When
    const graph = fixture.givenGraph();

    // Then
    expect(graph.subtree("wp-m1e2")).toEqual([
      "wp-m1e2",
      "wp-m1e2u1",
      "wp-m1e2u2",
      "wp-m1e2u10",
    ]);
    expect(graph.subtree("wp-m1e2u2")).toEqual(["wp-m1e2u2"]);
    expect(graph.subtree("wp-m1")).not.toContain("wp-m10");
  });

  test("given an id with no file when a subtree is taken then it is refused", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { description: "Milestone" });

    // When
    const graph = fixture.givenGraph();

    // Then
    expect(() => graph.subtree("wp-m9")).toThrow(UnknownWpError);
    expect(() => graph.subtree("not-a-stem")).toThrow(UnknownWpError);
  });

  test("given a scope when the ready queue is built then only that subtree is offered", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { description: "In scope" });
    fixture.givenWp("wp-m1e2", { description: "Also in scope" });
    fixture.givenWp("wp-m2", { description: "Out of scope" });

    // When
    const readyIds = fixture
      .givenGraph()
      .readyQueue("wp-m1")
      .map((wp) => wp.id);

    // Then
    expect(readyIds).toEqual(["wp-m1e1", "wp-m1e2"]);
  });

  test("given a leaf blocked from outside when a scope is applied then it is still not ready", () => {
    // Given readiness is filtered by the scope, never relaxed by it
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { description: "Blocked", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { description: "The blocker" });

    // When
    const ready = fixture.givenGraph().readyQueue("wp-m1");

    // Then
    expect(ready).toEqual([]);
  });
});
