import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { deleteBoard, getBoard, updateBoard } from "@/lib/boards/board-service.server";

// The gates, validation and audit for these handlers live in the board service,
// which the assistant's board tools call too: one rule, two entry points.

type RouteParams = { params: Promise<{ orgId: string; projectId: string; boardId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    return success(await getBoard(ctx, projectId, boardId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    const body = await request.json().catch(() => null);
    return success(await updateBoard(ctx, projectId, boardId, body, { ipAddress: getIpAddress(request) }));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await deleteBoard(ctx, projectId, boardId, { ipAddress: getIpAddress(request) });
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
