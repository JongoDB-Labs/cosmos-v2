import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { cqlEnabled } from "@/lib/query/flag";
import { fromWorkItemFilter } from "@/lib/query/adapters";
import { prepareCql } from "@/lib/query/execute.server";
import { cqlErrorResponse } from "@/lib/query/route.server";
import { CqlError } from "@/lib/query/errors";
import {
  canSee,
  fullyReadable,
  legacyFilterOf,
  storedQuery,
  viewerScope,
  visibilityProblem,
  visibleWhere,
} from "@/lib/query/saved-filters.server";
import { SAVED_VIEW_SELECT, toDto } from "@/lib/query/saved-filter-dto.server";
import { cfTypesFor, editorAccessProblem, editorProblem } from "@/lib/query/saved-filter-input.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const visibility = z.enum(["PRIVATE", "TEAM", "PROJECT", "ORG"]);

const createSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    /** CQL text (orgs with CQL on). */
    cql: z.string().max(4000).optional(),
    /** A CqlQuery as JSON (orgs with CQL on). */
    query: z.unknown().optional(),
    /** LEGACY: a WorkItemFilter, from the pre-CQL picker. */
    filter: z.record(z.string(), z.unknown()).optional(),
    visibility: visibility.optional(),
    projectId: z.uuid().nullish(),
    teamId: z.uuid().nullish(),
    editorIds: z.array(z.uuid()).max(50).optional(),
    /** LEGACY: true means visibility ORG. */
    shared: z.boolean().optional(),
  })
  .refine((b) => [b.cql !== undefined, b.query !== undefined, b.filter !== undefined].filter(Boolean).length === 1, {
    message: "Send exactly one of cql, query or filter.",
  });

/**
 * Saved filters (query design §10): named, reusable Issues queries.
 *
 * GET lists the filters the caller can see (their own, ones they co-edit, and
 * ones shared with a team, project or the org they belong to), with their
 * star; `?projectId=` narrows to the filters shared with that project. Orgs without CQL keep #1093's rule: a filter someone else shared that
 * names something the caller can't read isn't listed. With CQL it is listed,
 * and GET /saved-views/:id shows its text with those parts ‹restricted›.
 *
 * POST saves one. With CQL the query is validated and stored resolved (ids);
 * the legacy `filter` is written alongside while it can say the query.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);

    const s = await viewerScope(ctx);
    // `?projectId=`: the filters shared with that project (its "Filters" tab).
    const projectId = request.nextUrl.searchParams.get("projectId");
    // A project you can't read lists nothing, rather than confirming it exists
    // through a filter you co-edit.
    if (projectId && !s.readable.has(projectId)) return success([]);
    const rows = (
      await prisma.savedView.findMany({
        where: projectId ? { AND: [visibleWhere(s), { visibility: "PROJECT", projectId }] } : visibleWhere(s),
        orderBy: [{ name: "asc" }],
        take: 500,
        select: SAVED_VIEW_SELECT,
      })
    ).filter((v) => canSee(s, v));
    const readable = await fullyReadable(s, rows.map((v) => ({ id: v.id, q: storedQuery(v) })));
    const listed = cqlEnabled(org.settings) ? rows : rows.filter((v) => v.ownerId === ctx.userId || readable.has(v.id));

    const stars = await prisma.savedViewFavorite.findMany({
      where: { userId: ctx.userId, savedViewId: { in: listed.map((v) => v.id) } },
      select: { savedViewId: true, sortOrder: true },
    });
    const starOf = new Map(stars.map((f) => [f.savedViewId, f]));
    const cfTypes = await cfTypesFor(orgId);

    return success(
      listed.map((v) => {
        const dto = toDto(s, v, starOf.get(v.id), cfTypes);
        // Someone else's filter that names things you can't read: no legacy
        // `filter` either, since its ids are the very things withheld.
        return v.ownerId === ctx.userId || readable.has(v.id) ? dto : { ...dto, filter: {} };
      }),
    );
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
    // A saved view is the caller's own, but creating, deleting or starring one
    // is still a write: a key needs ITEM_UPDATE (items:write), as the contracted
    // saved-view writes do. A session keeps ITEM_READ.
    requirePermission(ctx, ctx.isApiKey ? Permission.ITEM_UPDATE : Permission.ITEM_READ);

    const data = createSchema.parse(await request.json());
    if ((data.cql !== undefined || data.query !== undefined) && !cqlEnabled(org.settings)) {
      return new Response(JSON.stringify({ error: "The query language isn't switched on for this organization." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const s = await viewerScope(ctx);

    const target = {
      visibility: data.visibility ?? (data.shared ? "ORG" : "PRIVATE"),
      projectId: data.projectId ?? null,
      teamId: data.teamId ?? null,
    } as const;
    const problem = (await visibilityProblem(s, target, { cql: cqlEnabled(org.settings) })) ?? (await editorProblem(orgId, data.editorIds));
    if (problem) {
      return new Response(JSON.stringify({ error: problem }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    const editorAccess = await editorAccessProblem(orgId, (data.editorIds ?? []).filter((u) => u !== ctx.userId), target);
    if (editorAccess) {
      return new Response(JSON.stringify({ error: editorAccess }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    // The query, validated against what the caller can see.
    let query: Prisma.InputJsonValue;
    let cqlText: string | null = null;
    const cfTypes = await cfTypesFor(orgId);
    try {
      if (data.filter !== undefined) {
        query = fromWorkItemFilter(data.filter) as unknown as Prisma.InputJsonValue;
      } else {
        const prepared = await prepareCql(ctx, data.cql !== undefined ? { cql: data.cql } : { query: data.query }, { mode: "strict" });
        query = prepared.query as unknown as Prisma.InputJsonValue;
        cqlText = data.cql ?? prepared.cql;
      }
    } catch (e) {
      if (e instanceof CqlError) return cqlErrorResponse(e);
      throw e;
    }

    // Name is unique per owner — surface a clean 409 instead of a raw P2002.
    const clash = await prisma.savedView.findFirst({
      where: { ownerId: ctx.userId, name: data.name },
      select: { id: true },
    });
    if (clash) {
      return new Response(
        JSON.stringify({ error: "You already have a saved filter with that name." }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const legacy = data.filter ?? legacyFilterOf(storedQuery({ query, filter: {} }), cfTypes);
    const view = await prisma.savedView.create({
      data: {
        orgId,
        ownerId: ctx.userId,
        name: data.name,
        description: data.description ?? "",
        filter: legacy as Prisma.InputJsonValue,
        query,
        cqlText,
        visibility: target.visibility,
        projectId: target.visibility === "PROJECT" ? target.projectId : null,
        teamId: target.visibility === "TEAM" ? target.teamId : null,
        shared: target.visibility === "ORG",
        editors: data.editorIds?.length ? { create: [...new Set(data.editorIds)].filter((u) => u !== ctx.userId).map((userId) => ({ userId })) } : undefined,
      },
      select: SAVED_VIEW_SELECT,
    });
    if (target.visibility === "ORG") {
      await logAudit({ orgId, userId: ctx.userId, action: "saved_filter.shared_org", entity: "saved_view", entityId: view.id, metadata: { name: view.name } });
    }

    return created(toDto(s, view, undefined, cfTypes));
  } catch (error) {
    return handleApiError(error);
  }
}
