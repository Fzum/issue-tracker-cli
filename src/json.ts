/**
 * The one JSON encoder. `--json` output is a stability contract for agent consumers,
 * so keys are sorted recursively and non-ASCII is escaped. src/render.ts and
 * src/tree.ts are the only callers; nothing else may call `jsonText`.
 */

import { compareText } from "./ids.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

function sortedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, sortedJson(value[key] ?? null)]),
  );
}

/** Every UTF-16 code unit at or above U+0080 — i.e. everything outside ASCII. */
const NON_ASCII = /[^\x00-\x7F]/g;

export function jsonText(value: JsonValue): string {
  return (JSON.stringify(sortedJson(value), null, 2) ?? "null").replace(
    NON_ASCII,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
