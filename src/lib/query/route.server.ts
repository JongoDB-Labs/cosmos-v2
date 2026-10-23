/**
 * The gate every CQL route shares, so none of them can forget a step:
 *
 *   org exists → signed in → raw ITEM_READ bit → org has CQL switched on
 *
 * The raw bit, not requireAccess(ITEM_READ): an org-wide query has no single
 * resource, and a resource-less ABAC check cannot resolve an `in_project` deny
 * and fails closed (see work-items/search/route.ts). Per-project narrowing
 * happens inside executeCql via getReadableProjectIds.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { handleApiError } from "@/lib/api-helpers";
import { cqlEnabled } from "./flag";
import { CqlError } from "./errors";

export async function cqlGate(
  orgId: string,
): Promise<{ ctx: AuthContext; org: { id: string; slug: string } } | { response: Response }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  if (!org) return { response: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { response: new Response("Unauthorized", { status: 401 }) };
  if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) return { response: new Response("Forbidden", { status: 403 }) };
  // Off: the routes do not exist yet for this org.
  if (!cqlEnabled(org.settings)) return { response: new Response("Not found", { status: 404 }) };
  return { ctx, org: { id: org.id, slug: org.slug } };
}

/** `400 { error: { code: "CQL_INVALID", diagnostics } }` (422 for a timeout); else the house handler. */
export function cqlErrorResponse(e: unknown): Response {
  if (e instanceof CqlError) {
    const code = e.diagnostics.some((d) => d.code === "CQL_TIMEOUT") ? "CQL_TIMEOUT" : "CQL_INVALID";
    return NextResponse.json({ error: { code, message: e.message, diagnostics: e.diagnostics } }, { status: e.status });
  }
  return handleApiError(e);
}
