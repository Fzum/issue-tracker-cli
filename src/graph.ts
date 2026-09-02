/**
 * Invariants 3, 4 and 5: every derivation over a set of work packages. Parent,
 * children, `blocks`, type, container status rollup, readiness and dependency
 * cycles are all computed here and never stored. Pure — this module never reads or
 * writes the filesystem.
 */

import { compareWpIds, parentId, stemSegments } from "./ids.ts";
import { UnknownWpError, type ScannedFile, type Wp } from "./model.ts";

const TYPE_NAMES = new Map([
  [1, "milestone"],
  [2, "epic"],
  [3, "story"],
]);

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

  /** Invariant 4: a leaf carries its own status; a container rolls its children up. */
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

  /**
   * Ancestors that actually have a file. src/tree.ts walks the *unfiltered* chain
   * instead, because its spine glyphs depend on depth even where a parent file is
   * missing — do not collapse the two.
   */
  ancestors(id: string): string[] {
    const ancestors: string[] = [];
    let candidate = parentId(id);
    while (candidate !== null) {
      if (this.byId.has(candidate)) ancestors.push(candidate);
      candidate = parentId(candidate);
    }
    return ancestors;
  }

  /**
   * Invariant 5: readiness includes ancestors. `unmetDependencies` below is the same
   * rule with inverted polarity, so it can name the blockers — change both together.
   */
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

  /**
   * The `blocked_by` targets of a WP and its ancestors that have not resolved to
   * `done`. Unknown targets count as unmet; `wp check` reports them separately.
   *
   * Invariant 5 with inverted polarity: `isReady` answers yes/no, this names the
   * blockers. Both readers depend on that equivalence — src/transitions.ts lists
   * them in the `wp start` refusal, src/tree.ts prints them after `⊘` — so the tree
   * can never call a WP startable when `wp start` would refuse it.
   *
   * Owner order, de-duplicated: the WP's own targets first, then each ancestor's.
   * `wp start` reports them in that order; `src/tree.ts` sorts by `compareWpIds`
   * first, because its column is read by eye.
   */
  unmetDependencies(id: string): string[] {
    return [
      ...new Set(
        [id, ...this.ancestors(id)]
          .flatMap((ownerId) => this.byId.get(ownerId)?.blockedBy ?? [])
          .filter(
            (dependency) =>
              !this.byId.has(dependency) || this.resolvedStatus(dependency) !== "done",
          ),
      ),
    ];
  }

  readyQueue(): Wp[] {
    return this.orderedIds
      .filter((id) => this.isReady(id))
      .map((id) => this.requireWp(id));
  }

  /** Tarjan's strongly-connected components over `blocked_by`, self-edges included. */
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

/** Build a graph from a scan, skipping badly-named and unparseable files. */
export function graphFromScan(scanned: Iterable<ScannedFile>): WpGraph {
  const workPackages: Wp[] = [];
  for (const entry of scanned) {
    if (entry.id !== null && entry.wp) workPackages.push(entry.wp);
  }
  return new WpGraph(workPackages);
}
