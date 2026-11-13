import { NextRequest } from "next/server";
import { withStatusCategories } from "@/lib/workflow/column-categories.server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { narrowBoards } from "@/lib/rbac/board-access";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { createBoard } from "@/lib/boards/board-service.server";
import { boardForReader } from "@/lib/boards/board-dto";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "BOARD_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const boards = await prisma.board.findMany({
      where: { projectId, orgId },
      include: {
        columns: { orderBy: { sortOrder: "asc" } },
        _count: true,
      },
      orderBy: { sortOrder: "asc" },
    });

    // The TEAM axis. `requireProjectRead` above answers "may they open this
    // project"; this answers "which of its boards are theirs to see". Without
    // it this route returned every board while the sidebar hid the ones
    // assigned to another team — the same question, two different answers.
    // Who made each board reaches a reader only as `ownedByMe`, as on every
    // board the board service returns.
    const rows = await withStatusCategories(prisma, projectId, await narrowBoards(ctx, projectId, boards));
    return success(rows.map((b) => boardForReader(b, ctx.userId)));
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
