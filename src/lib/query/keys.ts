"use client";
import { usePathname } from "next/navigation";

/**
 * Returns the current org slug from the URL. Returns `null` when no org is
 * in the path (e.g. /onboarding, /admin/...).
 */
export function useOrgSlug(): string | null {
  const pathname = usePathname();
  const seg = pathname.split("/").filter(Boolean)[0];
  // Reserved top-level routes that aren't orgs
  if (
    !seg ||
    seg === "onboarding" ||
    seg === "admin" ||
    seg === "internal" ||
    seg === "login"
  ) {
    return null;
  }
  return seg;
}

/**
 * Build an org-scoped query key. Every cosmos query must use this so that
 * an org-switch automatically invalidates the cache on the new org's pages.
 *
 * Usage:
 *   const key = useOrgQueryKey("themes");
 *   const { data } = useQuery({ queryKey: key, queryFn: ... });
 *
 * For dependent keys:
 *   useOrgQueryKey("work-items", { projectKey: "fsc", filter: { status: "active" } })
 */
export function useOrgQueryKey(...parts: unknown[]): unknown[] {
  const orgSlug = useOrgSlug();
  return ["org", orgSlug, ...parts];
}

/**
 * Direct (non-hook) helper for code paths that already know the orgSlug —
 * e.g. invalidation from a mutation.
 */
export function orgQueryKey(
  orgSlug: string | null,
  ...parts: unknown[]
): unknown[] {
  return ["org", orgSlug, ...parts];
}
