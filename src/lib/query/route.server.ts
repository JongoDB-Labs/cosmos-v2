/**
 * The gate every CQL route shares, so none of them can forget a step:
 *
 *   org exists → org has CQL switched on → signed in → raw ITEM_READ bit
 *
 * The switch comes first: for an org without it the routes do not exist, so
 * everyone gets the same 404, whatever their permissions.
 *
 * The raw bit, not requireAccess(ITEM_READ): an org-wide query has no single
 * resource, and a resource-less ABAC check cannot resolve an `in_project` deny
 * and fails closed (see work-items/search/route.ts). Per-project narrowing
 * happens inside executeCql via getReadableProjectIds.
 *
 * Given its contract, a route's API-key scopes are checked too (as orgContext
 * does): without it, a `read` key could call a route whose contract says
 * `items:write`.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { handleApiError } from "@/lib/api-helpers";
import { cqlEnabled } from "./flag";
import { CqlError } from "./errors";
import { CQL_LIMITS } from "./ast";
import { assertScopes } from "@/lib/openapi/org-context";
import type { RouteContract } from "@/lib/openapi/contract";

export async function cqlGate(
  orgId: string,
  contract?: Pick<RouteContract, "scopes">,
): Promise<{ ctx: AuthContext; org: { id: string; slug: string } } | { response: Response }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  // Off: the routes do not exist yet for this org.
  if (!org || !cqlEnabled(org.settings)) return { response: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { response: new Response("Unauthorized", { status: 401 }) };
  if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) return { response: new Response("Forbidden", { status: 403 }) };
  if (contract) {
    try {
      assertScopes(ctx, contract);
    } catch (e) {
      return { response: handleApiError(e) };
    }
  }
  return { ctx, org: { id: org.id, slug: org.slug } };
}

/** Text longer than this is refused before it reaches the parser (CQL_LIMITS.textLength). */
export function cqlTooLong(text: string): Response | null {
  if (text.length <= CQL_LIMITS.textLength) return null;
  return NextResponse.json(
    { error: { code: "CQL_INVALID", message: `A query can be at most ${CQL_LIMITS.textLength} characters.`, diagnostics: [] } },
    { status: 400 },
  );
}

/** `400 { error: { code: "CQL_INVALID", diagnostics } }` (422 for a timeout); else the house handler. */
export function cqlErrorResponse(e: unknown): Response {
  if (e instanceof CqlError) {
    const code = e.diagnostics.some((d) => d.code === "CQL_TIMEOUT") ? "CQL_TIMEOUT" : "CQL_INVALID";
    return NextResponse.json({ error: { code, message: e.message, diagnostics: e.diagnostics } }, { status: e.status });
  }
  return handleApiError(e);
}

/**
 * Merge keys into `Organization.settings.cql` in ONE statement, returning the
 * `cql` object as it was. A read-modify-write in JS would lose a concurrent
 * change to any other org setting written between the read and the write.
 */
export async function patchCqlSettings(orgId: string, patch: Record<string, boolean>): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRaw<{ before: unknown }[]>(Prisma.sql`
    WITH old AS (SELECT settings -> 'cql' AS cql FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE)
    UPDATE organizations o
       SET settings = o.settings || jsonb_build_object('cql', COALESCE(o.settings -> 'cql', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb),
           updated_at = now()
      FROM old
     WHERE o.id = ${orgId}::uuid
    RETURNING old.cql AS before`);
  const before = rows[0]?.before;
  return before && typeof before === "object" ? (before as Record<string, unknown>) : {};
}
