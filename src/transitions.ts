/**
 * The `wp start` / `wp done` guard policy: what refuses a transition, and what
 * `--force` overrides. Invariant 6: these are the only write path, and they delegate
 * the actual byte-level rewrite to `setStatus`.
 */

import { TransitionError, UnknownWpError, type Wp } from "./model.ts";
import { type WpGraph } from "./graph.ts";
import { parseWp, setStatus } from "./store.ts";

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

/**
 * The `blocked_by` targets of a WP and its ancestors that have not resolved to
 * `done`. Unknown targets count as unmet; `wp check` reports them separately.
 *
 * Invariant 5 again, with inverted polarity: `WpGraph.isReady` answers yes/no, this
 * names the blockers so the error message can list them. Change both together.
 */
function unmetDependencies(graph: WpGraph, id: string): string[] {
  return [
    ...new Set(
      [id, ...graph.ancestors(id)]
        .flatMap((ownerId) => graph.byId.get(ownerId)?.blockedBy ?? [])
        .filter(
          (dependency) =>
            !graph.byId.has(dependency) || graph.resolvedStatus(dependency) !== "done",
        ),
    ),
  ];
}

/**
 * Start work on a leaf by writing `status: doing`. An unmet dependency is the
 * only thing that stops it: the current status is irrelevant, so a `done` leaf
 * reopens and any number of leaves may be `doing` at once. Re-starting the
 * leaf that is already `doing` is a no-op.
 */
export function startWp(graph: WpGraph, id: string, force = false): Wp {
  const wp = requireLeaf(graph, id);
  if (wp.status === "doing") return wp;

  if (!force) {
    const blockers = unmetDependencies(graph, id);
    if (blockers.length > 0) {
      throw new TransitionError(`${id} is blocked by ${blockers.join(", ")}`);
    }
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
