/**
 * §9 of `docs/board.md`: every rule of §3–§5 against literal rows, then the two
 * routes and §7 against a real spawned server, then the two argv paths that never
 * reach it.
 *
 * Its own fixture rather than `tests/helpers.ts`, like `tests/orchestrate.test.ts`
 * and `tests/install.test.ts`: one of those needs a git repository and the other a
 * target project, and this one needs a temp `wps/` plus a board listening on a port
 * of its own. `afterEach` is registered *here* for the reason recorded in
 * `tests/helpers.ts` — Bun evaluates a helper module once per process, so a hook
 * registered there attaches only to whichever file imported it first and every
 * other file silently leaks its temp directories.
 *
 * The browser half is not tested at all, deliberately (§9). That is only honest
 * because every rule about what a row *means* lives in `boardState`, which is why
 * the bulk of this file is one pure function called on literal arrays.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BoardError,
  boardState,
  parseTreeRows,
  type BoardRow,
  type BoardState,
  type TreeRow,
} from "../board.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const BOARD_PATH = join(PROJECT_ROOT, "board.ts");
const HOSTNAME = "127.0.0.1";
/** Generous: a cold `bun` start on a loaded machine is the slow case here. */
const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 25;

const temporaryDirectories: string[] = [];
/** Every board this file spawned, as the one call that stops it again. */
const stopBoards: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stopBoards.splice(0)) await stop();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── The rows, and reading the payload back ───────────────────────────────────

interface RowOptions {
  readonly parent?: string | null;
  readonly depth?: number;
  readonly status?: string | null;
  readonly description?: string;
  readonly blockers?: readonly string[];
}

/** One row of `wp tree --json`, with everything a given test is not about defaulted. */
function givenRow(id: string, options: RowOptions = {}): TreeRow {
  const {
    parent = null,
    depth = 1,
    status = "todo",
    description = "",
    blockers = [],
  } = options;
  return {
    id,
    parent,
    depth,
    status,
    short_description: description,
    unmet_blockers: blockers,
  };
}

function rowOf(board: BoardState, id: string): BoardRow {
  const found = board.rows.find((row) => row.id === id);
  // Naming the id matters: a vanished row is exactly the failure rule 6 exists to
  // prevent, and `undefined.state` would report it as a bug in the test instead.
  if (found === undefined) throw new Error(`no row for ${id}`);
  return found;
}

/** One bar, as `done / total` — the pair every count assertion below reads. */
function countsOf(board: BoardState, id: string): [number, number] {
  const row = rowOf(board, id);
  return [row.leaves_done, row.leaves_total];
}

// ── §3: containers, leaves, and a parent with no row ─────────────────────────

describe("containers and leaves", () => {
  test("given a milestone whose id is a prefix of another's when the board state is built then only an id some row names as its parent is a container", () => {
    // Given wp-m1 has no children at all, and `"wp-m10e1".startsWith("wp-m1")` is true
    const rows = [
      givenRow("wp-m1", { status: "todo", description: "Checkout milestone" }),
      givenRow("wp-m10", { status: null, description: "Fulfilment milestone" }),
      givenRow("wp-m10e1", { parent: "wp-m10", depth: 2, status: "done" }),
    ];

    // When
    const board = boardState(rows);

    // Then a prefix match would make wp-m1 a container and hand it a foreign
    // milestone's progress bar
    expect(rowOf(board, "wp-m1").state).toBe("ready");
    expect(countsOf(board, "wp-m1")).toEqual([0, 0]);
    expect(rowOf(board, "wp-m10").state).toBe("container");
    expect(countsOf(board, "wp-m10")).toEqual([1, 1]);
    expect(rowOf(board, "wp-m10e1").state).toBe("done");
  });

  test("given a row whose parent has no row of its own when the board state is built then it becomes a root and is not dropped", () => {
    // Given the missing-parent-file case `wp check` reports and `wp tree` still renders
    const rows = [
      givenRow("wp-m2e1u1", { parent: "wp-m2e1", depth: 3, description: "Reserve stock" }),
    ];

    // When
    const board = boardState(rows);

    // Then it nests as a root, because the client knows nothing about hierarchy but
    // `parent === null` — and a dropped row is a work package that silently vanished
    expect(board.rows).toHaveLength(1);
    expect(rowOf(board, "wp-m2e1u1").parent).toBeNull();
    // The phantom parent is nobody's container either, so this row still carries work
    expect(rowOf(board, "wp-m2e1u1").state).toBe("ready");
    expect(board.summary.total).toBe(1);
  });

  test("given rows out of pre-order when the board state is built then the order is passed through and the hierarchy still holds", () => {
    // Given a child ahead of its parent, which a depth stack over the row order
    // would reparent with no error at all
    const rows = [
      givenRow("wp-m1e1", { parent: "wp-m1", depth: 2, status: "done" }),
      givenRow("wp-m1", { status: null, description: "Checkout milestone" }),
    ];

    // When
    const board = boardState(rows);

    // Then the order is the input's: ordering is `wp tree`'s job (compareWpIds), and
    // re-sorting here would need the stem grammar this file must not know
    expect(board.rows.map((row) => row.id)).toEqual(["wp-m1e1", "wp-m1"]);
    expect(rowOf(board, "wp-m1").state).toBe("container");
    expect(countsOf(board, "wp-m1")).toEqual([1, 1]);
  });
});

// ── §4: the five states ──────────────────────────────────────────────────────

describe("the five states", () => {
  test("given one leaf per stored status when the board state is built then done, doing, ready and blocked each come from their own condition", () => {
    // Given
    const rows = [
      givenRow("wp-m1", { status: null, description: "Checkout milestone" }),
      givenRow("wp-m1e1", { parent: "wp-m1", depth: 2, status: "done" }),
      givenRow("wp-m1e2", { parent: "wp-m1", depth: 2, status: "doing" }),
      givenRow("wp-m1e3", { parent: "wp-m1", depth: 2, status: "todo" }),
      givenRow("wp-m1e4", {
        parent: "wp-m1",
        depth: 2,
        status: "todo",
        blockers: ["wp-m1e3"],
      }),
    ];

    // When
    const board = boardState(rows);

    // Then `ready` is the one state with no CLI equivalent, and the only thing
    // separating it from `blocked` is whether anything is left in the way
    expect(board.rows.map((row) => row.state)).toEqual([
      "container",
      "done",
      "doing",
      "ready",
      "blocked",
    ]);
  });

  test("given a doing leaf and a done leaf that both carry an unmet blocker when the board state is built then neither reports blocked", () => {
    // Given
    const rows = [
      givenRow("wp-m1e1", { status: "doing", blockers: ["wp-m1e3"] }),
      givenRow("wp-m1e2", { status: "done", blockers: ["wp-m1e3"] }),
      givenRow("wp-m1e3", { status: "todo" }),
    ];

    // When
    const board = boardState(rows);

    // Then the precedence inherited from `statusGlyph` in src/tree.ts holds: work
    // already under way is reported as it stands, and only a work package that has
    // not started reads as unstartable
    expect(rowOf(board, "wp-m1e1").state).toBe("doing");
    expect(rowOf(board, "wp-m1e2").state).toBe("done");
    // The blockers still travel: the detail strip lists them either way (§8.1)
    expect(rowOf(board, "wp-m1e1").unmet_blockers).toEqual(["wp-m1e3"]);
  });

  test("given a container that carries unmet blockers of its own when the board state is built then it stays a container and keeps its counts", () => {
    // Given
    const rows = [
      givenRow("wp-m2", {
        status: "todo",
        description: "Fulfilment milestone",
        blockers: ["wp-m1"],
      }),
      givenRow("wp-m2e1", { parent: "wp-m2", depth: 2, status: "done" }),
      givenRow("wp-m2e2", { parent: "wp-m2", depth: 2, status: "todo", blockers: ["wp-m1"] }),
    ];

    // When
    const board = boardState(rows);

    // Then it shows the blockers beside the bar rather than taking the `blocked`
    // state, because the bar is the more useful thing in that row (§4)
    expect(rowOf(board, "wp-m2").state).toBe("container");
    expect(rowOf(board, "wp-m2").unmet_blockers).toEqual(["wp-m1"]);
    expect(countsOf(board, "wp-m2")).toEqual([1, 2]);
    expect(rowOf(board, "wp-m2e2").state).toBe("blocked");
  });

  test("given a childless row with no status and one with a status nobody recognizes when the board state is built then both are invalid", () => {
    // Given
    const rows = [
      givenRow("wp-m1e1", { status: null }),
      givenRow("wp-m1e2", { status: "in-progress" }),
    ];

    // When
    const board = boardState(rows);

    // Then both are problems `wp check` reports, and the board's job is to show them
    // rather than guess which of the five states was meant
    expect(board.rows.map((row) => row.state)).toEqual(["invalid", "invalid"]);
  });
});

// ── §5: deep leaf counts ─────────────────────────────────────────────────────

describe("deep leaf counts", () => {
  test("given a milestone of three epics with two stories done when the board state is built then it counts leaves at any depth, not direct children", () => {
    // Given the §5 example: `wp tree` prints 0/3 here, because no whole epic landed
    const rows: TreeRow[] = [
      givenRow("wp-m2", { status: null, description: "Fulfilment milestone" }),
    ];
    for (const epic of [1, 2, 3]) {
      rows.push(givenRow(`wp-m2e${epic}`, { parent: "wp-m2", depth: 2, status: null }));
      for (const story of [1, 2, 3]) {
        rows.push(
          givenRow(`wp-m2e${epic}u${story}`, {
            parent: `wp-m2e${epic}`,
            depth: 3,
            status: epic <= 2 && story === 1 ? "done" : "todo",
          }),
        );
      }
    }

    // When
    const board = boardState(rows);

    // Then 2/9. The divergence from `wp tree`'s 0/3 is deliberate (§5) and §12
    // predicts it will be reported as a bug: a bar is read as "how far along is
    // this", so do not "fix" this into agreement with the tree.
    expect(countsOf(board, "wp-m2")).toEqual([2, 9]);
    expect(countsOf(board, "wp-m2")).not.toEqual([0, 3]);
    expect(countsOf(board, "wp-m2e1")).toEqual([1, 3]);
    expect(countsOf(board, "wp-m2e3")).toEqual([0, 3]);
  });

  test("given a leaf row when the board state is built then it reports no counts of its own", () => {
    // Given
    const rows = [
      givenRow("wp-m1", { status: null }),
      givenRow("wp-m1e1", { parent: "wp-m1", depth: 2, status: "done" }),
    ];

    // When
    const board = boardState(rows);

    // Then a leaf has no bar to fill; the container above it is where its work shows
    expect(countsOf(board, "wp-m1e1")).toEqual([0, 0]);
    expect(countsOf(board, "wp-m1")).toEqual([1, 1]);
  });

  test("given a container with a done, a doing and a todo leaf when the board state is built then only the done leaf fills the bar", () => {
    // Given
    const rows = [
      givenRow("wp-m1", { status: null }),
      givenRow("wp-m1e1", { parent: "wp-m1", depth: 2, status: "done" }),
      givenRow("wp-m1e2", { parent: "wp-m1", depth: 2, status: "doing" }),
      givenRow("wp-m1e3", { parent: "wp-m1", depth: 2, status: "todo" }),
    ];

    // When
    const board = boardState(rows);

    // Then `doing` fills neither half: the bar is `done / total`, and the summary's
    // state counts carry the rest (§5)
    expect(countsOf(board, "wp-m1")).toEqual([1, 3]);
  });
});

// ── §5: the summary header ───────────────────────────────────────────────────

describe("the summary", () => {
  test("given leaves in every state plus an invalid one when the board state is built then total counts leaves and the four states sum to less", () => {
    // Given
    const rows = [
      givenRow("wp-m1", { status: null, description: "Checkout milestone" }),
      givenRow("wp-m1e1", { parent: "wp-m1", depth: 2, status: "done" }),
      givenRow("wp-m1e2", { parent: "wp-m1", depth: 2, status: "done" }),
      givenRow("wp-m1e3", { parent: "wp-m1", depth: 2, status: "doing" }),
      givenRow("wp-m1e4", { parent: "wp-m1", depth: 2, status: "todo" }),
      givenRow("wp-m1e5", { parent: "wp-m1", depth: 2, status: "todo", blockers: ["wp-m1e4"] }),
      givenRow("wp-m1e6", { parent: "wp-m1", depth: 2, status: null }),
    ];

    // When
    const board = boardState(rows);

    // Then the header reads `done / total leaves`, so the container counts nowhere:
    // leaves are the only rows that carry work
    expect(board.summary).toEqual({ done: 2, doing: 1, ready: 1, blocked: 1, total: 6 });
    // And the invalid leaf is in `total` alone, which is why the four can sum to less
    const { done, doing, ready, blocked, total } = board.summary;
    expect(done + doing + ready + blocked).toBeLessThan(total);
    expect(board.ok).toBe(true);
  });

  test("given an empty tree when the board state is built then it is an empty success", () => {
    // Given / When — a fresh `wps/`, which is what install.sh leaves behind
    const board = boardState([]);

    // Then
    expect(board.ok).toBe(true);
    expect(board.rows).toEqual([]);
    expect(board.summary).toEqual({ done: 0, doing: 0, ready: 0, blocked: 0, total: 0 });
  });
});

// ── §6: the hash the client renders against ──────────────────────────────────

describe("the hash", () => {
  test("given the same tree twice when the board state is built then the hash matches, and a changed status changes it", () => {
    // Given three trees, two of them identical
    const treeOf = (status: string): TreeRow[] => [
      givenRow("wp-m1", { status: null, description: "Checkout milestone" }),
      givenRow("wp-m1e1", { parent: "wp-m1", depth: 2, status }),
    ];

    // When
    const before = boardState(treeOf("todo"));
    const again = boardState(treeOf("todo"));
    const after = boardState(treeOf("doing"));

    // Then the property, never a literal digest: a digest would pin `Bun.hash`'s
    // implementation, which is not the contract. The contract is that an unchanged
    // tree lets the client skip a re-render and keep the scroll it is mid-way down.
    expect(again.hash).toBe(before.hash);
    expect(after.hash).not.toBe(before.hash);
    expect(before.hash).toMatch(/^[0-9a-f]+$/);
  });

  test("given a change no state reflects when the board state is built then the hash still changes", () => {
    // Given three trees whose every `state` and whose whole `summary` are identical:
    // one differs only in a description, one only in an already-blocked leaf's
    // second blocker. `hash` is the client's *sole* re-render trigger, so anything
    // on the wire it does not cover is a field that silently goes stale on screen
    // for as long as the tab stays open.
    const treeOf = (description: string, blockers: readonly string[]): TreeRow[] => [
      givenRow("wp-m1", { status: null, description: "Checkout milestone" }),
      givenRow("wp-m1e1", { parent: "wp-m1", depth: 2, description, blockers }),
    ];
    const before = boardState(treeOf("Add an item", ["wp-m9"]));
    const renamed = boardState(treeOf("Add an item to the cart", ["wp-m9"]));
    const reblocked = boardState(treeOf("Add an item", ["wp-m9", "wp-m8"]));

    // When — the states and the summary, which a hash over either alone would cover
    const statesOf = (board: BoardState): string[] => board.rows.map((row) => row.state);

    // Then the states and summary really are unchanged, and the hash moved anyway
    expect(statesOf(renamed)).toEqual(statesOf(before));
    expect(statesOf(reblocked)).toEqual(statesOf(before));
    expect(renamed.summary).toEqual(before.summary);
    expect(reblocked.summary).toEqual(before.summary);
    expect(renamed.hash).not.toBe(before.hash);
    expect(reblocked.hash).not.toBe(before.hash);
  });
});

// ── The tolerant parser between the CLI's JSON and the rules ─────────────────

describe("reading the tree's json", () => {
  test("given a row with fields missing when the tree json is parsed then each one falls back rather than failing", () => {
    // Given — an older `wp` has no `parent` key at all, and a tree that is odd but
    // readable is more use on screen than an error
    const json = '[{ "id": "wp-m1e1" }]';

    // When
    const rows = parseTreeRows(json);

    // Then
    expect(rows).toEqual([
      {
        id: "wp-m1e1",
        parent: null,
        depth: 0,
        status: null,
        short_description: "",
        unmet_blockers: [],
      },
    ]);
  });

  test("given output that is not a tree when it is parsed then it is refused", () => {
    // Given / When / Then — a row with no id is the one thing worth refusing
    expect(parseTreeRows("  ")).toEqual([]);
    expect(() => parseTreeRows("not json")).toThrow(BoardError);
    expect(() => parseTreeRows("{}")).toThrow(BoardError);
    expect(() => parseTreeRows('[{ "status": "todo" }]')).toThrow(BoardError);
  });
});

// ── The server: the two routes, §7, and the argv that never reaches them ─────

/** The wire, as the client sees it: §6's payload plus `project`, or §7's failure. */
type BoardPayload =
  | (BoardState & { readonly project: string })
  | { readonly ok: false; readonly error: string; readonly project: string };

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A port nothing is listening on: ask the operating system for one and let it go
 * again. A fixed port would collide with a second `bun test` on the same machine —
 * and with the board a developer left running on 4400.
 */
function freePort(): number {
  const probe = Bun.serve({ hostname: HOSTNAME, port: 0, fetch: () => new Response("") });
  const { port } = probe;
  probe.stop(true);
  // `@types/bun` is pinned to `latest`, where `port` is optional because a server
  // bound to a unix socket has none. Checked rather than asserted: `noUncheckedIndexedAccess`
  // and `strict` are on, and CLAUDE.md forbids a non-null assertion here.
  if (port === undefined) throw new Error("Bun.serve did not report a port to borrow");
  return port;
}

/** A throwaway project holding a `wps/` directory, and a board serving it. */
class BoardFixture {
  readonly root: string;
  readonly directory: string;
  readonly port: number;
  readonly url: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "board-test-"));
    temporaryDirectories.push(this.root);
    this.directory = join(this.root, "wps");
    mkdirSync(this.directory);
    this.port = freePort();
    this.url = `http://${HOSTNAME}:${this.port}`;
  }

  /** A WP with children carries no status of its own (invariant 4). */
  givenContainer(id: string, description: string): void {
    this.givenRawFile(
      `${id}.md`,
      ["---", `short_description: "${description}"`, "---", "", "Ticket body.", ""].join("\n"),
    );
  }

  givenWp(
    id: string,
    description: string,
    status = "todo",
    blockedBy: readonly string[] = [],
  ): void {
    const lines = ["---", `status: ${status}`];
    if (blockedBy.length > 0) lines.push(`blocked_by: [${blockedBy.join(", ")}]`);
    lines.push(`short_description: "${description}"`, "---", "", "Ticket body.", "");
    this.givenRawFile(`${id}.md`, lines.join("\n"));
  }

  givenRawFile(filename: string, content: string): void {
    writeFileSync(join(this.directory, filename), content, "utf8");
  }

  /** A second work-package directory somewhere other than `./wps`, for `--dir`. */
  givenDirectory(name: string, files: Readonly<Record<string, string>>): string {
    const directory = join(this.root, name);
    mkdirSync(directory, { recursive: true });
    for (const [id, description] of Object.entries(files)) {
      const lines = ["---", "status: todo", `short_description: "${description}"`, "---", ""];
      writeFileSync(join(directory, `${id}.md`), lines.join("\n"), "utf8");
    }
    return directory;
  }

  /**
   * The board, spawned as a user runs it. `directoryArgument` is `--dir`; left null
   * the temp `wps/` is found through the child's own working directory instead.
   *
   * stdout is ignored so a passing run stays quiet; stderr is inherited, because the
   * board's own message is the whole diagnostic when the poll below times out.
   */
  async whenServing(directoryArgument: string | null = null): Promise<void> {
    const board = Bun.spawn({
      cmd: [
        process.execPath,
        BOARD_PATH,
        "--port",
        String(this.port),
        ...(directoryArgument === null ? [] : ["--dir", directoryArgument]),
      ],
      cwd: this.root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    stopBoards.push(async () => {
      board.kill();
      // Waited for, not fired and forgotten: a board still spawning `wp` against a
      // directory `afterEach` has already deleted is a subprocess leaked into
      // whichever test file runs next.
      await board.exited;
    });

    // Polled, never slept on for a fixed time: `bun` cold-starts in anything from
    // 20ms to most of a second on a loaded machine, and a fixed wait is exactly how
    // this kind of test goes flaky.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (board.exitCode !== null) {
        throw new Error(`the board exited ${board.exitCode} instead of serving ${this.url}`);
      }
      try {
        // Any answer at all means it is listening. What the routes reply with is
        // what the tests below are for.
        const response = await fetch(`${this.url}/api/state`);
        await response.text();
        return;
      } catch {
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    }
    throw new Error(`the board never answered on ${this.url}`);
  }

  whenFetched(path: string): Promise<Response> {
    return fetch(`${this.url}${path}`);
  }

  /** Synchronous, for the two argv paths that never reach `Bun.serve`. */
  runBoard(...arguments_: string[]): CliResult {
    const result = Bun.spawnSync({
      cmd: [process.execPath, BOARD_PATH, ...arguments_],
      cwd: this.root,
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

describe("the routes", () => {
  test("given a board that is serving when the client is requested then the page itself comes back", async () => {
    // Given
    const fixture = new BoardFixture();
    fixture.givenWp("wp-m1e1", "Add an item to the cart");
    await fixture.whenServing();

    // When
    const response = await fixture.whenFetched("/");

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<title>wp board</title>");
    // The one route the page is allowed to call, and the reason it needs no other
    expect(body).toContain("/api/state");
  });

  test("given a container and three leaves when the state is requested then the whole documented payload comes back", async () => {
    // Given
    const fixture = new BoardFixture();
    fixture.givenContainer("wp-m1", "Checkout milestone");
    fixture.givenWp("wp-m1e1", "Add an item to the cart", "done");
    fixture.givenWp("wp-m1e2", "Remove an item from the cart", "todo");
    fixture.givenWp("wp-m2", "Reserve stock", "todo", ["wp-m1e2"]);
    await fixture.whenServing();

    // When
    const response = await fixture.whenFetched("/api/state");

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    // Without this a poll every second is answered from the browser's own cache and
    // a live board looks frozen.
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const payload = (await response.json()) as BoardPayload;
    expect(Object.keys(payload).sort()).toEqual(["hash", "ok", "project", "rows", "summary"]);
    if (!payload.ok) throw new Error(`the tree could not be read: ${payload.error}`);
    // The one field the route adds, and a constant rather than a clock, so it does
    // not defeat `hash`.
    expect(payload.project).toBe(basename(fixture.root));
    expect(Object.keys(payload.rows[0] ?? {}).sort()).toEqual([
      "depth",
      "id",
      "leaves_done",
      "leaves_total",
      "parent",
      "short_description",
      "state",
      "unmet_blockers",
    ]);
    // wp-m1 is a container because a row names it as its parent — the field §3 added
    // to the CLI — and not because of the `doing` its children roll up to.
    expect(payload.rows.map((row) => [row.id, row.state, row.parent])).toEqual([
      ["wp-m1", "container", null],
      ["wp-m1e1", "done", "wp-m1"],
      ["wp-m1e2", "ready", "wp-m1"],
      ["wp-m2", "blocked", null],
    ]);
    expect(countsOf(payload, "wp-m1")).toEqual([1, 2]);
    expect(rowOf(payload, "wp-m2").unmet_blockers).toEqual(["wp-m1e2"]);
    expect(payload.summary).toEqual({ done: 1, doing: 0, ready: 1, blocked: 1, total: 3 });
  });

  test("given --dir at a path of its own when the state is requested then that directory is what is served", async () => {
    // Given two queues in one project: the default `./wps`, and another elsewhere.
    // `install.sh` puts `wp-board` on `$PATH` for every project, so `--dir` is the
    // documented way to point it at anything but the current directory — and a
    // `--dir` that is quietly ignored serves the wrong queue with no error at all.
    const fixture = new BoardFixture();
    fixture.givenWp("wp-m1e1", "The default directory");
    const elsewhere = fixture.givenDirectory("other-wps", {
      "wp-m9": "The directory --dir named",
    });
    await fixture.whenServing(elsewhere);

    // When
    const response = await fixture.whenFetched("/api/state");

    // Then
    const payload = (await response.json()) as BoardPayload;
    if (!payload.ok) throw new Error(`the tree could not be read: ${payload.error}`);
    expect(payload.rows.map((row) => row.id)).toEqual(["wp-m9"]);
    expect(rowOf(payload, "wp-m9").short_description).toBe("The directory --dir named");
  });

  test("given --dir with an empty value when the board runs then it is a usage error", () => {
    // Given — `--port=` is already refused, and `--dir=` resolving to the working
    // directory would bind and then blame whatever unrelated file it found there
    const fixture = new BoardFixture();

    // When
    const result = fixture.runBoard("--dir=");

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("board: argument --dir: expected one value");
  });

  test("given a board that is serving when an unknown path is requested then it is a 404", async () => {
    // Given
    const fixture = new BoardFixture();
    await fixture.whenServing();

    // When
    const response = await fixture.whenFetched("/favicon.ico");

    // Then two routes, and no more
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no route /favicon.ico");
  });

  test("given one unparseable file in the directory when the state is requested then the failure is a payload, not a status", async () => {
    // Given a file with no frontmatter: `loadGraph` refuses the whole directory,
    // which is also what an agent's half-written file looks like from here
    const fixture = new BoardFixture();
    fixture.givenWp("wp-m1e1", "Add an item to the cart");
    fixture.givenRawFile("notes.md", "no frontmatter here\n");
    await fixture.whenServing();

    // When
    const response = await fixture.whenFetched("/api/state");

    // Then 200 deliberately (§7): a 4xx would make the browser's own machinery
    // report it and the board itself look broken, where the client has to read this
    // message, keep the last good tree underneath it, and clear it on the next poll
    expect(response.status).toBe(200);
    const payload = (await response.json()) as BoardPayload;
    if (payload.ok) throw new Error("the broken directory was read as a tree");
    expect(payload.error).toContain("notes.md");
    expect(payload.project).toBe(basename(fixture.root));
  });
});

describe("the command line", () => {
  test("given --help when the board is run then the usage is printed", () => {
    // Given
    const fixture = new BoardFixture();

    // When
    const result = fixture.runBoard("--help");

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: wp-board");
  });

  test("given a port that is not a port when the board is run then it is a usage error and nothing is served", () => {
    // Given
    const fixture = new BoardFixture();

    // When
    const result = fixture.runBoard("--port", "not-a-port");

    // Then a refusal before the first request, so no `serving` line was ever printed
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("board: argument --port: expected 1..65535, not not-a-port");
    expect(result.stdout).toBe("");
  });
});
