/**
 * The validation rules of docs/design.md §7. Pure — it takes already-scanned files,
 * not a directory, so it can report on files that `loadGraph` would refuse.
 *
 * One input can legitimately produce several problems: a self-dependency trips both
 * the self-reference rule and the cycle rule, and a stray non-WP file trips both the
 * filename rule and the frontmatter rule. The spec numbers these separately — do not
 * "fix" the duplication by collapsing rules.
 */

import { basename } from "node:path";

import { compareText, parentId } from "./ids.ts";
import { Problem, type ScannedFile } from "./model.ts";
import { graphFromScan } from "./graph.ts";

const VALID_STATUSES = new Set(["todo", "doing", "done"]);

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
