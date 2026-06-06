// src/lib/cutover/freeze.ts
//
// Per-tenant write-FREEZE (design spec §9.4). During an org's cutover window we briefly
// freeze WRITES to that org in the source app so the last delta can drain consistently:
// the request proxy returns HTTP 405 on mutating verbs (POST/PUT/PATCH/DELETE) for the
// frozen org, while READS (GET/HEAD/OPTIONS) keep working. Reversible.
//
// Backed by the `frozen_orgs` table (migration 20260606110000). A row keyed by BOTH
// org_slug and org_id exists iff the org is frozen — so the proxy can match whichever
// identifier the URL carries (dashboard /<slug>/…  or  API /api/v1/orgs/<uuid>/…).
//
// This is the SOURCE-side (v1) freeze primitive in the runbook's
// freeze → export → import → verify → flip sequence. It is also safe to leave wired in
// v2 permanently (a no-op unless a row is inserted), which is why it lives in the app.

import { prisma } from "@/lib/db/client";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A method that would MODIFY data (the proxy blocks these for a frozen org). */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Extract the org identifier (slug OR id) a request targets, from its pathname. Returns
 * `{ kind, value }` or null for non-org-scoped paths (which are never frozen).
 *   /api/v1/orgs/<uuid>/…   → { kind: "id",   value: <uuid> }
 *   /<slug>/…               → { kind: "slug", value: <slug> }   (dashboard routes)
 * Auth/health/static/login and other top-level non-tenant prefixes return null.
 */
export function orgRefFromPath(pathname: string): { kind: "id" | "slug"; value: string } | null {
  // API form: /api/v1/orgs/<id>/...
  const apiMatch = /^\/api\/v1\/orgs\/([^/]+)(?:\/|$)/.exec(pathname);
  if (apiMatch) return { kind: "id", value: decodeURIComponent(apiMatch[1]) };

  // Non-tenant top-level prefixes that share the /<seg>/ shape but are NOT org slugs.
  // Anything under /api (other than the orgs form above) is never a dashboard org route.
  if (pathname.startsWith("/api/")) return null;

  const NON_ORG_TOP = new Set([
    "login",
    "logout",
    "_next",
    "manifest.webmanifest",
    "favicon.ico",
    "public",
    "onboarding",
  ]);
  const segMatch = /^\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!segMatch) return null;
  const seg = decodeURIComponent(segMatch[1]);
  if (NON_ORG_TOP.has(seg) || seg.includes(".")) return null;
  return { kind: "slug", value: seg };
}

/** Is the given org (by slug) currently frozen? */
export async function isOrgFrozen(orgSlug: string): Promise<boolean> {
  const row = await prisma.frozenOrg.findUnique({ where: { orgSlug }, select: { id: true } });
  return row !== null;
}

/** Is the org targeted by this path frozen? Resolves by id OR slug as the path dictates.
 *  Returns false for non-org paths. This is the predicate the proxy calls. */
export async function isPathOrgFrozen(pathname: string): Promise<boolean> {
  const ref = orgRefFromPath(pathname);
  if (!ref) return false;
  if (ref.kind === "id") {
    const row = await prisma.frozenOrg.findUnique({ where: { orgId: ref.value }, select: { id: true } });
    return row !== null;
  }
  const row = await prisma.frozenOrg.findUnique({ where: { orgSlug: ref.value }, select: { id: true } });
  return row !== null;
}

/** Freeze an org (idempotent: re-freezing updates the reason/by, never errors). */
export async function freezeOrg(
  orgId: string,
  orgSlug: string,
  opts: { reason?: string; frozenBy?: string } = {},
): Promise<void> {
  await prisma.frozenOrg.upsert({
    where: { orgId },
    create: { orgId, orgSlug, reason: opts.reason ?? "", frozenBy: opts.frozenBy ?? null },
    update: { orgSlug, reason: opts.reason ?? "", frozenBy: opts.frozenBy ?? null },
  });
}

/** Unfreeze an org (idempotent: unfreezing a non-frozen org is a no-op). */
export async function unfreezeOrg(orgId: string): Promise<void> {
  await prisma.frozenOrg.deleteMany({ where: { orgId } });
}
