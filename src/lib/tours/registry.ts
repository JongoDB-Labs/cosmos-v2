import type { PluginManifest } from "@/lib/plugins/registry";
import { hasPermission } from "@/lib/rbac/permissions";
import type { Tour, TourStep } from "./types";

/**
 * Tours that ship with CORE.
 *
 * Empty, and not by oversight: core cannot name a plugin's routes, so a walk
 * through a plugin's features belongs in that plugin's manifest. A tour of a
 * core feature would go here.
 */
export const CORE_TOURS: Tour[] = [];

/**
 * Every tour on offer: core's, plus those of plugins the org has ENABLED,
 * newest first.
 *
 * Pure, so the enablement set is the caller's to supply and this stays
 * unit-testable — the same shape as slotContributions, deliberately: one notion
 * of "enabled" across every surface that reads it.
 *
 * A disabled plugin's tour is withheld rather than shown-and-broken. Its pages
 * are unreachable for that org, so every step would navigate into a wall.
 *
 * A deployment with no plugins contributing tours gets an EMPTY list, which is
 * what keeps this inert for everybody who has not asked for it.
 */
export function availableTours(
  manifests: readonly PluginManifest[],
  enabled: ReadonlySet<string>,
  permissions: bigint,
): Tour[] {
  const fromPlugins = manifests
    .filter((p) => enabled.has(p.slug))
    .flatMap((p) => p.tours ?? []);
  return [...CORE_TOURS, ...fromPlugins]
    // Trimmed to what THIS reader can walk before anything else sees the list,
    // so no caller can forget to do it and offer a step that redirects.
    .map((t) => tourFor(t, permissions))
    .filter((t): t is Tour => t !== undefined)
    .sort((a, b) => b.released.localeCompare(a.released));
}

/** A specific tour by id — what the ?tour= link resolves against. */
export function tourById(
  id: string,
  manifests: readonly PluginManifest[],
  enabled: ReadonlySet<string>,
  permissions: bigint,
): Tour | undefined {
  return availableTours(manifests, enabled, permissions).find((t) => t.id === id);
}

/**
 * The newest tour this reader has not already been offered, or undefined.
 *
 * Keyed on tour id rather than release version so whoever ships tours can do so
 * on their own cadence: a new tour surfaces the next time somebody loads the
 * app, without a core release to carry it.
 */
export function nextUnseenTour(
  manifests: readonly PluginManifest[],
  enabled: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  permissions: bigint,
): Tour | undefined {
  return availableTours(manifests, enabled, permissions).find((t) => !seen.has(t.id));
}

/**
 * A step is reachable when the reader holds ANY of the permissions it names, or
 * when it names none.
 */
export function stepAllowed(step: TourStep, permissions: bigint): boolean {
  if (!step.anyOf?.length) return true;
  return step.anyOf.some((p) => hasPermission(permissions, p));
}

/**
 * The tour as THIS reader can actually walk it: steps their role cannot reach
 * are dropped, not disabled.
 *
 * Dropped rather than greyed out because a walkthrough is a sales surface as
 * much as a teaching one — "here is a thing you may not see" is worse than
 * silence. Returns undefined when nothing survives, so callers can decline to
 * offer the tour at all rather than open an empty card.
 */
export function tourFor(tour: Tour, permissions: bigint): Tour | undefined {
  const steps = tour.steps.filter((s) => stepAllowed(s, permissions));
  return steps.length ? { ...tour, steps } : undefined;
}
