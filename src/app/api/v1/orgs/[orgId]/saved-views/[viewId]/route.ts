import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { cqlEnabled } from "@/lib/query/flag";
import { fromWorkItemFilter } from "@/lib/query/adapters";
import { prepareCql } from "@/lib/query/execute.server";
import { CqlError } from "@/lib/query/errors";
import { cqlErrorResponse } from "@/lib/query/route.server";
import {
  canDelete,
  canEdit,
  canSee,
  legacyFilterOf,
  presentQuery,
  storedQuery,
  viewerScope,
  visibilityProblem,
  type ViewerScope,
} from "@/lib/query/saved-filters.server";
import { SAVED_VIEW_SELECT, toDto, type SavedViewRow } from "@/lib/query/saved-filter-dto.server";
import { cfTypesFor, editorAccessProblem, editorProblem } from "@/lib/query/saved-filter-input.server";

type RouteParams = { params: Promise<{ orgId: string; viewId: string }> };

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const patchSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  cql: z.string().max(4000).optional(),
  query: z.unknown().optional(),
  /** LEGACY: a WorkItemFilter. */
  filter: z.record(z.string(), z.unknown()).optional(),
  visibility: z.enum(["PRIVATE", "TEAM", "PROJECT", "ORG"]).optional(),
  projectId: z.uuid().nullish(),
  teamId: z.uuid().nullish(),
  editorIds: z.array(z.uuid()).max(50).optional(),
  /** Org administrators only: hand the filter to another member (its owner left). */
  ownerId: z.uuid().optional(),
  /** LEGACY: true means visibility ORG, false PRIVATE. */
  shared: z.boolean().optional(),
});

/**
 * Load a filter the caller can see. Not found and not visible are the same
 * 404, so an id says nothing about a filter you can't see.
 */
async function load(orgId: string, viewId: string): Promise<{ error: Response } | { s: ViewerScope; view: SavedViewRow; org: { settings: unknown } }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ITEM_READ);

  const view = await prisma.savedView.findFirst({ where: { id: viewId, orgId }, select: SAVED_VIEW_SELECT });
  const s = await viewerScope(ctx);
  // Administrators manage every filter (change owner when someone leaves),
  // so they can load any; everyone else only what they can see. s.isAdmin, not
  // the raw role: an admin's API key counts as one only when its scopes would
  // grant FILTER_SHARE_ORG (none do), so it can't read others' private filters.
  if (!view || (!canSee(s, view) && !s.isAdmin)) {
    return { error: new Response("Not found", { status: 404 }) };
  }
  return { s, view, org };
}

/**
 * GET one filter, with its query printed for the caller: what they can't read
 * prints as ‹restricted›, and `partiallyRestricted` says so. Such a filter is
 * still run by id (`?filter=` on search), which narrows to what they can see.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const r = await load(orgId, viewId);
    if ("error" in r) return r.error;
    const star = await prisma.savedViewFavorite.findUnique({
      where: { savedViewId_userId: { savedViewId: viewId, userId: r.s.ctx.userId } },
      select: { sortOrder: true },
    });
    const presented = await presentQuery(r.s, storedQuery(r.view));
    const dto = toDto(r.s, r.view, star ?? undefined, await cfTypesFor(orgId));
    // The legacy `filter` carries raw ids, including the ones withheld.
    return success({
      ...dto,
      ...(presented.partiallyRestricted ? { filter: {} } : {}),
      ...presented,
      partiallyRestricted: presented.partiallyRestricted || dto.partiallyRestricted,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

async function update(request: NextRequest, { params }: RouteParams) {
  const { orgId, viewId } = await params;
  const r = await load(orgId, viewId);
  if ("error" in r) return r.error;
  const { s, view } = r;
  // Editing is a write: a key needs ITEM_UPDATE (items:write) on top of the
  // ITEM_READ load() checks, like DELETE below and the contracted writes.
  if (!hasPermission(s.ctx.permissions, s.ctx.isApiKey ? Permission.ITEM_UPDATE : Permission.ITEM_READ)) {
    return json({ error: "Changing a saved filter needs the items:write scope." }, 403);
  }
  const data = patchSchema.parse(await request.json());

  if (!canEdit(s, view)) return json({ error: "Only the owner, its editors or an administrator can change this filter." }, 403);
  const ownerish = view.ownerId === s.ctx.userId || s.isAdmin;
  const changingAccess = data.visibility !== undefined || data.shared !== undefined || data.projectId !== undefined || data.teamId !== undefined || data.editorIds !== undefined;
  if (changingAccess && !ownerish) return json({ error: "Only the owner or an administrator can change who sees or edits this filter." }, 403);
  if (data.ownerId !== undefined && !s.isAdmin) return json({ error: "Only an administrator can change a filter's owner." }, 403);

  const patch: Prisma.SavedViewUpdateInput = {};
  const audits: { action: string; metadata: Prisma.InputJsonObject }[] = [];
  if (data.name !== undefined && data.name !== view.name) {
    const clash = await prisma.savedView.findFirst({
      where: { ownerId: data.ownerId ?? view.ownerId, name: data.name, id: { not: viewId } },
      select: { id: true },
    });
    if (clash) return json({ error: "A saved filter with that name already exists." }, 409);
    patch.name = data.name;
  }
  if (data.description !== undefined) patch.description = data.description;

  const cfTypes = await cfTypesFor(orgId);
  if (data.cql !== undefined || data.query !== undefined || data.filter !== undefined) {
    // Overwriting a query you can only partly see would silently drop the
    // parts you can't: save a copy instead.
    const presented = await presentQuery(s, storedQuery(view));
    if (presented.partiallyRestricted) {
      return json({ error: "Parts of this filter refer to things you can't see, so it can't be overwritten. Save it as a new filter instead." }, 409);
    }
    if ((data.cql !== undefined || data.query !== undefined) && !cqlEnabled(r.org.settings)) {
      return json({ error: "The query language isn't switched on for this organization." }, 400);
    }
    try {
      if (data.filter !== undefined) {
        patch.query = fromWorkItemFilter(data.filter) as unknown as Prisma.InputJsonValue;
        patch.filter = data.filter as Prisma.InputJsonValue;
        patch.cqlText = null;
      } else {
        const prepared = await prepareCql(s.ctx, data.cql !== undefined ? { cql: data.cql } : { query: data.query }, { mode: "strict" });
        patch.query = prepared.query as unknown as Prisma.InputJsonValue;
        patch.cqlText = data.cql ?? prepared.cql;
        patch.filter = legacyFilterOf(prepared.query, cfTypes) as Prisma.InputJsonValue;
      }
    } catch (e) {
      if (e instanceof CqlError) return cqlErrorResponse(e);
      throw e;
    }
  }

  if (changingAccess) {
    const visibility = data.visibility ?? (data.shared === undefined ? view.visibility : data.shared ? "ORG" : "PRIVATE");
    const target = {
      visibility,
      projectId: data.projectId !== undefined ? data.projectId : view.projectId,
      teamId: data.teamId !== undefined ? data.teamId : view.teamId,
    };
    // Re-checked only when it changes: an administrator tidying names must
    // not need FILTER_SHARE_ORG for a filter someone else already shared.
    const moved = visibility !== view.visibility || target.projectId !== view.projectId || target.teamId !== view.teamId;
    const problem = (moved ? await visibilityProblem(s, target, { cql: cqlEnabled(r.org.settings) }) : null) ?? (await editorProblem(orgId, data.editorIds));
    if (problem) return json({ error: problem }, 403);
    // The editors the filter will have, checked against where it will point:
    // a move re-checks the existing ones too.
    if (moved || data.editorIds !== undefined) {
      const owner = data.ownerId ?? view.ownerId;
      const editors = (data.editorIds ?? view.editors.map((e) => e.userId)).filter((u) => u !== owner);
      const editorAccess = await editorAccessProblem(orgId, editors, target);
      if (editorAccess) return json({ error: editorAccess }, 400);
    }
    patch.visibility = visibility;
    patch.shared = visibility === "ORG";
    patch.project = visibility === "PROJECT" && target.projectId ? { connect: { id: target.projectId } } : { disconnect: true };
    patch.team = visibility === "TEAM" && target.teamId ? { connect: { id: target.teamId } } : { disconnect: true };
    if (data.editorIds !== undefined) {
      const owner = data.ownerId ?? view.ownerId;
      patch.editors = { deleteMany: {}, create: [...new Set(data.editorIds)].filter((u) => u !== owner).map((userId) => ({ userId })) };
    }
    if (moved && visibility === "ORG") {
      audits.push({ action: "saved_filter.shared_org", metadata: { name: view.name } });
    }
  }

  if (data.ownerId !== undefined && data.ownerId !== view.ownerId) {
    const member = await prisma.orgMember.findFirst({ where: { orgId, userId: data.ownerId }, select: { id: true } });
    if (!member) return json({ error: "The new owner must be a member of this organization." }, 400);
    const clash = await prisma.savedView.findFirst({ where: { ownerId: data.ownerId, name: data.name ?? view.name }, select: { id: true } });
    if (clash) return json({ error: "The new owner already has a saved filter with that name." }, 409);
    patch.owner = { connect: { id: data.ownerId } };
    audits.push({ action: "saved_filter.owner_changed", metadata: { from: view.ownerId, to: data.ownerId } });
  }

  const updated = await prisma.savedView.update({ where: { id: viewId }, data: patch, select: SAVED_VIEW_SELECT });
  // Recorded once the change has happened, not for an update that then failed.
  for (const a of audits) await logAudit({ orgId, userId: s.ctx.userId, entity: "saved_view", entityId: viewId, ...a });
  const star = await prisma.savedViewFavorite.findUnique({
    where: { savedViewId_userId: { savedViewId: viewId, userId: s.ctx.userId } },
    select: { sortOrder: true },
  });
  return success(toDto(s, updated, star ?? undefined, cfTypes));
}

export async function PATCH(request: NextRequest, ctx: RouteParams) {
  try {
    return await update(request, ctx);
  } catch (error) {
    return handleApiError(error);
  }
}

/** LEGACY (one release): the pre-CQL picker's PUT { name?, filter?, shared? }. */
export async function PUT(request: NextRequest, ctx: RouteParams) {
  try {
    return await update(request, ctx);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const r = await load(orgId, viewId);
    if ("error" in r) return r.error;
    // Deleting is a write: a key needs ITEM_UPDATE (items:write) on top of the
    // ITEM_READ load() checks, as the contracted saved-view writes do.
    if (!hasPermission(r.s.ctx.permissions, r.s.ctx.isApiKey ? Permission.ITEM_UPDATE : Permission.ITEM_READ)) {
      return json({ error: "Deleting a saved filter needs the items:write scope." }, 403);
    }
    if (!canDelete(r.s, r.view)) return json({ error: "Only the owner or an administrator can delete this filter." }, 403);
    await prisma.savedView.delete({ where: { id: viewId } });
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
