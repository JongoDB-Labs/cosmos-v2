import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, noContent } from "@/lib/api-helpers";
import { deleteSavedView, getSavedView, updateSavedView } from "@/lib/query/saved-view-service.server";
import { savedViewErrorResponse } from "@/lib/query/saved-view-response.server";
import type { AuthContext } from "@/lib/rbac/check";

type RouteParams = { params: Promise<{ orgId: string; viewId: string }> };

/**
 * The org and the signed-in caller. The gates past these — the filter exists
 * and the caller may see it, then what they may change — live in
 * `saved-view-service.server.ts`, shared with the assistant's saved-view tools.
 */
async function authenticate(orgId: string): Promise<{ error: Response } | { ctx: AuthContext; org: { id: string; settings: unknown } }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  return { ctx, org };
}

/**
 * GET one filter, with its query printed for the caller: what they can't read
 * prints as ‹restricted›, and `partiallyRestricted` says so. Such a filter is
 * still run by id (`?filter=` on search), which narrows to what they can see.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const r = await authenticate(orgId);
    if ("error" in r) return r.error;
    return success(await getSavedView(r.ctx, r.org, viewId));
  } catch (error) {
    return savedViewErrorResponse(error);
  }
}

async function update(request: NextRequest, { params }: RouteParams) {
  const { orgId, viewId } = await params;
  const r = await authenticate(orgId);
  if ("error" in r) return r.error;
  return success(await updateSavedView(r.ctx, r.org, viewId, () => request.json()));
}

export async function PATCH(request: NextRequest, ctx: RouteParams) {
  try {
    return await update(request, ctx);
  } catch (error) {
    return savedViewErrorResponse(error);
  }
}

/** LEGACY (one release): the pre-CQL picker's PUT { name?, filter?, shared? }. */
export async function PUT(request: NextRequest, ctx: RouteParams) {
  try {
    return await update(request, ctx);
  } catch (error) {
    return savedViewErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const r = await authenticate(orgId);
    if ("error" in r) return r.error;
    await deleteSavedView(r.ctx, r.org, viewId);
    return noContent();
  } catch (error) {
    return savedViewErrorResponse(error);
  }
}
