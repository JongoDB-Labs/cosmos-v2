import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; nodeId: string }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a node by id OR by anchor (deep-link URLs carry anchors, not uuids). */
function loadNode(orgId: string, projectId: string, nodeId: string) {
  return prisma.roadmapNode.findFirst({
    where: UUID_RE.test(nodeId)
      ? { id: nodeId, orgId, projectId }
      : { anchor: nodeId, orgId, projectId },
  });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, nodeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const node = await loadNode(orgId, projectId, nodeId);
    if (!node) return new Response("Not found", { status: 404 });
    return success(node);
  } catch (e) {
    return handleApiError(e);
  }
}

const updateSchema = z.object({
  title: z.string().min(1).max(400).optional(),
  body: z.string().max(50_000).nullish(),
  category: z.string().max(160).nullish(),
  section: z.string().max(80).nullish(),
  sortOrder: z.number().int().optional(),
});

/** PATCH/DELETE let a manager hand-edit an imported node. Gated PROJECT_UPDATE. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, nodeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await loadNode(orgId, projectId, nodeId);
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());
    const updated = await prisma.roadmapNode.update({
      where: { id: existing.id },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.body !== undefined && { body: data.body ?? "" }),
        ...(data.category !== undefined && { category: data.category }),
        ...(data.section !== undefined && { section: data.section }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
    });
    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, nodeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await loadNode(orgId, projectId, nodeId);
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.roadmapNode.delete({ where: { id: existing.id } });
    return success({ id: existing.id });
  } catch (e) {
    return handleApiError(e);
  }
}
