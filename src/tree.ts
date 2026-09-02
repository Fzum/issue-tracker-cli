/**
 * Everything that turns a graph into `wp tree` output: the glyph vocabulary, the
 * spine and branch connectors, the rollup counts, terminal-cell column alignment,
 * and the `--json` rows.
 *
 * Returns strings; it never writes to stdout and never probes the terminal. The
 * caller decides whether colour is wanted and passes it in.
 */

import { parentId, stemSegments } from "./ids.ts";
import { type Wp } from "./model.ts";
import { type WpGraph } from "./graph.ts";
import { type JsonObject, jsonText } from "./json.ts";

const STATUS_GLYPHS = new Map([
  ["done", "✔"],
  ["doing", "▶"],
  ["todo", "○"],
]);
const STATUS_COLOURS = new Map([
  ["done", "\x1B[32m"],
  ["doing", "\x1B[33m"],
  ["todo", "\x1B[90m"],
]);
const INVALID_GLYPH = "?";
const INVALID_COLOUR = "\x1B[31m";
const COLOUR_RESET = "\x1B[0m";

interface TreeLine {
  readonly id: string;
  readonly status: string | null;
  readonly label: string;
  readonly count: string;
  readonly isRoot: boolean;
}

function treeRows(graph: WpGraph): JsonObject[] {
  return graph.orderedIds.map((id) => {
    const wp = graph.byId.get(id) as Wp;
    return {
      id,
      status: graph.resolvedStatus(id),
      short_description: wp.shortDescription,
      depth: stemSegments(id).length,
    };
  });
}

/**
 * The full parent chain, INCLUDING ids with no file. `WpGraph.ancestors` filters
 * those out; the spine glyphs need the unfiltered depth, so the two must stay
 * separate — collapsing them changes indentation exactly when a parent file is
 * missing, which is the case `wp check` reports.
 */
function ancestorChain(id: string): string[] {
  const chain: string[] = [];
  let candidate = parentId(id);
  while (candidate !== null) {
    chain.push(candidate);
    candidate = parentId(candidate);
  }
  return chain;
}

function treeLines(graph: WpGraph): TreeLine[] {
  const lastByParent = new Map<string | null, string>();
  for (const id of graph.orderedIds) lastByParent.set(parentId(id), id);
  const isLastChild = (id: string): boolean => lastByParent.get(parentId(id)) === id;

  return graph.orderedIds.map((id): TreeLine => {
    const wp = graph.byId.get(id) as Wp;
    const chain = ancestorChain(id);
    const spine = chain
      .slice(0, -1)
      .reverse()
      .map((ancestorId) => (isLastChild(ancestorId) ? "   " : "│  "))
      .join("");
    const branch = chain.length === 0 ? "" : isLastChild(id) ? "└─ " : "├─ ";
    const children = graph.children.get(id) ?? [];
    const done = children.filter(
      (childId) => graph.resolvedStatus(childId) === "done",
    ).length;
    return {
      id,
      status: graph.resolvedStatus(id),
      label: `${spine}${branch}${wp.shortDescription}`,
      count: children.length === 0 ? "" : `${done}/${children.length}`,
      isRoot: chain.length === 0,
    };
  });
}

function statusGlyph(status: string | null, colour: boolean): string {
  const glyph = (status === null ? undefined : STATUS_GLYPHS.get(status)) ?? INVALID_GLYPH;
  if (!colour) return glyph;
  const code =
    (status === null ? undefined : STATUS_COLOURS.get(status)) ?? INVALID_COLOUR;
  return `${code}${glyph}${COLOUR_RESET}`;
}

/**
 * Terminal cells occupied by a string. `String.length` counts UTF-16 units, so it
 * misaligns columns for CJK and emoji descriptions; `Bun.stringWidth` counts cells.
 * (Requires Bun >= 1.0.29 — see `engines` in package.json.)
 */
function displayWidth(value: string): number {
  return Bun.stringWidth(value);
}

function padDisplayEnd(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

function padDisplayStart(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(value))) + value;
}

export function formatTreeJson(graph: WpGraph): string {
  return `${jsonText(treeRows(graph))}\n`;
}

export function formatTree(graph: WpGraph, colour: boolean): string {
  const lines = treeLines(graph);
  const labelWidth = lines.reduce(
    (width, line) => Math.max(width, displayWidth(line.label)),
    0,
  );
  const countWidth = lines.reduce(
    (width, line) => Math.max(width, displayWidth(line.count)),
    0,
  );

  let out = "";
  lines.forEach((line, index) => {
    if (line.isRoot && index > 0) out += "\n";
    const counts = countWidth === 0 ? "" : `  ${padDisplayStart(line.count, countWidth)}`;
    const row = `${statusGlyph(line.status, colour)}  ${padDisplayEnd(line.label, labelWidth)}${counts}  ${line.id}`;
    out += `${row.trimEnd()}\n`;
  });
  return out;
}
