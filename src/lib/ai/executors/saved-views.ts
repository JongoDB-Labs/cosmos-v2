import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import * as service from "@/lib/query/saved-view-service.server";
import type { SavedFilterDto } from "@/lib/query/saved-filter-dto.server";
import { diagnosticsForModel } from "./cql";
import { assertPermission, assertProjectRead, loadAuthContext, serviceRefusal, type ToolContext } from "./_ctx";

/**
 * Saved filters (query design §10) for the assistant. Every gate and write is
 * the saved-views API's own (`lib/query/saved-view-service.server.ts`), called
 * with the caller's AuthContext: who may see a filter, edit it, share it (ORG
 * needs FILTER_SHARE_ORG) or delete it is decided there, once, for both doors.
 * What these add is the agent's own contract: a pre-parse permission check, a
 * named project checked for access before anything else reads it, and the
 * service's refusals turned into `{ error }` in the API's own words.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

/**
 * A refusal from the shared service, as the tool's answer. A rejected query
 * carries its diagnostics so the model can fix it; anything that is not a
 * refusal is rethrown, to be reported as the internal failure it is.
 */
function refused(e: unknown): { error: string; diagnostics?: ReturnType<typeof diagnosticsForModel> } {
  if (e instanceof service.SavedViewCqlError) {
    return { error: `${e.message} Fix the query and try again.`, diagnostics: diagnosticsForModel(e.cqlError.diagnostics) };
  }
  const refusal = serviceRefusal(e);
  if (refusal) return refusal;
  throw e;
}

async function orgOf(ctx: ToolContext) {
  return prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { id: true, slug: true, settings: true } });
}

/**
 * A filter for the model: ids and enums at the top level, where the egress
 * projection can keep them. Where it is shared is named only when the caller
 * can read that project (`toDto` already nulls it otherwise).
 */
function viewForModel(v: SavedFilterDto, slug: string) {
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    visibility: v.visibility,
    projectId: v.project?.id ?? null,
    projectKey: v.project?.key ?? null,
    teamId: v.team?.id ?? null,
    teamName: v.team?.name ?? null,
    ownerId: v.ownerId,
    ownerName: v.ownerName,
    mine: v.mine,
    canEdit: v.canEdit,
    canDelete: v.canDelete,
    favorite: v.favorite,
    partiallyRestricted: v.partiallyRestricted,
    updatedAt: v.updatedAt,
    url: `/${slug}/work-items?filter=${v.id}`,
  };
}

const visibility = z.enum(["PRIVATE", "TEAM", "PROJECT", "ORG"]);

// ── list_saved_views ────────────────────────────────────────────────────────
const listSchema = z.object({ projectId: z.string().uuid().optional() });

export async function listSavedViews(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId } = parsed.data;
  if (projectId) {
    const outOfScope = await assertProjectRead(ctx, projectId, "ITEM_READ");
    if (outOfScope) return outOfScope;
  }
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const org = await orgOf(ctx);
  if (!org) return { error: "Organization not found" };

  try {
    const views = await service.listSavedViews(auth, org, { projectId });
    return { count: views.length, views: views.map((v) => viewForModel(v, org.slug)) };
  } catch (e) {
    return refused(e);
  }
}

// ── create_saved_view ───────────────────────────────────────────────────────
// Cosmo saves a filter private. Sharing it is share_saved_view, which waits for
// the user's yes (confirm-class), so a create must not share without one. A
// visibility the model sends anyway is read only to say what was not done.
const createSchema = z.object({
  name: z.string(),
  cql: z.string(),
  description: z.string().optional(),
  visibility: visibility.optional(),
});

export async function createSavedView(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const org = await orgOf(ctx);
  if (!org) return { error: "Organization not found" };

  const { visibility: asked, ...fields } = parsed.data;
  try {
    // Lengths are the service's to check.
    const view = await service.createSavedView(auth, org, async () => ({ ...fields, visibility: "PRIVATE" }));
    return {
      created: true,
      ...viewForModel(view, org.slug),
      // Enums at the top level, so the model learns this even where results are withheld.
      ...(asked !== undefined && asked !== "PRIVATE" && {
        requestedVisibility: asked,
        nextStep: "share_saved_view",
        note: "Saved as private. Sharing it is a separate step the user confirms: call share_saved_view with this id.",
      }),
    };
  } catch (e) {
    return refused(e);
  }
}

// ── update_saved_view ───────────────────────────────────────────────────────
const updateSchema = z
  .object({
    viewId: z.string().uuid(),
    name: z.string().optional(),
    description: z.string().optional(),
    cql: z.string().optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined || b.cql !== undefined, {
    message: "Send at least one of name, description or cql.",
  });

export async function updateSavedView(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const org = await orgOf(ctx);
  if (!org) return { error: "Organization not found" };

  const { viewId, ...changes } = parsed.data;
  try {
    const view = await service.updateSavedView(auth, org, viewId, async () => changes);
    return { updated: true, ...viewForModel(view, org.slug) };
  } catch (e) {
    return refused(e);
  }
}

// ── share_saved_view ────────────────────────────────────────────────────────
const shareSchema = z.object({
  viewId: z.string().uuid(),
  visibility,
  projectId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
});

export async function shareSavedView(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;
  const parsed = shareSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  if (parsed.data.projectId) {
    const outOfScope = await assertProjectRead(ctx, parsed.data.projectId, "ITEM_READ");
    if (outOfScope) return outOfScope;
  }
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const org = await orgOf(ctx);
  if (!org) return { error: "Organization not found" };

  const { viewId, ...access } = parsed.data;
  try {
    const view = await service.updateSavedView(auth, org, viewId, async () => access);
    return { shared: true, ...viewForModel(view, org.slug) };
  } catch (e) {
    return refused(e);
  }
}

// ── delete_saved_view ───────────────────────────────────────────────────────
const deleteSchema = z.object({ viewId: z.string().uuid() });

export async function deleteSavedView(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const org = await orgOf(ctx);
  if (!org) return { error: "Organization not found" };

  try {
    const view = await service.deleteSavedView(auth, org, parsed.data.viewId);
    return { deleted: true, id: view.id, name: view.name };
  } catch (e) {
    return refused(e);
  }
}
