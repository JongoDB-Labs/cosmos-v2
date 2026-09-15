/**
 * Ids that arrive from UNTRUSTED input — above all, from MODEL input.
 *
 * Every cosmos id is a Postgres `uuid`, and the model does NOT always send one:
 * asked for a project's sprint data it will invent a readable-looking id
 * ("f9s8d7f9-demo-proj-id") when it never looked the project up. Handing that to
 * Prisma raises P2007 — `invalid input syntax for type uuid` — and that is a
 * THROW, not a value, so it tears down whatever is running instead of returning
 * nothing.
 *
 * Use these at the seam where such an id reaches a `uuid` column or a tool's own
 * arguments. The id's SHAPE is the only thing checked: whether it exists, and
 * whether the caller may read it, are separate questions for the permission and
 * scope helpers.
 */

/** The shape Postgres accepts for a `uuid` column. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` when `value` is a string Postgres will accept as a uuid. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** `true` when `value` is absent, or a string Postgres will accept as a uuid. */
export function isOptionalUuid(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return isUuid(value);
}
