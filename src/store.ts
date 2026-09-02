/**
 * The filesystem *is* the tracker. This is the ONLY module that imports node:fs.
 *
 * Read path: `parseWp` -> `scanDirectory` -> `loadGraph`.
 * Write path: invariant 6 — `setStatus` only ever *replaces* an existing `status:`
 * line, never inserts one, never re-serialises the frontmatter, always via
 * temp-file + rename.
 */

import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, parse } from "node:path";

import { compareText, STEM_PATTERN } from "./ids.ts";
import {
  DirectoryError,
  FrontmatterError,
  FrontmatterParseError,
  type ScannedFile,
  Wp,
} from "./model.ts";
import {
  isFieldLine,
  lineWithoutEnding,
  linesWithEndings,
  parseFrontmatter,
} from "./frontmatter.ts";
import { graphFromScan, type WpGraph } from "./graph.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTextFile(path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new DirectoryError(`cannot read ${path}: ${errorMessage(error)}`);
  }
}

/**
 * Index of the closing `---`. Throws if the block is missing or unterminated, so
 * the reader and the writer report the same two errors in the same words.
 */
function locateFrontmatter(lines: readonly string[]): number {
  if (lines.length === 0 || lineWithoutEnding(lines[0] ?? "") !== "---") {
    throw new FrontmatterError("frontmatter block missing");
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && lineWithoutEnding(line) === "---",
  );
  if (closingIndex === -1) {
    throw new FrontmatterError("frontmatter block unterminated");
  }
  return closingIndex;
}

export function parseWp(path: string): Wp {
  const lines = linesWithEndings(readTextFile(path));
  const closingIndex = locateFrontmatter(lines);

  const fields = parseFrontmatter(lines.slice(1, closingIndex));
  // Invariant 2: `blocked_by` is always a list, so callers never branch on absent.
  fields.blocked_by ??= [];
  return new Wp(
    parse(path).name,
    path,
    fields,
    lines.slice(closingIndex + 1).join(""),
  );
}

/**
 * Every file in `directory`, sorted by filename. A file whose frontmatter will not
 * parse is returned with its error rather than thrown, so `wp check` can report on
 * broken files. `id` is null when the stem does not match the grammar; note that
 * `parseWp` deliberately does not validate the stem — this is the only gate.
 */
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
  const lines = linesWithEndings(readTextFile(path));
  const closingIndex = locateFrontmatter(lines);

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

/**
 * The read path for `next` / `show` / `tree`: refuses to build a graph if any file
 * is unparseable or badly named, telling the caller to run `wp check`. `check`
 * deliberately uses `scanDirectory` directly so it can report on broken files.
 */
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
