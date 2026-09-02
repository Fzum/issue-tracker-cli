/**
 * The domain vocabulary: the failure taxonomy that `main` turns into exit 2, and the
 * records that travel down the pipeline. Imports nothing, so no cycle can reach it.
 */

export type FieldValue = string | string[];

/** Every error `main` converts into exit 2. Anything else propagates as a crash. */
export class WpError extends Error {}
export class DirectoryError extends WpError {}
export class UnknownWpError extends WpError {}
export class FrontmatterError extends WpError {}
export class FrontmatterParseError extends WpError {}
export class TransitionError extends WpError {}
export class UsageError extends WpError {}

/**
 * One parsed work package. Invariant 2: only `status`, `blocked_by` and
 * `short_description` are stored — the getters below are the whole read surface.
 * Unknown keys stay in `fields` and are preserved but ignored.
 */
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

/** One file seen by `scanDirectory`: parsed, or recorded with why it would not parse. */
export interface ScannedFile {
  readonly path: string;
  readonly id: string | null;
  readonly wp?: Wp;
  readonly error?: WpError;
}

/** One `wp check` finding. `toString` is the plain-text row format — src/render.ts prints it. */
export class Problem {
  constructor(
    readonly file: string,
    readonly message: string,
  ) {}

  toString(): string {
    return `${this.file}: ${this.message}`;
  }
}
