/**
 * Plain-text and JSON rendering for every command except `tree` — `wp tree` is
 * carved out into src/tree.ts because its glyphs and column alignment are a concern
 * of their own.
 *
 * Every function here RETURNS a string and never writes to stdout, so output is
 * testable without spawning a subprocess; src/cli.ts does the writing.
 *
 * Invariant 3: `type`, `is_leaf`, `parent`, `children`, `blocks`, `ready` and
 * `rolled_up_status` are derived here for the wire; they are never stored.
 */

import { compareText, parentId } from "./ids.ts";
import { Problem, UnknownWpError, type Wp } from "./model.ts";
import { type WpGraph } from "./graph.ts";
import { type JsonObject, type JsonValue, jsonText } from "./json.ts";

/** The `wp show --json` payload. Key set and names are a contract for agent consumers. */
function wpJson(graph: WpGraph, wp: Wp): JsonObject {
  const result: JsonObject = {
    id: wp.id,
    ...wp.fields,
    type: graph.typeName(wp.id),
    is_leaf: graph.isLeaf(wp.id),
    parent: parentId(wp.id),
    children: [...(graph.children.get(wp.id) ?? [])],
    blocks: [...(graph.blocks.get(wp.id) ?? [])],
    ready: graph.isReady(wp.id),
    body: wp.body,
  };
  if (!graph.isLeaf(wp.id)) result.rolled_up_status = graph.resolvedStatus(wp.id);
  return result;
}

/** The `wp next` / `wp start` / `wp done --json` payload. */
function nextJson(wp: Wp): JsonObject {
  return {
    id: wp.id,
    status: wp.status ?? "",
    short_description: wp.shortDescription,
  };
}

function queueRow(wp: Wp): string {
  return `${wp.id}\t${wp.status ?? ""}\t${wp.shortDescription}`;
}

function displayValue(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value === null) return "";
  return String(value);
}

export function formatTransition(wp: Wp, asJson: boolean): string {
  return `${asJson ? jsonText(nextJson(wp)) : queueRow(wp)}\n`;
}

/**
 * An empty queue prints nothing at all — except for `--all --json`, which prints an
 * empty array so a consumer can always parse the output. Order matters: the guard
 * comes before the JSON branch.
 */
export function formatNext(
  graph: WpGraph,
  allReady: boolean,
  asJson: boolean,
  scope: string | null = null,
): string {
  const ready = graph.readyQueue(scope);
  const selected = allReady ? ready : ready.slice(0, 1);
  if (selected.length === 0 && !allReady) return "";

  if (asJson) {
    return `${jsonText(allReady ? selected.map(nextJson) : nextJson(selected[0] as Wp))}\n`;
  }
  return selected.map((wp) => `${queueRow(wp)}\n`).join("");
}

export function formatShow(graph: WpGraph, id: string, asJson: boolean): string {
  const wp = graph.byId.get(id);
  if (!wp) throw new UnknownWpError(`unknown work-package ID: ${id}`);
  const payload = wpJson(graph, wp);
  if (asJson) return `${jsonText(payload)}\n`;

  const displayOrder = [
    "id",
    "short_description",
    "status",
    "rolled_up_status",
    "blocked_by",
    "type",
    "is_leaf",
    "parent",
    "children",
    "blocks",
    "ready",
  ];
  const shown = new Set([...displayOrder, "body"]);

  let out = "";
  for (const key of displayOrder) {
    if (Object.hasOwn(payload, key)) {
      out += `${key}: ${displayValue(payload[key] ?? null)}\n`;
    }
  }
  for (const key of Object.keys(payload).filter((key) => !shown.has(key)).sort(compareText)) {
    out += `${key}: ${displayValue(payload[key] ?? null)}\n`;
  }
  // The body is appended verbatim after a blank line, never re-wrapped or trimmed.
  if (wp.body) {
    out += "\n";
    out += wp.body;
    if (!wp.body.endsWith("\n")) out += "\n";
  }
  return out;
}

/** Plain rows use `Problem.toString` — src/model.ts owns that row format. */
export function formatCheck(problems: readonly Problem[], asJson: boolean): string {
  if (asJson) {
    return `${jsonText(
      problems.map((problem) => ({ file: problem.file, problem: problem.message })),
    )}\n`;
  }
  return problems.map((problem) => `${problem.toString()}\n`).join("");
}
