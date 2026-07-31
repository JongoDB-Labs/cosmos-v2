import { getActiveProjectsForOrg } from "@/lib/cache/queries";
import { getVisibleProjectIds } from "@/lib/rbac/project-access";
import { getAuthContext } from "@/lib/auth/session";

/**
 * How many active projects THIS actor can see.
 *
 * Reported from the running app: with a restricted project correctly hidden from
 * the list, every header still read the full org total — "3 projects" to someone
 * who could open two. A count is not a lesser disclosure than a list; it tells a
 * non-member precisely how much they are not being shown, which is the one fact
 * the setting exists to withhold.
 *
 * It went wrong because the count had no actor at all: `getActiveProjectCountForOrg`
 * took an orgId and nothing else. That could not be fixed in place — the query is
 * `"use cache"` keyed per ORG, so making it vary by actor would either serve one
 * user's total to another or destroy the cache.
 *
 * So it follows the same shape the project grid already uses: keep the cached
 * org-wide read, then narrow per request. The cache stays shared and correct, and
 * the number the actor sees is derived from exactly the set they can open.
 */
export async function countVisibleActiveProjects(
  orgSlug: string,
  orgId: string,
): Promise<number> {
  const ctx = await getAuthContext(orgSlug);
  // No context means no session; showing an org-wide total to an unauthenticated
  // reader is the very disclosure this exists to prevent.
  if (!ctx) return 0;

  const active = await getActiveProjectsForOrg(orgId);
  const visible = await getVisibleProjectIds(
    ctx,
    active.map((p) => p.id),
  );
  return visible.size;
}
