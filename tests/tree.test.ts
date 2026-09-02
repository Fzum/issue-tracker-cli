/**
 * The glyph tree: connectors, rollup counts, blocker lists and column alignment.
 *
 * These spawn `wp.ts` rather than calling `formatTree` directly, because the column
 * alignment and the colour decision are only meaningful on a real, non-TTY stdout.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFixtures, Fixture } from "./helpers.ts";

afterEach(cleanupFixtures);

describe("tree", () => {
  test("given a hierarchy when tree runs then a glyph tree with a done count is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: "doing", description: "Child" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      ["▶  Milestone  0/1  wp-m1", "▶  └─ Child        wp-m1e1", ""].join("\n"),
    );
  });

  test("given nested milestones when tree runs then connectors, counts and blank lines align", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Authentication milestone" });
    fixture.givenWp("wp-m1e1", { status: null, description: "Login epic" });
    fixture.givenWp("wp-m1e1u1", { status: null, description: "Password login" });
    fixture.givenWp("wp-m1e1u1t1", { status: "done", description: "Design the login form" });
    fixture.givenWp("wp-m1e1u1t2", {
      status: "done",
      description: "Implement the session cookie",
    });
    fixture.givenWp("wp-m1e1u2", { status: "todo", description: "Rate limit login attempts" });
    fixture.givenWp("wp-m1e2", { status: "todo", description: "Wire up the OAuth provider" });
    fixture.givenWp("wp-m1e3", { status: "todo", description: "Send password reset e-mails" });
    fixture.givenWp("wp-m2", { status: null, description: "Reporting milestone" });
    fixture.givenWp("wp-m2e1", { status: "todo", description: "Export time entries as CSV" });
    fixture.givenWp("wp-m2e2", { status: "todo", description: "Chart weekly totals" });
    fixture.givenWp("wp-m10", {
      status: "todo",
      description: "Tenth milestone, proves natural ordering",
    });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "▶  Authentication milestone                  0/3  wp-m1",
        "▶  ├─ Login epic                             1/2  wp-m1e1",
        "✔  │  ├─ Password login                      2/2  wp-m1e1u1",
        "✔  │  │  ├─ Design the login form                 wp-m1e1u1t1",
        "✔  │  │  └─ Implement the session cookie          wp-m1e1u1t2",
        "○  │  └─ Rate limit login attempts                wp-m1e1u2",
        "○  ├─ Wire up the OAuth provider                  wp-m1e2",
        "○  └─ Send password reset e-mails                 wp-m1e3",
        "",
        "○  Reporting milestone                       0/2  wp-m2",
        "○  ├─ Export time entries as CSV                  wp-m2e1",
        "○  └─ Chart weekly totals                         wp-m2e2",
        "",
        "○  Tenth milestone, proves natural ordering       wp-m10",
        "",
      ].join("\n"),
    );
  });

  test("given a piped stdout when tree runs then no colour escapes are emitted", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "done", description: "Only milestone" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("✔  Only milestone  wp-m1\n");
  });

  test("given an unknown status when tree runs then a question mark glyph is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: "blocked", description: "Odd status" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("?  Odd status  wp-m1\n");
  });

  test("given a double-width description when tree runs then the ids stay in one column", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "ASCII milestone" });
    fixture.givenWp("wp-m1e1", { status: "done", description: "Grüße 日本語 🚀 emoji" });
    fixture.givenWp("wp-m1e2", { status: "todo", description: "plain ascii sibling xx" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    const idColumns = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Bun.stringWidth(line.slice(0, line.lastIndexOf("wp-"))));
    expect(new Set(idColumns).size).toBe(1);
  });

  test("given any tree output when tree runs then no line has trailing whitespace", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Long milestone description here" });
    fixture.givenWp("wp-m1e1", { status: "todo", description: "Short" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    for (const line of result.stdout.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });

  test("given a leaf with an unmet blocker when tree runs then a blocked glyph and the blocker are printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Auth" });
    fixture.givenWp("wp-m1e1", { status: "done", description: "Step one" });
    fixture.givenWp("wp-m1e2", {
      status: "todo",
      description: "Step two",
      blockedBy: ["wp-m1e3"],
    });
    fixture.givenWp("wp-m1e3", { status: "todo", description: "Step six" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "▶  Auth         1/3  wp-m1",
        "✔  ├─ Step one       wp-m1e1",
        "⊘  ├─ Step two       wp-m1e2  ← wp-m1e3",
        "○  └─ Step six       wp-m1e3",
        "",
      ].join("\n"),
    );
  });

  test("given a blocked container when tree runs then its descendants repeat the inherited blocker", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Auth" });
    fixture.givenWp("wp-m1e1", {
      status: null,
      description: "Login flow",
      blockedBy: ["wp-m2e1"],
    });
    fixture.givenWp("wp-m1e1u1", {
      status: "todo",
      description: "Endpoint",
      blockedBy: ["wp-m1e1u2"],
    });
    fixture.givenWp("wp-m1e1u2", { status: "todo", description: "Cookies" });
    fixture.givenWp("wp-m2", { status: null, description: "Platform" });
    fixture.givenWp("wp-m2e1", { status: "todo", description: "Config" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "○  Auth            0/1  wp-m1",
        "⊘  └─ Login flow   0/2  wp-m1e1    ← wp-m2e1",
        "⊘     ├─ Endpoint       wp-m1e1u1  ← wp-m1e1u2, wp-m2e1",
        "⊘     └─ Cookies        wp-m1e1u2  ← wp-m2e1",
        "",
        "○  Platform        0/1  wp-m2",
        "○  └─ Config            wp-m2e1",
        "",
      ].join("\n"),
    );
  });

  test("given a blocker that is already done when tree runs then no blocker column is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Auth" });
    fixture.givenWp("wp-m1e1", { status: "done", description: "Step one" });
    fixture.givenWp("wp-m1e2", {
      status: "todo",
      description: "Step two",
      blockedBy: ["wp-m1e1"],
    });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "▶  Auth         1/2  wp-m1",
        "✔  ├─ Step one       wp-m1e1",
        "○  └─ Step two       wp-m1e2",
        "",
      ].join("\n"),
    );
  });

  test("given a blocker that does not exist when tree runs then it is still listed as unmet", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", {
      status: "todo",
      description: "Lonely",
      blockedBy: ["wp-m9"],
    });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("⊘  Lonely  wp-m1  ← wp-m9\n");
  });

  test("given blockers that are not valid stems when tree runs then they sort after the valid one", () => {
    // Given
    // `aaa` sorts before `wp-m2` lexicographically, so the valid stem can only come
    // first if grammar beats text; `aaa` before `wp-zz9` pins the tail order.
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", {
      status: "todo",
      description: "Broken",
      blockedBy: ["wp-zz9", "aaa", "wp-m2"],
    });
    fixture.givenWp("wp-m2", { status: "todo", description: "Fine" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      ["⊘  Broken  wp-m1  ← wp-m2, aaa, wp-zz9", "", "○  Fine    wp-m2", ""].join("\n"),
    );
  });

  test("given blockers that are not valid stems when tree JSON runs then they sort after the valid one", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", {
      status: "todo",
      description: "Broken",
      blockedBy: ["wp-zz9", "aaa", "wp-m2"],
    });
    fixture.givenWp("wp-m2", { status: "todo", description: "Fine" });

    // When
    const result = fixture.runCli("tree", "--json", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        depth: 1,
        id: "wp-m1",
        short_description: "Broken",
        status: "todo",
        unmet_blockers: ["wp-m2", "aaa", "wp-zz9"],
      },
      {
        depth: 1,
        id: "wp-m2",
        short_description: "Fine",
        status: "todo",
        unmet_blockers: [],
      },
    ]);
  });

  test("given a blocked leaf that is already doing when tree runs then the doing glyph is kept", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Auth" });
    fixture.givenWp("wp-m1e1", {
      status: "doing",
      description: "Step one",
      blockedBy: ["wp-m1e2"],
    });
    fixture.givenWp("wp-m1e2", { status: "todo", description: "Step two" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "▶  Auth         0/2  wp-m1",
        "▶  ├─ Step one       wp-m1e1  ← wp-m1e2",
        "○  └─ Step two       wp-m1e2",
        "",
      ].join("\n"),
    );
  });

  test("given a tree with blockers when tree runs then no line has trailing whitespace", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone with a long name" });
    fixture.givenWp("wp-m1e1", {
      status: "todo",
      description: "Short",
      blockedBy: ["wp-m1e2"],
    });
    fixture.givenWp("wp-m1e2", { status: "todo", description: "Other" });

    // When
    const result = fixture.runCli("tree", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    for (const line of result.stdout.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });

  test("given a tree with blockers when tree JSON runs then each row lists its unmet blockers", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Auth" });
    fixture.givenWp("wp-m1e1", {
      status: "todo",
      description: "Step one",
      blockedBy: ["wp-m1e2"],
    });
    fixture.givenWp("wp-m1e2", { status: "todo", description: "Step two" });

    // When
    const result = fixture.runCli("tree", "--json", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { depth: 1, id: "wp-m1", short_description: "Auth", status: "todo", unmet_blockers: [] },
      {
        depth: 2,
        id: "wp-m1e1",
        short_description: "Step one",
        status: "todo",
        unmet_blockers: ["wp-m1e2"],
      },
      {
        depth: 2,
        id: "wp-m1e2",
        short_description: "Step two",
        status: "todo",
        unmet_blockers: [],
      },
    ]);
  });

  test("given an own and an inherited blocker when tree JSON runs then the list is in compareWpIds order", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", {
      status: null,
      description: "Auth",
      blockedBy: ["wp-m2e2"],
    });
    fixture.givenWp("wp-m1e1", {
      status: "todo",
      description: "Endpoint",
      blockedBy: ["wp-m2e10"],
    });
    fixture.givenWp("wp-m2", { status: null, description: "Platform" });
    fixture.givenWp("wp-m2e2", { status: "todo", description: "Config" });
    fixture.givenWp("wp-m2e10", { status: "todo", description: "Later" });

    // When
    const result = fixture.runCli("tree", "--json", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        depth: 1,
        id: "wp-m1",
        short_description: "Auth",
        status: "todo",
        unmet_blockers: ["wp-m2e2"],
      },
      {
        // The own blocker is collected before the inherited one, so insertion order
        // would read `wp-m2e10, wp-m2e2`; `compareWpIds` puts `e2` before `e10`.
        depth: 2,
        id: "wp-m1e1",
        short_description: "Endpoint",
        status: "todo",
        unmet_blockers: ["wp-m2e2", "wp-m2e10"],
      },
      {
        depth: 1,
        id: "wp-m2",
        short_description: "Platform",
        status: "todo",
        unmet_blockers: [],
      },
      {
        depth: 2,
        id: "wp-m2e2",
        short_description: "Config",
        status: "todo",
        unmet_blockers: [],
      },
      {
        depth: 2,
        id: "wp-m2e10",
        short_description: "Later",
        status: "todo",
        unmet_blockers: [],
      },
    ]);
  });
});

describe("tree --scope", () => {
  test("given a scope when tree runs then the subtree is re-rooted", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Authentication milestone" });
    fixture.givenWp("wp-m1e1", { status: null, description: "Login epic" });
    fixture.givenWp("wp-m1e1u1", { status: "done", description: "Password login" });
    fixture.givenWp("wp-m1e1u2", { description: "Rate limit", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { description: "Reporting milestone" });

    // When
    const result = fixture.runCli("tree", "--scope", "wp-m1e1", "--dir", fixture.directory);

    // Then the epic is the root: no spine above it, and no sibling milestone
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "▶  Login epic         1/2  wp-m1e1",
        "✔  ├─ Password login       wp-m1e1u1",
        "⊘  └─ Rate limit           wp-m1e1u2  ← wp-m2",
        "",
      ].join("\n"),
    );
  });

  test("given a story scope when tree runs then only that story is printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { description: "Wanted" });
    fixture.givenWp("wp-m1e2", { description: "Not wanted" });

    // When
    const result = fixture.runCli("tree", "--scope=wp-m1e1", "--dir", fixture.directory);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("○  Wanted  wp-m1e1\n");
  });

  test("given a scope when tree JSON runs then only the subtree rows are printed", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: null, description: "Login epic" });
    fixture.givenWp("wp-m1e1u1", { status: "done", description: "Password login" });
    fixture.givenWp("wp-m1e1u2", { description: "Rate limit", blockedBy: ["wp-m2"] });
    fixture.givenWp("wp-m2", { description: "Reporting milestone" });

    // When
    const result = fixture.runCli(
      "tree",
      "--json",
      "--scope",
      "wp-m1e1",
      "--dir",
      fixture.directory,
    );

    // Then depth stays absolute — it is a property of the id, not of the scope
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        id: "wp-m1e1",
        status: "doing",
        short_description: "Login epic",
        depth: 2,
        unmet_blockers: [],
      },
      {
        id: "wp-m1e1u1",
        status: "done",
        short_description: "Password login",
        depth: 3,
        unmet_blockers: [],
      },
      {
        id: "wp-m1e1u2",
        status: "todo",
        short_description: "Rate limit",
        depth: 3,
        unmet_blockers: ["wp-m2"],
      },
    ]);
  });

  test("given a deeper scope when tree runs then the spine is relative to the new root", () => {
    // Given
    const fixture = new Fixture();
    fixture.givenWp("wp-m1", { status: null, description: "Milestone" });
    fixture.givenWp("wp-m1e1", { status: null, description: "Epic" });
    fixture.givenWp("wp-m1e1u1", { status: null, description: "Story" });
    fixture.givenWp("wp-m1e1u1t1", { status: "done", description: "First task" });
    fixture.givenWp("wp-m1e1u1t2", { description: "Second task" });

    // When
    const result = fixture.runCli("tree", "--scope", "wp-m1e1", "--dir", fixture.directory);

    // Then the story indents one level below the epic, not three below the milestone
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "▶  Epic               0/1  wp-m1e1",
        "▶  └─ Story           1/2  wp-m1e1u1",
        "✔     ├─ First task        wp-m1e1u1t1",
        "○     └─ Second task       wp-m1e1u1t2",
        "",
      ].join("\n"),
    );
  });
});
