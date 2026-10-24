import { NextRequest } from "next/server";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import {
  getReadableProjectIds,
  parseSearchParams,
  runWorkItemQuery,
  unknownQueryParams,
} from "@/lib/work-items/query";
import { cqlEnabled } from "@/lib/query/flag";
import { executeCql } from "@/lib/query/execute.server";
import { savedFilterQuery } from "@/lib/query/saved-filters.server";
import { cqlErrorResponse, cqlTooLong } from "@/lib/query/route.server";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { scheduleParity } from "@/lib/query/parity.server";
import { searchWorkItems, searchWorkItemsByFilter } from "./route.contract";
import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import type { z } from "zod";
import type { WorkItemSearchPage } from "@/lib/openapi/schemas/work-item-query";

type RouteParams = { params: Promise<{ orgId: string }> };

type WorkItemSearchResult = z.input<typeof WorkItemSearchPage>;

const EMPTY_RESULT: WorkItemSearchResult = { data: [], total: 0 };

/** `?cql=` / `?filter=` may only come with these. */
const CQL_PARAMS = ["cql", "tz", "page", "pageSize", "filter"];

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
 * 400). Answers { data, total, totalCapped, cql, diagnostics }. The query
 * language is per-org and not yet in the public contract: its parameters are
 * undocumented there, and its errors keep their own `{ error: { code,
 * diagnostics } }` body, which the query editor reads.
 *
 * Every legacy search is also, on a sample and after the response, re-run
 * through CQL and compared (lib/query/parity.server.ts) before cut-over.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await orgContext((await params).orgId, searchWorkItems);
    const { params: { orgId } } = await parseRequest(searchWorkItems, request, params);
    const result = await searchByParams(request, org, ctx, orgId);
    return result instanceof Response ? result : respond(searchWorkItems, 200, result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * The GET search after the contract's prelude, shared with the bare collection
 * path (`GET /work-items`), which answers the same. A page to `respond` with,
 * or a finished error response.
 */
export async function searchByParams(
  request: NextRequest,
  org: { settings: Prisma.JsonValue },
  ctx: AuthContext,
  orgId: string,
): Promise<Response | WorkItemSearchResult> {
  const sp = request.nextUrl.searchParams;
  const cqlOn = cqlEnabled(org.settings);
  // `?cql=` on an org without the query language: that parameter doesn't
  // exist there, the same 404 as the other CQL routes (not "unknown param").
  if (!cqlOn && sp.has("cql")) return problem(404, "not_found", undefined, { request });

  // Org-level read gate: the raw bit only (see route doc). Per-project
  // narrowing — including any in_project ITEM_READ deny — happens in
  // getReadableProjectIds below.
  if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
    return problem(403, "forbidden", undefined, { request });
  }

  const cql = cqlOn ? sp.get("cql") : null;
  // `?filter=<savedFilterId>` runs a saved filter's stored query; with `cql`
  // too, the text wins (the filter id only says which one was loaded).
  const filterId = cqlOn ? sp.get("filter") : null;
  if (cql !== null || filterId !== null) {
    const others = [...new Set(sp.keys())].filter((k) => !CQL_PARAMS.includes(k));
    if (others.length > 0) {
      return problem(400, "invalid_request", "`cql` replaces the other filter parameters", {
        request,
        issues: [{ code: "unrecognized_keys", keys: others, path: [], message: "`cql` replaces the other filter parameters" }],
      });
    }
    if (cql !== null) {
      const tooLong = cqlTooLong(cql);
      if (tooLong) return tooLong;
    }
    // The same budget as POST work-items/query: one query is one query.
    const limited = checkRateLimit(request, "cql.query", ctx.userId, { capacity: 30, refillPerSecond: 3 });
    if (limited) return limited;
    const stored = cql === null ? await savedFilterQuery(ctx, filterId!) : null;
    if (cql === null && !stored) return problem(404, "not_found", "Saved filter not found", { request });
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
      return { data: r.data, total: r.total, totalCapped: r.totalCapped, cql: r.cql, diagnostics: r.diagnostics };
    } catch (e) {
      return cqlErrorResponse(e);
    }
  }

  // Reject parameters nothing will read, rather than answering as if they
  // had been applied. A filter that silently does not filter returns
  // plausible WRONG answers, which costs the caller more than an error.
  const unknown = unknownQueryParams(sp, ["watchedByMe"]);
  if (unknown.length > 0) {
    return problem(400, "invalid_request", "Unknown query parameter", {
      request,
      issues: [{
        code: "unrecognized_keys",
        keys: unknown,
        path: [],
        message:
          "Unrecognised parameters are not applied, so this request would have "
          + "returned an unfiltered page. Check the spelling against the supported filters.",
      }],
    });
  }

  const allowedProjectIds = await getReadableProjectIds(ctx);
  if (allowedProjectIds.length === 0) return EMPTY_RESULT;

  const { filter, sort, page, pageSize } = parseSearchParams(sp);
  // "Watching" filter (FR 8702c9b8) — resolve the sentinel to the caller's id
  // here so the where-builder stays pure.
  if (sp.get("watchedByMe")) {
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
  scheduleParity(ctx, { filter, sort, page, pageSize }, result, cqlOn);
  return result;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await orgContext((await params).orgId, searchWorkItemsByFilter);
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return problem(403, "forbidden", undefined, { request });
    }

    const allowedProjectIds = await getReadableProjectIds(ctx);
    if (allowedProjectIds.length === 0) return respond(searchWorkItemsByFilter, 200, EMPTY_RESULT);

    const { params: { orgId }, body: { filter, sort, page, pageSize } } = await parseRequest(searchWorkItemsByFilter, request, params);
    // A watch list is personal: the GET twin only ever resolves `watchedByMe`
    // to the caller, so the POST may name the caller and nobody else.
    if (filter.watchedByUserId && filter.watchedByUserId !== ctx.userId) {
      return problem(400, "invalid_request", "filter.watchedByUserId may only be your own user id", { request });
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
    return respond(searchWorkItemsByFilter, 200, result);
  } catch (error) {
    return handleApiError(error);
  }
}
