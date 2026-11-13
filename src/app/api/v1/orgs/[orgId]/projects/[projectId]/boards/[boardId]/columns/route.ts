import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { replaceBoardColumns } from "@/lib/boards/board-service.server";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; boardId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, boardId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // The gate, the status provisioning and the audit live in the board
    // service, which the assistant's set_board_columns calls too.
    const body = await request.json().catch(() => null);
    return success(await replaceBoardColumns(ctx, projectId, boardId, body, { ipAddress: getIpAddress(request) }));
  } catch (error) {
    return handleApiError(error);
  }
}
