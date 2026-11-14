import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { createBoard, listBoards } from "@/lib/boards/board-service.server";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // The gate, the team axis and the reader DTO (who made each board reaches
    // a reader only as `ownedByMe`) live in the board service, which the
    // assistant's list_boards calls too: one list, two doors.
    return success(await listBoards(ctx, projectId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // The gate, validation, seeding and audit live in the board service, which
    // the assistant's create_board calls too: one rule, two entry points. A
    // body that is not JSON reaches it as null, so the gate still answers first
    // and the schema refuses it with a 400.
    const body = await request.json().catch(() => null);
    const board = await createBoard(ctx, projectId, body, { ipAddress: getIpAddress(request) });
    return created(board);
  } catch (error) {
    return handleApiError(error, request);
  }
}
