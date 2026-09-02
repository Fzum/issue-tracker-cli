/**
 * Invariant 7: the frontmatter parser is a YAML *subset* on purpose. Nested maps,
 * multiline scalars, anchors and flow mappings raise `FrontmatterParseError` rather
 * than being silently misread — a misparsed `blocked_by` would corrupt the queue.
 * Do not swap in a YAML library without reading risk §11 of docs/design.md.
 *
 * Also owns the line/EOL splitting that both the reader and the single writer share.
 */

import { type FieldValue, FrontmatterParseError } from "./model.ts";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function lineWithoutEnding(line: string): string {
  return line.endsWith("\n")
    ? line.slice(0, -1).replace(/\r$/, "")
    : line.replace(/\r$/, "");
}

/** Split on LF, CR or CRLF, keeping each terminator so a rewrite is byte-preserving. */
export function linesWithEndings(content: string): string[] {
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

/** True when `line` is the top-level `key:` line — used by the single-line writer. */
export function isFieldLine(line: string, key: string): boolean {
  const raw = lineWithoutEnding(line);
  if (/^\s/.test(raw)) return false;
  const separator = raw.indexOf(":");
  return separator !== -1 && raw.slice(0, separator).trim() === key;
}
