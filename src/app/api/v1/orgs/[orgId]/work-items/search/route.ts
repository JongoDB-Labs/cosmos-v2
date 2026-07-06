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
} from "@/lib/work-items/query";

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
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Org-level read gate: the raw bit only (see route doc). Per-project
    // narrowing — including any in_project ITEM_READ deny — happens in
    // getReadableProjectIds below.
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return new Response("Forbidden", { status: 403 });
    }

    const allowedProjectIds = await getReadableProjectIds(ctx);
    if (allowedProjectIds.length === 0) return success(EMPTY_RESULT);

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

    const result = await runWorkItemQuery({
      orgId,
      allowedProjectIds,
      filter,
      sort,
      page,
      pageSize,
    });
    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}
