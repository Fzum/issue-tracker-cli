/**
 * Invariant 1: the filename stem *is* the work-package ID. This module owns that
 * grammar, the ordering derived from it, and nothing else. It imports nothing.
 */

const SEGMENT_PATTERN = /[a-z][0-9]+/g;

export const STEM_PATTERN = /^wp-(?:[a-z][0-9]+)+$/;

export function stemSegments(stem: string): string[] {
  if (!STEM_PATTERN.test(stem)) {
    throw new Error(`invalid work-package stem: ${stem}`);
  }
  return stem.slice(3).match(SEGMENT_PATTERN) ?? [];
}

/** The parent is the stem minus its last segment; a single-segment stem has none. */
export function parentId(stem: string): string | null {
  const segments = stemSegments(stem);
  return segments.length === 1 ? null : `wp-${segments.slice(0, -1).join("")}`;
}

/** Natural sort: segment letter, then segment number, so `wp-m2` precedes `wp-m10`. */
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

/**
 * Ordering for `blocked_by` targets, the one place unvalidated strings reach a sort.
 * A target names a WP that need not exist and need not even be a grammatical stem —
 * `wp check` reports either as rule 4, an unknown WP — so `compareWpIds` would throw and
 * take `wp tree` down with it, exactly when the tree is the thing that would name the
 * problem. Grammatical stems keep natural order and sort first; anything else follows
 * them, lexicographically.
 */
export function compareBlockerIds(left: string, right: string): number {
  const leftIsStem = STEM_PATTERN.test(left);
  const rightIsStem = STEM_PATTERN.test(right);
  if (leftIsStem && rightIsStem) return compareWpIds(left, right);
  if (leftIsStem !== rightIsStem) return leftIsStem ? -1 : 1;
  return compareText(left, right);
}

/**
 * Lexicographic. NEVER apply this to work-package IDs — it sorts `wp-m10` before
 * `wp-m2`. It is for filenames, object keys and problem messages only; IDs use
 * `compareWpIds`. The tail of `compareBlockerIds` is not an exception to that: it
 * reaches here only for a string that is no work-package ID at all.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
