/**
 * Saved filters (query design §10) as ONE set of gates and writes, called by the
 * HTTP routes under `/orgs/[orgId]/saved-views` AND by the assistant's tools.
 *
 * These functions are the routes' bodies, moved here unchanged. The routes keep
 * only what is theirs (finding the org, authenticating the request) and turn
 * what these throw back into the exact responses they always sent. The
 * assistant calls the same functions with the caller's own AuthContext, so a
 * rule changed here is changed for both — the alternative, a second copy of
 * these checks in `lib/ai/executors`, is how the assistant has twice kept a
 * rule the API had already fixed (see `lib/ai/executors/_ctx.ts`).
 *
 * Refusals are thrown, in three shapes, so each route answers exactly as it did:
 *   - `SavedViewNotFound` → the plain-text 404 "Not found" (not found and not
 *     visible read the same, so an id says nothing about a filter you can't see);
 *   - `SavedViewRefusal`  → `{ error }` JSON with its status (403, 400, 409);
 *   - `SavedViewCqlError` → the query language's own `{ error: { code, … } }` body.
 * `requirePermission` still throws `ForbiddenError`, and a body that fails its
 * schema still throws `ZodError`, both answered by `handleApiError` as before.
 *
 * Writes take the body as `readBody`, read only once the caller has passed the
 * checks that came before it in the route — a malformed body from someone who
 * may not write is still refused as a refusal, not as malformed JSON.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requirePermission, NotFoundError, type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { logAudit } from "@/lib/audit";
import { ProblemError } from "@/lib/openapi/problem";
import type { ProblemCode } from "@/lib/openapi/problem-codes";
import { cqlEnabled } from "./flag";
import { fromWorkItemFilter } from "./adapters";
import { prepareCql } from "./execute.server";
import { CqlError } from "./errors";
import {
  canDelete,
  canEdit,
  canSee,
  fullyReadable,
  legacyFilterOf,
  presentQuery,
  storedQuery,
  viewerScope,
  visibilityProblem,
  visibleWhere,
  type ViewerScope,
} from "./saved-filters.server";
import { SAVED_VIEW_SELECT, toDto, type SavedFilterDto, type SavedViewRow } from "./saved-filter-dto.server";
import { cfTypesFor, editorAccessProblem, editorProblem } from "./saved-filter-input.server";

/** The org a saved-view call runs in: its id and its settings (the CQL switch). */
export interface SavedViewOrg {
  id: string;
  settings: unknown;
}

const CODE_FOR: Record<number, ProblemCode> = {
  400: "invalid_request",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
};

/** A refusal the routes answer as `{ error }` JSON with this status. */
export class SavedViewRefusal extends ProblemError {
  constructor(status: 400 | 403 | 409, message: string) {
    super(status, CODE_FOR[status], message);
    this.name = "SavedViewRefusal";
  }
}

/** A filter that does not exist or that the caller may not see — the same answer. */
export class SavedViewNotFound extends NotFoundError {
  constructor() {
    super("Not found");
    this.name = "SavedViewNotFound";
  }
}

/**
 * The query was rejected by the query language. Carries the original so the
 * route can answer with its diagnostics, and so a tool can hand them to the
 * model to correct the query.
 */
export class SavedViewCqlError extends Error {
  constructor(readonly cqlError: CqlError) {
    super(cqlError.message);
    this.name = "SavedViewCqlError";
  }
}

const visibility = z.enum(["PRIVATE", "TEAM", "PROJECT", "ORG"]);

export const createSavedViewSchema = z
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

export const patchSavedViewSchema = z.strictObject({
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
 * Run the step that turns the body into a stored query, marking a rejection by
 * the query language as the query's own fault (the routes answer it with its
 * diagnostics). Only this step: a CqlError from anywhere else is not one.
 */
async function rejectingCql<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CqlError) throw new SavedViewCqlError(e);
    throw e;
  }
}

/**
 * The filters the caller can see (their own, ones they co-edit, and ones shared
 * with a team, project or the org they belong to), with their star;
 * `projectId` narrows to the filters shared with that project. Orgs without CQL
 * keep #1093's rule: a filter someone else shared that names something the
 * caller can't read isn't listed.
 */
export async function listSavedViews(
  ctx: AuthContext,
  org: SavedViewOrg,
  opts: { projectId?: string | null } = {},
): Promise<SavedFilterDto[]> {
  requirePermission(ctx, Permission.ITEM_READ);

  const s = await viewerScope(ctx);
  const projectId = opts.projectId ?? null;
  // A project you can't read lists nothing, rather than confirming it exists
  // through a filter you co-edit.
  if (projectId && !s.readable.has(projectId)) return [];
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
  const cfTypes = await cfTypesFor(org.id);

  return listed.map((v) => {
    const dto = toDto(s, v, starOf.get(v.id), cfTypes);
    // Someone else's filter that names things you can't read: no legacy
    // `filter` either, since its ids are the very things withheld.
    return v.ownerId === ctx.userId || readable.has(v.id) ? dto : { ...dto, filter: {} };
  });
}

/**
 * Save a filter. With CQL the query is validated and stored resolved (ids);
 * the legacy `filter` is written alongside while it can say the query.
 */
export async function createSavedView(ctx: AuthContext, org: SavedViewOrg, readBody: () => Promise<unknown>): Promise<SavedFilterDto> {
  const orgId = org.id;
  // A saved view is the caller's own, but creating, deleting or starring one
  // is still a write: a key needs ITEM_UPDATE (items:write), as the contracted
  // saved-view writes do. A session keeps ITEM_READ.
  requirePermission(ctx, ctx.isApiKey ? Permission.ITEM_UPDATE : Permission.ITEM_READ);

  const data = createSavedViewSchema.parse(await readBody());
  if ((data.cql !== undefined || data.query !== undefined) && !cqlEnabled(org.settings)) {
    throw new SavedViewRefusal(400, "The query language isn't switched on for this organization.");
  }
  const s = await viewerScope(ctx);

  const target = {
    visibility: data.visibility ?? (data.shared ? "ORG" : "PRIVATE"),
    projectId: data.projectId ?? null,
    teamId: data.teamId ?? null,
  } as const;
  const problem = (await visibilityProblem(s, target, { cql: cqlEnabled(org.settings) })) ?? (await editorProblem(orgId, data.editorIds));
  if (problem) throw new SavedViewRefusal(403, problem);
  const editorAccess = await editorAccessProblem(orgId, (data.editorIds ?? []).filter((u) => u !== ctx.userId), target);
  if (editorAccess) throw new SavedViewRefusal(400, editorAccess);

  // The query, validated against what the caller can see.
  const cfTypes = await cfTypesFor(orgId);
  const { query, cqlText } = await rejectingCql(async (): Promise<{ query: Prisma.InputJsonValue; cqlText: string | null }> => {
    if (data.filter !== undefined) {
      return { query: fromWorkItemFilter(data.filter) as unknown as Prisma.InputJsonValue, cqlText: null };
    }
    const prepared = await prepareCql(ctx, data.cql !== undefined ? { cql: data.cql } : { query: data.query }, { mode: "strict" });
    return { query: prepared.query as unknown as Prisma.InputJsonValue, cqlText: data.cql ?? prepared.cql };
  });

  // Name is unique per owner — surface a clean 409 instead of a raw P2002.
  const clash = await prisma.savedView.findFirst({
    where: { ownerId: ctx.userId, name: data.name },
    select: { id: true },
  });
  if (clash) throw new SavedViewRefusal(409, "You already have a saved filter with that name.");

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

  return toDto(s, view, undefined, cfTypes);
}

/**
 * Load a filter the caller can see. Not found and not visible are the same
 * 404, so an id says nothing about a filter you can't see.
 */
export async function loadSavedView(ctx: AuthContext, orgId: string, viewId: string): Promise<{ s: ViewerScope; view: SavedViewRow }> {
  requirePermission(ctx, Permission.ITEM_READ);

  const view = await prisma.savedView.findFirst({ where: { id: viewId, orgId }, select: SAVED_VIEW_SELECT });
  const s = await viewerScope(ctx);
  // Administrators manage every filter (change owner when someone leaves),
  // so they can load any; everyone else only what they can see. s.isAdmin, not
  // the raw role: an admin's API key counts as one only when its scopes would
  // grant FILTER_SHARE_ORG (none do), so it can't read others' private filters.
  if (!view || (!canSee(s, view) && !s.isAdmin)) throw new SavedViewNotFound();
  return { s, view };
}

/**
 * One filter, with its query printed for the caller: what they can't read
 * prints as ‹restricted›, and `partiallyRestricted` says so. Such a filter is
 * still run by id (`?filter=` on search), which narrows to what they can see.
 */
export async function getSavedView(ctx: AuthContext, org: SavedViewOrg, viewId: string) {
  const { s, view } = await loadSavedView(ctx, org.id, viewId);
  const star = await prisma.savedViewFavorite.findUnique({
    where: { savedViewId_userId: { savedViewId: viewId, userId: s.ctx.userId } },
    select: { sortOrder: true },
  });
  const presented = await presentQuery(s, storedQuery(view));
  const dto = toDto(s, view, star ?? undefined, await cfTypesFor(org.id));
  // The legacy `filter` carries raw ids, including the ones withheld.
  return {
    ...dto,
    ...(presented.partiallyRestricted ? { filter: {} } : {}),
    ...presented,
    partiallyRestricted: presented.partiallyRestricted || dto.partiallyRestricted,
  };
}

/** Change a filter: its name, description, query, who sees it, its editors or its owner. */
export async function updateSavedView(
  ctx: AuthContext,
  org: SavedViewOrg,
  viewId: string,
  readBody: () => Promise<unknown>,
): Promise<SavedFilterDto> {
  const orgId = org.id;
  const { s, view } = await loadSavedView(ctx, orgId, viewId);
  // Editing is a write: a key needs ITEM_UPDATE (items:write) on top of the
  // ITEM_READ the load checks, like DELETE below and the contracted writes.
  if (!hasPermission(s.ctx.permissions, s.ctx.isApiKey ? Permission.ITEM_UPDATE : Permission.ITEM_READ)) {
    throw new SavedViewRefusal(403, "Changing a saved filter needs the items:write scope.");
  }
  const data = patchSavedViewSchema.parse(await readBody());

  if (!canEdit(s, view)) throw new SavedViewRefusal(403, "Only the owner, its editors or an administrator can change this filter.");
  const ownerish = view.ownerId === s.ctx.userId || s.isAdmin;
  const changingAccess = data.visibility !== undefined || data.shared !== undefined || data.projectId !== undefined || data.teamId !== undefined || data.editorIds !== undefined;
  if (changingAccess && !ownerish) throw new SavedViewRefusal(403, "Only the owner or an administrator can change who sees or edits this filter.");
  if (data.ownerId !== undefined && !s.isAdmin) throw new SavedViewRefusal(403, "Only an administrator can change a filter's owner.");

  const patch: Prisma.SavedViewUpdateInput = {};
  const audits: { action: string; metadata: Prisma.InputJsonObject }[] = [];
  if (data.name !== undefined && data.name !== view.name) {
    const clash = await prisma.savedView.findFirst({
      where: { ownerId: data.ownerId ?? view.ownerId, name: data.name, id: { not: viewId } },
      select: { id: true },
    });
    if (clash) throw new SavedViewRefusal(409, "A saved filter with that name already exists.");
    patch.name = data.name;
  }
  if (data.description !== undefined) patch.description = data.description;

  const cfTypes = await cfTypesFor(orgId);
  if (data.cql !== undefined || data.query !== undefined || data.filter !== undefined) {
    // Overwriting a query you can only partly see would silently drop the
    // parts you can't: save a copy instead.
    const presented = await presentQuery(s, storedQuery(view));
    if (presented.partiallyRestricted) {
      throw new SavedViewRefusal(409, "Parts of this filter refer to things you can't see, so it can't be overwritten. Save it as a new filter instead.");
    }
    if ((data.cql !== undefined || data.query !== undefined) && !cqlEnabled(org.settings)) {
      throw new SavedViewRefusal(400, "The query language isn't switched on for this organization.");
    }
    await rejectingCql(async () => {
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
    });
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
    const problem = (moved ? await visibilityProblem(s, target, { cql: cqlEnabled(org.settings) }) : null) ?? (await editorProblem(orgId, data.editorIds));
    if (problem) throw new SavedViewRefusal(403, problem);
    // The editors the filter will have, checked against where it will point:
    // a move re-checks the existing ones too.
    if (moved || data.editorIds !== undefined) {
      const owner = data.ownerId ?? view.ownerId;
      const editors = (data.editorIds ?? view.editors.map((e) => e.userId)).filter((u) => u !== owner);
      const editorAccess = await editorAccessProblem(orgId, editors, target);
      if (editorAccess) throw new SavedViewRefusal(400, editorAccess);
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
    if (!member) throw new SavedViewRefusal(400, "The new owner must be a member of this organization.");
    const clash = await prisma.savedView.findFirst({ where: { ownerId: data.ownerId, name: data.name ?? view.name }, select: { id: true } });
    if (clash) throw new SavedViewRefusal(409, "The new owner already has a saved filter with that name.");
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
  return toDto(s, updated, star ?? undefined, cfTypes);
}

/** Delete a filter: its owner or an administrator. Returns the deleted filter's id and name. */
export async function deleteSavedView(ctx: AuthContext, org: SavedViewOrg, viewId: string): Promise<{ id: string; name: string }> {
  const { s, view } = await loadSavedView(ctx, org.id, viewId);
  // Deleting is a write: a key needs ITEM_UPDATE (items:write) on top of the
  // ITEM_READ the load checks, as the contracted saved-view writes do.
  if (!hasPermission(s.ctx.permissions, s.ctx.isApiKey ? Permission.ITEM_UPDATE : Permission.ITEM_READ)) {
    throw new SavedViewRefusal(403, "Deleting a saved filter needs the items:write scope.");
  }
  if (!canDelete(s, view)) throw new SavedViewRefusal(403, "Only the owner or an administrator can delete this filter.");
  await prisma.savedView.delete({ where: { id: viewId } });
  return { id: view.id, name: view.name };
}
