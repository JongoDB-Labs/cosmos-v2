import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, created, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; krId: string }>;
};

const bodySchema = z.object({ workItemId: z.string().uuid() });

/** Resolve + scope-check the KR (its objective must be in this org + project). */
async function loadKr(orgId: string, projectId: string, krId: string) {
  return prisma.keyResult.findFirst({
    where: { id: krId, objective: { orgId, projectId } },
    select: { id: true },
  });
}

/** GET — the tickets linked to this Key Result (with their done state). */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, krId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "OKR_READ", { projectId });

    if (!(await loadKr(orgId, projectId, krId))) return new Response("Not found", { status: 404 });

    const links = await prisma.keyResultLink.findMany({
      where: { keyResultId: krId },
      select: {
        id: true,
        workItem: {
          select: { id: true, ticketNumber: true, title: true, columnKey: true, completedAt: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return success(links.map((l) => ({ linkId: l.id, ...l.workItem })));
  } catch (e) {
    return handleApiError(e);
  }
}

/** POST — link a work item to this Key Result (idempotent). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, krId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "OKR_UPDATE", { projectId });

    if (!(await loadKr(orgId, projectId, krId))) return new Response("Not found", { status: 404 });

    const { workItemId } = bodySchema.parse(await request.json());
    // The work item must belong to this project (no cross-project links).
    const item = await prisma.workItem.findFirst({
      where: { id: workItemId, orgId, projectId },
      select: { id: true },
    });
    if (!item) return new Response(JSON.stringify({ error: "Work item not in this project" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });

    const link = await prisma.keyResultLink.upsert({
      where: { keyResultId_workItemId: { keyResultId: krId, workItemId } },
      create: { orgId, keyResultId: krId, workItemId },
      update: {},
      select: { id: true },
    });
    return created({ linkId: link.id });
  } catch (e) {
    return handleApiError(e);
  }
}

/** DELETE — unlink a work item from this Key Result. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, krId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "OKR_UPDATE", { projectId });

    if (!(await loadKr(orgId, projectId, krId))) return new Response("Not found", { status: 404 });

    const { workItemId } = bodySchema.parse(await request.json());
    await prisma.keyResultLink.deleteMany({ where: { keyResultId: krId, workItemId } });
    return success({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
