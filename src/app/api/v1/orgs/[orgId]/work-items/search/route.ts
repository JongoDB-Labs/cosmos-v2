import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import {
  getReadableProjectIds,
  parseSearchParams,
  runWorkItemQuery,
  workItemQuerySchema,
  unknownQueryParams,
} from "@/lib/work-items/query";
import { cqlEnabled } from "@/lib/query/flag";
import { executeCql } from "@/lib/query/execute.server";
import { savedFilterQuery } from "@/lib/query/saved-filters.server";
import { cqlErrorResponse, cqlTooLong } from "@/lib/query/route.server";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { scheduleParity } from "@/lib/query/parity.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const EMPTY_RESULT = { data: [], total: 0 };

/**
 * Org-wide work-item search ("JQL-lite"). Returns work items ACROSS every
 * project the actor may read, filtered by the cross-project filter model.
 *
 * RBAC: this is an org-wide list with NO single resource, so we gate on the raw
 * ITEM_READ bit only — NOT requireAccess(ITEM_READ). A resource-less ABAC gate
 * can't resolve an `in_project` deny (no projectId) and fails CLOSED, which
 * would 403 the whole Issues page for an actor who legitimately reads SOME
 * projects. Instead `getReadableProjectIds` folds the per-project `in_project`
 * deny in (and OWNER break-glass), and the where-builder hard-scopes every
 * query to that set — an actor can never read items from a project they can't
 * access, and an empty readable set yields an empty result, not a 403.
 *
 * GET  — simple filters via search params (?project=…&priority=HIGH&text=…).
 * POST — a complex filter as a JSON body ({ filter, sort, page, pageSize }).
 * Both return { data: IssueRow[], total } — the jsonFetch unwrapper leaves a
 * two-key envelope intact.
 *
 * GET ?cql=… — where the org has CQL on, a query in the Cosmos Query Language
 * instead of the individual filter params (which it replaces: mixing them is a
 * 400). Answers { data, total, totalCapped, cql, diagnostics }.
 *
 * Every legacy search is also, on a sample and after the response, re-run
 * through CQL and compared (lib/query/parity.server.ts) before cut-over.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const sp = request.nextUrl.searchParams;
    const cqlOn = cqlEnabled(org.settings);
    // `?cql=` on an org without the query language: that parameter doesn't
    // exist there, the same 404 as the other CQL routes (not "unknown param").
    if (!cqlOn && sp.has("cql")) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Org-level read gate: the raw bit only (see route doc). Per-project
    // narrowing — including any in_project ITEM_READ deny — happens in
    // getReadableProjectIds below.
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return new Response("Forbidden", { status: 403 });
    }

    const cql = cqlOn ? sp.get("cql") : null;
    // `?filter=<savedFilterId>` runs a saved filter's stored query; with `cql`
    // too, the text wins (the filter id only says which one was loaded).
    const filterId = cqlOn ? sp.get("filter") : null;
    if (cql !== null || filterId !== null) {
      const others = [...new Set(sp.keys())].filter((k) => !["cql", "tz", "page", "pageSize", "filter"].includes(k));
      if (others.length > 0) {
        return new Response(
          JSON.stringify({ error: "`cql` replaces the other filter parameters", unknown: others }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (cql !== null) {
        const tooLong = cqlTooLong(cql);
        if (tooLong) return tooLong;
      }
      // The same budget as POST work-items/query: one query is one query.
      const limited = checkRateLimit(request, "cql.query", ctx.userId, { capacity: 30, refillPerSecond: 3 });
      if (limited) return limited;
      const stored = cql === null ? await savedFilterQuery(ctx, filterId!) : null;
      if (cql === null && !stored) {
        return new Response(JSON.stringify({ error: "Saved filter not found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      // No early "nothing readable" answer here: a malformed query is still a
      // 400 for someone who can read nothing (executeCql checks it first).
      try {
        const page = Number.parseInt(sp.get("page") ?? "1", 10);
        const pageSize = Number.parseInt(sp.get("pageSize") ?? "", 10);
        const r = await executeCql(ctx, cql !== null ? { cql } : { query: stored }, {
          page: Number.isNaN(page) ? 1 : page,
          ...(Number.isNaN(pageSize) ? {} : { pageSize }),
          tz: sp.get("tz") ?? undefined,
        });
        return success({ data: r.data, total: r.total, totalCapped: r.totalCapped, cql: r.cql, diagnostics: r.diagnostics });
      } catch (e) {
        return cqlErrorResponse(e);
      }
    }

    const allowedProjectIds = await getReadableProjectIds(ctx);
    if (allowedProjectIds.length === 0) return success(EMPTY_RESULT);

    // Reject parameters nothing will read, rather than answering as if they
    // had been applied. A filter that silently does not filter returns
    // plausible WRONG answers, which costs the caller more than an error.
    const unknown = unknownQueryParams(request.nextUrl.searchParams, ["watchedByMe"]);
    if (unknown.length > 0) {
      return new Response(
        JSON.stringify({
          error: "Unknown query parameter",
          unknown,
          hint:
            "Unrecognised parameters are not applied, so this request would have "
            + "returned an unfiltered page. Check the spelling against the supported filters.",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const { filter, sort, page, pageSize } = parseSearchParams(
      request.nextUrl.searchParams,
    );
    // "Watching" filter (FR 8702c9b8) — resolve the sentinel to the caller's id
    // here so the where-builder stays pure.
    if (request.nextUrl.searchParams.get("watchedByMe")) {
      filter.watchedByUserId = ctx.userId;
    }

    const result = await runWorkItemQuery({
      orgId,
      allowedProjectIds,
      filter,
      sort,
      page,
      pageSize,
    });
    scheduleParity(ctx, { filter, sort, page, pageSize }, result, cqlEnabled(org.settings));
    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return new Response("Forbidden", { status: 403 });
    }

    const allowedProjectIds = await getReadableProjectIds(ctx);
    if (allowedProjectIds.length === 0) return success(EMPTY_RESULT);

    const body = await request.json().catch(() => ({}));
    const { filter, sort, page, pageSize } = workItemQuerySchema.parse(body);
    // A watch list is personal: the GET twin only ever resolves `watchedByMe`
    // to the caller, so the POST may name the caller and nobody else.
    if (filter.watchedByUserId && filter.watchedByUserId !== ctx.userId) {
      return new Response(
        JSON.stringify({ error: "filter.watchedByUserId may only be your own user id" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const result = await runWorkItemQuery({
      orgId,
      allowedProjectIds,
      filter,
      sort,
      page,
      pageSize,
    });
    scheduleParity(ctx, { filter, sort, page, pageSize }, result, cqlEnabled(org.settings));
    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}
