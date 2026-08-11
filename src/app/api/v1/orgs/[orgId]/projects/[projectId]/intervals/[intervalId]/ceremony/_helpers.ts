import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import type { AuthContext } from "@/lib/rbac/check";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { publishToOrg } from "@/lib/realtime/broker";

/**
 * Shared authorization and lookup for the ceremony routes.
 *
 * The split matters: ANY project member may add notes and action items, because
 * a retro only the facilitator can type into is theatre. Opening and closing a
 * ceremony is the facilitator's, gated on the same permission that completes a
 * sprint.
 */

export interface CeremonyCtx {
  ctx: AuthContext;
  orgId: string;
  projectId: string;
  intervalId: string;
}

type Loaded = CeremonyCtx | Response;

export function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

/** Resolve org + session + project-read. Used by every contributor action. */
export async function requireContributor(
  orgId: string,
  projectId: string,
  intervalId: string
): Promise<Loaded> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });

  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  await requireProjectRead(ctx, projectId, "SPRINT_READ");

  return { ctx, orgId, projectId, intervalId };
}

/** As above, plus the facilitator permission that opening/closing requires. */
export async function requireFacilitator(
  orgId: string,
  projectId: string,
  intervalId: string
): Promise<Loaded> {
  const loaded = await requireContributor(orgId, projectId, intervalId);
  if (isResponse(loaded)) return loaded;
  await requireProjectManage(loaded.ctx, projectId, Permission.SPRINT_COMPLETE);
  return loaded;
}

/**
 * Load a ceremony and prove it belongs to this org, project and sprint.
 *
 * Routes address notes and actions by their own IDs, so without this a valid ID
 * from another tenant's ceremony would be editable through this path.
 */
export async function loadCeremony(
  ceremonyId: string,
  scope: { orgId: string; projectId: string; intervalId: string }
) {
  return prisma.sprintCeremony.findFirst({
    where: {
      id: ceremonyId,
      orgId: scope.orgId,
      intervalId: scope.intervalId,
      board: { projectId: scope.projectId },
    },
    select: { id: true, status: true, kind: true, boardId: true },
  });
}

/**
 * Tell every open client that a ceremony changed — by REFERENCE only.
 *
 * Note text must never ride the bus: the pg adapter caps payloads at 6 KB
 * (Postgres NOTIFY allows 8 KB, minus headroom) and a room full of people
 * typing is exactly the load that would truncate. Clients receive the ref and
 * refetch through their org-scoped query key.
 */
export function publishCeremonyChanged(orgId: string, ceremonyId: string) {
  publishToOrg(orgId, "ceremony.changed", { ceremonyId });
}
