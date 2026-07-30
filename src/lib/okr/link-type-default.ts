/**
 * Which work-item TYPE a link picker offers first.
 *
 * #52: KRs should map to something high-level — Feature by default — so a
 * stakeholder can read PI Objective progress off real Feature delivery instead
 * of only key-result numbers. A project may configure a different type.
 *
 * ── The trap this file exists to avoid ──────────────────────────────────────
 * "Feature" is a CUSTOM work-item type. Its key is BARE (`"feature"`) in some
 * orgs, not a sector-prefixed built-in like `"software.story"`. Constructing a
 * key — `${sector}.feature` — has broken type resolution in this codebase
 * before (see the comments in src/hooks/use-work-item-types.ts). So nothing
 * here ever builds or parses a key:
 *
 *   * the configured default is stored and resolved as a `workItemTypeId`;
 *   * the fallback matches on the type's NAME ("Feature"), which is what a user
 *     actually sees and what the seeds set, and is namespace-agnostic.
 *
 * A stored id that no longer resolves (its type was retired) degrades to the
 * same fallback rather than leaving the picker pointed at nothing — which is
 * why the column carries no FK.
 */

/** The shape both the API and `useWorkItemTypes` already provide. */
export interface LinkTypeCandidate {
  id: string;
  name: string;
}

/** The name we fall back to when a project has not configured a type. */
export const FALLBACK_LINK_TYPE_NAME = "Feature";

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The type a picker should offer first, or `null` for "no preference — order as
 * before".
 *
 * `configuredId` wins when it still exists. Otherwise the org's type named
 * "Feature", if it has one. Never throws, and never invents a key.
 */
export function resolveLinkTypeId(
  configuredId: string | null | undefined,
  types: readonly LinkTypeCandidate[],
): string | null {
  if (configuredId && types.some((t) => t.id === configuredId)) return configuredId;

  const fallback = types.find((t) => norm(t.name) === norm(FALLBACK_LINK_TYPE_NAME));
  return fallback?.id ?? null;
}

/**
 * Order candidates so the preferred type comes first, everything else after.
 *
 * Ordering, NOT filtering: an org mid-transition still has KRs linked to
 * Stories, and hiding the other types would strand them. Existing links stay
 * valid — this only changes what a user reaches for first.
 *
 * Stable within each half, so the caller's own sort (sortOrder, ticket number)
 * survives.
 */
export function orderByPreferredType<T extends { workItemTypeId?: string | null }>(
  items: readonly T[],
  preferredTypeId: string | null,
): T[] {
  if (!preferredTypeId) return [...items];
  const preferred: T[] = [];
  const rest: T[] = [];
  for (const i of items) {
    (i.workItemTypeId === preferredTypeId ? preferred : rest).push(i);
  }
  return [...preferred, ...rest];
}
