#!/usr/bin/env bun
/** Command line interface for markdown-native work packages. */

import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, parse } from "node:path";

const STEM_PATTERN = /^wp-(?:[a-z][0-9]+)+$/;
const SEGMENT_PATTERN = /[a-z][0-9]+/g;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const VALID_STATUSES = new Set(["todo", "doing", "done"]);
const TYPE_NAMES = new Map([
  [1, "milestone"],
  [2, "epic"],
  [3, "story"],
]);

type FieldValue = string | string[];
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

export class WpError extends Error {}
export class DirectoryError extends WpError {}
export class UnknownWpError extends WpError {}
export class FrontmatterError extends WpError {}
export class FrontmatterParseError extends WpError {}
export class TransitionError extends WpError {}
class UsageError extends WpError {}

export class Wp {
  constructor(
    readonly id: string,
    readonly path: string,
    readonly fields: Readonly<Record<string, FieldValue>>,
    readonly body: string,
  ) {}

  get status(): string | null {
    const value = this.fields.status;
    return typeof value === "string" && value ? value : null;
  }

  get shortDescription(): string {
    const value = this.fields.short_description;
    return typeof value === "string" ? value : "";
  }

  get blockedBy(): readonly string[] {
    const value = this.fields.blocked_by;
    return Array.isArray(value) ? value : [];
  }
}

export interface ScannedFile {
  readonly path: string;
  readonly id: string | null;
  readonly wp?: Wp;
  readonly error?: WpError;
}

export class Problem {
  constructor(
    readonly file: string,
    readonly message: string,
  ) {}

  toString(): string {
    return `${this.file}: ${this.message}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lineWithoutEnding(line: string): string {
  return line.endsWith("\n")
    ? line.slice(0, -1).replace(/\r$/, "")
    : line.replace(/\r$/, "");
}

function linesWithEndings(content: string): string[] {
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== "\n" && character !== "\r") continue;
    if (character === "\r" && content[index + 1] === "\n") index += 1;
    lines.push(content.slice(lineStart, index + 1));
    lineStart = index + 1;
  }
  if (lineStart < content.length) lines.push(content.slice(lineStart));
  return lines;
}

function scalarRepresentation(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function parseScalar(value: string, lineNumber: number): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const startsQuoted = trimmed[0] === '"' || trimmed[0] === "'";
  const endsQuoted = trimmed.at(-1) === '"' || trimmed.at(-1) === "'";
  if (startsQuoted || endsQuoted) {
    if (trimmed.length < 2 || trimmed[0] !== trimmed.at(-1)) {
      throw new FrontmatterParseError(
        `line ${lineNumber}: unterminated or mismatched quoted scalar`,
      );
    }
    return trimmed.slice(1, -1);
  }

  if ("|>&*!{}[]".includes(trimmed[0] ?? "")) {
    throw new FrontmatterParseError(
      `line ${lineNumber}: unsupported YAML scalar ${scalarRepresentation(trimmed)}`,
    );
  }
  return trimmed;
}

function parseInlineList(value: string, lineNumber: number): string[] {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    throw new FrontmatterParseError(
      `line ${lineNumber}: blocked_by must be an inline or block list`,
    );
  }

  const content = trimmed.slice(1, -1).trim();
  if (!content) return [];

  return content.split(",").map((rawEntry) => {
    const entry = parseScalar(rawEntry, lineNumber);
    if (!entry) {
      throw new FrontmatterParseError(
        `line ${lineNumber}: blocked_by entries cannot be empty`,
      );
    }
    return entry;
  });
}

export function parseFrontmatter(lines: readonly string[]): Record<string, FieldValue> {
  const fields = Object.create(null) as Record<string, FieldValue>;
  let index = 0;

  while (index < lines.length) {
    const rawLine = lineWithoutEnding(lines[index] ?? "");
    const lineNumber = index + 2;
    index += 1;

    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (/^\s/.test(rawLine)) {
      throw new FrontmatterParseError(`line ${lineNumber}: unexpected indentation`);
    }

    const separator = rawLine.indexOf(":");
    if (separator === -1) {
      throw new FrontmatterParseError(`line ${lineNumber}: expected 'key: value'`);
    }

    const key = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new FrontmatterParseError(
        `line ${lineNumber}: invalid key ${scalarRepresentation(key)}`,
      );
    }
    if (Object.hasOwn(fields, key)) {
      throw new FrontmatterParseError(
        `line ${lineNumber}: duplicate key ${scalarRepresentation(key)}`,
      );
    }

    if (key !== "blocked_by") {
      if (!value) {
        throw new FrontmatterParseError(
          `line ${lineNumber}: empty values are only valid for a blocked_by block list`,
        );
      }
      fields[key] = parseScalar(value, lineNumber);
      continue;
    }

    if (value) {
      fields[key] = parseInlineList(value, lineNumber);
      continue;
    }

    const entries: string[] = [];
    while (index < lines.length) {
      const candidate = lineWithoutEnding(lines[index] ?? "");
      const candidateLineNumber = index + 2;
      if (!candidate.trim() || candidate.trimStart().startsWith("#")) {
        index += 1;
        continue;
      }

      const match = candidate.match(/^[ \t]+-[ \t]+(.+)$/);
      if (!match) break;
      const entry = parseScalar(match[1] ?? "", candidateLineNumber);
      if (!entry) {
        throw new FrontmatterParseError(
          `line ${candidateLineNumber}: blocked_by entries cannot be empty`,
        );
      }
      entries.push(entry);
      index += 1;
    }
    if (entries.length === 0) {
      throw new FrontmatterParseError(
        `line ${lineNumber}: blocked_by block list has no entries`,
      );
    }
    fields[key] = entries;
  }

  return fields;
}

export function parseWp(path: string): Wp {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new DirectoryError(`cannot read ${path}: ${errorMessage(error)}`);
  }

  const lines = linesWithEndings(content);
  if (lines.length === 0 || lineWithoutEnding(lines[0] ?? "") !== "---") {
    throw new FrontmatterError("frontmatter block missing");
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && lineWithoutEnding(line) === "---",
  );
  if (closingIndex === -1) {
    throw new FrontmatterError("frontmatter block unterminated");
  }

  const fields = parseFrontmatter(lines.slice(1, closingIndex));
  fields.blocked_by ??= [];
  return new Wp(
    parse(path).name,
    path,
    fields,
    lines.slice(closingIndex + 1).join(""),
  );
}

export function stemSegments(stem: string): string[] {
  if (!STEM_PATTERN.test(stem)) {
    throw new Error(`invalid work-package stem: ${stem}`);
  }
  return stem.slice(3).match(SEGMENT_PATTERN) ?? [];
}

export function parentId(stem: string): string | null {
  const segments = stemSegments(stem);
  return segments.length === 1 ? null : `wp-${segments.slice(0, -1).join("")}`;
}

export function compareWpIds(left: string, right: string): number {
  const leftSegments = stemSegments(left);
  const rightSegments = stemSegments(right);
  const length = Math.min(leftSegments.length, rightSegments.length);

  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index] ?? "";
    const rightSegment = rightSegments[index] ?? "";
    const letterDifference = leftSegment.charCodeAt(0) - rightSegment.charCodeAt(0);
    if (letterDifference !== 0) return letterDifference;

    const numberDifference = Number(leftSegment.slice(1)) - Number(rightSegment.slice(1));
    if (numberDifference !== 0) return numberDifference;
  }
  return leftSegments.length - rightSegments.length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function scanDirectory(directory: string): ScannedFile[] {
  let filenames: string[];
  try {
    filenames = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isFile()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return statSync(join(directory, entry.name)).isFile();
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name)
      .sort(compareText);
  } catch (error) {
    throw new DirectoryError(
      `cannot read directory ${directory}: ${errorMessage(error)}`,
    );
  }

  return filenames.map((filename): ScannedFile => {
    const path = join(directory, filename);
    const stem = extname(filename) === ".md" ? parse(filename).name : null;
    const id = stem !== null && STEM_PATTERN.test(stem) ? stem : null;
    try {
      return { path, id, wp: parseWp(path) };
    } catch (error) {
      if (error instanceof FrontmatterError || error instanceof FrontmatterParseError) {
        return { path, id, error };
      }
      throw error;
    }
  });
}

export class WpGraph {
  readonly byId: ReadonlyMap<string, Wp>;
  readonly orderedIds: readonly string[];
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly blocks: ReadonlyMap<string, readonly string[]>;

  private readonly segments: ReadonlyMap<string, readonly string[]>;
  private readonly leafIds: ReadonlySet<string>;
  private readonly statusCache = new Map<string, string | null>();

  constructor(workPackages: Iterable<Wp>) {
    this.byId = new Map(Array.from(workPackages, (wp) => [wp.id, wp]));
    this.orderedIds = [...this.byId.keys()].sort(compareWpIds);
    this.segments = new Map(
      [...this.byId.keys()].map((id) => [id, stemSegments(id)]),
    );

    const containerIds = new Set<string>();
    for (const segments of this.segments.values()) {
      for (let depth = 1; depth < segments.length; depth += 1) {
        containerIds.add(`wp-${segments.slice(0, depth).join("")}`);
      }
    }
    this.leafIds = new Set(
      [...this.byId.keys()].filter((id) => !containerIds.has(id)),
    );

    const children = new Map(
      [...this.byId.keys()].map((id): [string, string[]] => [id, []]),
    );
    const blocks = new Map(
      [...this.byId.keys()].map((id): [string, string[]] => [id, []]),
    );
    for (const wp of this.byId.values()) {
      const parent = parentId(wp.id);
      if (parent !== null && children.has(parent)) children.get(parent)?.push(wp.id);
      for (const target of wp.blockedBy) {
        if (blocks.has(target)) blocks.get(target)?.push(wp.id);
      }
    }
    for (const ids of children.values()) ids.sort(compareWpIds);
    for (const ids of blocks.values()) ids.sort(compareWpIds);
    this.children = children;
    this.blocks = blocks;
  }

  typeName(id: string): string {
    return TYPE_NAMES.get(this.segments.get(id)?.length ?? 0) ?? "task";
  }

  isLeaf(id: string): boolean {
    return this.leafIds.has(id);
  }

  resolvedStatus(id: string): string | null {
    if (this.statusCache.has(id)) return this.statusCache.get(id) ?? null;

    const wp = this.requireWp(id);
    let status: string | null;
    if (this.isLeaf(id)) {
      status = wp.status;
    } else {
      const childStatuses = (this.children.get(id) ?? []).map((childId) =>
        this.resolvedStatus(childId),
      );
      if (childStatuses.length === 0 || childStatuses.some((child) => child === null)) {
        status = null;
      } else if (childStatuses.every((child) => child === "done")) {
        status = "done";
      } else if (childStatuses.some((child) => child === "doing" || child === "done")) {
        status = "doing";
      } else {
        status = "todo";
      }
    }

    this.statusCache.set(id, status);
    return status;
  }

  ancestors(id: string): string[] {
    const ancestors: string[] = [];
    let candidate = parentId(id);
    while (candidate !== null) {
      if (this.byId.has(candidate)) ancestors.push(candidate);
      candidate = parentId(candidate);
    }
    return ancestors;
  }

  isReady(id: string): boolean {
    const wp = this.requireWp(id);
    if (!this.isLeaf(id) || wp.status !== "todo") return false;

    const ownerIds = [id, ...this.ancestors(id)];
    const dependencyIds = ownerIds.flatMap(
      (ownerId) => this.requireWp(ownerId).blockedBy,
    );
    return dependencyIds.every(
      (dependency) =>
        this.byId.has(dependency) && this.resolvedStatus(dependency) === "done",
    );
  }

  readyQueue(): Wp[] {
    return this.orderedIds
      .filter((id) => this.isReady(id))
      .map((id) => this.requireWp(id));
  }

  dependencyCycles(): string[][] {
    let nextIndex = 0;
    const indices = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const cycles: string[][] = [];

    const visit = (id: string): void => {
      indices.set(id, nextIndex);
      lowLinks.set(id, nextIndex);
      nextIndex += 1;
      stack.push(id);
      onStack.add(id);

      for (const dependency of this.requireWp(id).blockedBy) {
        if (!this.byId.has(dependency)) continue;
        if (!indices.has(dependency)) {
          visit(dependency);
          lowLinks.set(
            id,
            Math.min(lowLinks.get(id) ?? 0, lowLinks.get(dependency) ?? 0),
          );
        } else if (onStack.has(dependency)) {
          lowLinks.set(
            id,
            Math.min(lowLinks.get(id) ?? 0, indices.get(dependency) ?? 0),
          );
        }
      }

      if (lowLinks.get(id) !== indices.get(id)) return;

      const component: string[] = [];
      while (stack.length > 0) {
        const member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
        if (member === id) break;
      }
      const hasSelfEdge =
        component.length === 1 &&
        this.requireWp(component[0] ?? "").blockedBy.includes(component[0] ?? "");
      if (component.length > 1 || hasSelfEdge) {
        cycles.push(component.sort(compareWpIds));
      }
    };

    for (const id of this.orderedIds) {
      if (!indices.has(id)) visit(id);
    }
    return cycles.sort((left, right) => compareWpIds(left[0] ?? "", right[0] ?? ""));
  }

  private requireWp(id: string): Wp {
    const wp = this.byId.get(id);
    if (!wp) throw new UnknownWpError(`unknown work-package ID: ${id}`);
    return wp;
  }
}

export function graphFromScan(scanned: Iterable<ScannedFile>): WpGraph {
  const workPackages: Wp[] = [];
  for (const entry of scanned) {
    if (entry.id !== null && entry.wp) workPackages.push(entry.wp);
  }
  return new WpGraph(workPackages);
}

function compareProblems(left: Problem, right: Problem): number {
  return compareText(left.file, right.file) || compareText(left.message, right.message);
}

export function check(scanned: readonly ScannedFile[]): Problem[] {
  const problems: Problem[] = [];
  for (const entry of scanned) {
    if (entry.id === null) {
      problems.push(
        new Problem(
          basename(entry.path),
          "filename does not match wp-<segments>.md grammar",
        ),
      );
    }
    if (entry.error) {
      problems.push(new Problem(basename(entry.path), entry.error.message));
    }
  }

  const graph = graphFromScan(scanned);
  for (const id of graph.orderedIds) {
    const wp = graph.byId.get(id);
    if (!wp) continue;
    const isLeaf = graph.isLeaf(id);
    if (!wp.shortDescription.trim()) {
      problems.push(new Problem(basename(wp.path), "short_description missing or empty"));
    }
    if (isLeaf && !Object.hasOwn(wp.fields, "status")) {
      problems.push(new Problem(basename(wp.path), "status missing on leaf"));
    }
    if (!isLeaf && Object.hasOwn(wp.fields, "status")) {
      problems.push(new Problem(basename(wp.path), "status present on container"));
    }
    if (Object.hasOwn(wp.fields, "status") && !VALID_STATUSES.has(String(wp.fields.status))) {
      problems.push(new Problem(basename(wp.path), "status must be one of todo, doing, done"));
    }

    for (const dependency of wp.blockedBy) {
      if (!graph.byId.has(dependency)) {
        problems.push(
          new Problem(basename(wp.path), `blocked_by references unknown WP ${dependency}`),
        );
      }
      if (dependency === id) {
        problems.push(
          new Problem(basename(wp.path), "blocked_by references the WP itself"),
        );
      }
    }

    const parent = parentId(id);
    if (parent !== null && !graph.byId.has(parent)) {
      problems.push(new Problem(basename(wp.path), `parent WP ${parent} has no file`));
    }
  }

  for (const cycle of graph.dependencyCycles()) {
    const first = graph.byId.get(cycle[0] ?? "");
    if (first) {
      problems.push(
        new Problem(basename(first.path), `blocked_by cycle: ${cycle.join(", ")}`),
      );
    }
  }
  return problems.sort(compareProblems);
}

function isFieldLine(line: string, key: string): boolean {
  const raw = lineWithoutEnding(line);
  if (/^\s/.test(raw)) return false;
  const separator = raw.indexOf(":");
  return separator !== -1 && raw.slice(0, separator).trim() === key;
}

function writeAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.wp-tmp`;
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw new DirectoryError(`cannot write ${path}: ${errorMessage(error)}`);
  }
}

/**
 * Rewrite the single `status:` line inside a work package's frontmatter,
 * leaving every other byte of the file untouched. Never inserts the field.
 */
export function setStatus(path: string, status: string): void {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new DirectoryError(`cannot read ${path}: ${errorMessage(error)}`);
  }

  const lines = linesWithEndings(content);
  if (lines.length === 0 || lineWithoutEnding(lines[0] ?? "") !== "---") {
    throw new FrontmatterError("frontmatter block missing");
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && lineWithoutEnding(line) === "---",
  );
  if (closingIndex === -1) {
    throw new FrontmatterError("frontmatter block unterminated");
  }

  const statusIndex = lines.findIndex(
    (line, index) => index > 0 && index < closingIndex && isFieldLine(line, "status"),
  );
  if (statusIndex === -1) {
    throw new FrontmatterError(`no status field in ${basename(path)}`);
  }

  const line = lines[statusIndex] ?? "";
  lines[statusIndex] = `status: ${status}${line.slice(lineWithoutEnding(line).length)}`;
  writeAtomically(path, lines.join(""));
}

function requireLeaf(graph: WpGraph, id: string): Wp {
  const wp = graph.byId.get(id);
  if (!wp) throw new UnknownWpError(`unknown work-package ID: ${id}`);
  if (!graph.isLeaf(id)) {
    throw new TransitionError(`${id} is a container; only leaves carry status`);
  }
  return wp;
}

function applyStatus(wp: Wp, status: string): Wp {
  setStatus(wp.path, status);
  return parseWp(wp.path);
}

function notReadyReason(graph: WpGraph, wp: Wp): string {
  if (wp.status !== "todo") {
    return `${wp.id} is ${wp.status ?? "missing a status"}, not todo`;
  }
  const unmet = [
    ...new Set(
      [wp.id, ...graph.ancestors(wp.id)]
        .flatMap((ownerId) => graph.byId.get(ownerId)?.blockedBy ?? [])
        .filter(
          (dependency) =>
            !graph.byId.has(dependency) || graph.resolvedStatus(dependency) !== "done",
        ),
    ),
  ];
  if (unmet.length === 0) return `${wp.id} is not ready`;
  return `${wp.id} is blocked by ${unmet.join(", ")}`;
}

function doingLeafOtherThan(graph: WpGraph, id: string): string | null {
  return (
    graph.orderedIds.find(
      (other) =>
        other !== id && graph.isLeaf(other) && graph.byId.get(other)?.status === "doing",
    ) ?? null
  );
}

/** Claim a leaf by writing `status: doing`. Re-starting the current claim is a no-op. */
export function startWp(graph: WpGraph, id: string, force = false): Wp {
  const wp = requireLeaf(graph, id);
  if (wp.status === "doing") return wp;

  if (!force) {
    const claimed = doingLeafOtherThan(graph, id);
    if (claimed !== null) throw new TransitionError(`${claimed} is already doing`);
    if (!graph.isReady(id)) throw new TransitionError(notReadyReason(graph, wp));
  }
  return applyStatus(wp, "doing");
}

/** Release a claimed leaf by writing `status: done`. Finishing a done leaf is a no-op. */
export function finishWp(graph: WpGraph, id: string, force = false): Wp {
  const wp = requireLeaf(graph, id);
  if (wp.status === "done") return wp;

  if (!force && wp.status !== "doing") {
    throw new TransitionError(
      `${id} is ${wp.status ?? "missing a status"}, not doing; start it first`,
    );
  }
  return applyStatus(wp, "done");
}

export function loadGraph(directory: string): WpGraph {
  const scanned = scanDirectory(directory);
  const parseDetails = scanned
    .filter((entry) => entry.error)
    .map((entry) => `${basename(entry.path)}: ${entry.error?.message}`);
  const invalidNameDetails = scanned
    .filter((entry) => entry.id === null)
    .map((entry) => `${basename(entry.path)}: invalid filename`);
  const details = [...parseDetails, ...invalidNameDetails];
  if (details.length > 0) {
    throw new DirectoryError(
      `invalid work-package directory; run 'wp check': ${details.join("; ")}`,
    );
  }
  return graphFromScan(scanned);
}

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

function nextJson(wp: Wp): JsonObject {
  return {
    id: wp.id,
    status: wp.status ?? "",
    short_description: wp.shortDescription,
  };
}

function sortedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, sortedJson(value[key] ?? null)]),
  );
}

function jsonText(value: JsonValue): string {
  return (JSON.stringify(sortedJson(value), null, 2) ?? "null").replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function writeLine(value = ""): void {
  process.stdout.write(`${value}\n`);
}

function queueRow(wp: Wp): string {
  return `${wp.id}\t${wp.status ?? ""}\t${wp.shortDescription}`;
}

function printTransition(wp: Wp, asJson: boolean): void {
  writeLine(asJson ? jsonText(nextJson(wp)) : queueRow(wp));
}

function printNext(graph: WpGraph, allReady: boolean, asJson: boolean): void {
  const ready = graph.readyQueue();
  const selected = allReady ? ready : ready.slice(0, 1);
  if (selected.length === 0 && !allReady) return;

  if (asJson) {
    writeLine(
      jsonText(allReady ? selected.map(nextJson) : nextJson(selected[0] as Wp)),
    );
    return;
  }
  for (const wp of selected) writeLine(queueRow(wp));
}

function displayValue(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value === null) return "";
  return String(value);
}

function printShow(graph: WpGraph, id: string, asJson: boolean): void {
  const wp = graph.byId.get(id);
  if (!wp) throw new UnknownWpError(`unknown work-package ID: ${id}`);
  const payload = wpJson(graph, wp);
  if (asJson) {
    writeLine(jsonText(payload));
    return;
  }

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
  for (const key of displayOrder) {
    if (Object.hasOwn(payload, key)) writeLine(`${key}: ${displayValue(payload[key] ?? null)}`);
  }
  for (const key of Object.keys(payload).filter((key) => !shown.has(key)).sort(compareText)) {
    writeLine(`${key}: ${displayValue(payload[key] ?? null)}`);
  }
  if (wp.body) {
    writeLine();
    process.stdout.write(wp.body);
    if (!wp.body.endsWith("\n")) writeLine();
  }
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

function printTree(graph: WpGraph, asJson: boolean): void {
  const rows = treeRows(graph);
  if (asJson) {
    writeLine(jsonText(rows));
    return;
  }
  for (const row of rows) {
    const depth = Number(row.depth);
    const status = String(row.status ?? "invalid");
    writeLine(
      `${"  ".repeat(depth - 1)}${row.id}\t${status}\t${row.short_description}`,
    );
  }
}

function printCheck(problems: readonly Problem[], asJson: boolean): void {
  if (asJson) {
    writeLine(
      jsonText(problems.map((problem) => ({ file: problem.file, problem: problem.message }))),
    );
    return;
  }
  for (const problem of problems) writeLine(problem.toString());
}

interface CliArguments {
  readonly command: "next" | "show" | "tree" | "check" | "start" | "done";
  readonly directory: string;
  readonly asJson: boolean;
  readonly allReady: boolean;
  readonly force: boolean;
  readonly id: string | null;
}

const COMMANDS = ["next", "show", "tree", "check", "start", "done"] as const;
const ID_COMMANDS = new Set(["show", "start", "done"]);

const HELP = `usage: wp [--dir PATH] [--json] {next,show,tree,check,start,done} ...

Markdown-native work-package tracker.

commands:
  next              print ready work
  show ID           show one work package
  tree              show the work-package tree
  check             validate work packages
  start ID          claim a ready leaf by setting status: doing
  done ID           release a claimed leaf by setting status: done

options:
  --dir PATH        work-package directory (default: ./wps)
  --json            emit machine-readable JSON
  --all             with next, print the whole ready queue
  --force           with start or done, skip the readiness and claim checks
  -h, --help        show this help message`;

function parseArguments(argv: readonly string[]): CliArguments | null {
  let directory = "wps";
  let asJson = false;
  let allReady = false;
  let force = false;
  let command: CliArguments["command"] | null = null;
  const commandArguments: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--help" || argument === "-h") {
      return null;
    } else if (argument === "--json") {
      asJson = true;
    } else if (argument === "--all") {
      if (command !== "next") throw new UsageError("unrecognized argument: --all");
      allReady = true;
    } else if (argument === "--force") {
      if (command !== "start" && command !== "done") {
        throw new UsageError("unrecognized argument: --force");
      }
      force = true;
    } else if (argument === "--dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("argument --dir: expected one value");
      }
      directory = value;
      index += 1;
    } else if (argument.startsWith("--dir=")) {
      directory = argument.slice("--dir=".length);
    } else if (argument.startsWith("-")) {
      throw new UsageError(`unrecognized argument: ${argument}`);
    } else if (command === null) {
      if (!(COMMANDS as readonly string[]).includes(argument)) {
        throw new UsageError(`unknown command: ${argument}`);
      }
      command = argument as CliArguments["command"];
    } else {
      commandArguments.push(argument);
    }
  }

  if (command === null) throw new UsageError("a command is required");

  if (ID_COMMANDS.has(command)) {
    if (commandArguments.length !== 1) {
      throw new UsageError(`${command} requires exactly one ID`);
    }
  } else if (commandArguments.length !== 0) {
    throw new UsageError(`${command} does not accept positional arguments`);
  }

  return {
    command,
    directory,
    asJson,
    allReady,
    force,
    id: ID_COMMANDS.has(command) ? (commandArguments[0] ?? null) : null,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const args = parseArguments(argv);
    if (args === null) {
      writeLine(HELP);
      return 0;
    }

    if (args.command === "check") {
      const problems = check(scanDirectory(args.directory));
      printCheck(problems, args.asJson);
      return problems.length > 0 ? 1 : 0;
    }

    const graph = loadGraph(args.directory);
    if (args.command === "next") printNext(graph, args.allReady, args.asJson);
    if (args.command === "show") printShow(graph, args.id as string, args.asJson);
    if (args.command === "tree") printTree(graph, args.asJson);
    if (args.command === "start") {
      printTransition(startWp(graph, args.id as string, args.force), args.asJson);
    }
    if (args.command === "done") {
      printTransition(finishWp(graph, args.id as string, args.force), args.asJson);
    }
    return 0;
  } catch (error) {
    if (error instanceof WpError) {
      process.stderr.write(`wp: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(main());
