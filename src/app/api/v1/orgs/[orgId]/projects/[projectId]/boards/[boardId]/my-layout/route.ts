import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { handleApiError } from "@/lib/api-helpers";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireBoardRead } from "@/lib/rbac/board-access";
import { widgetLinkProblems } from "@/lib/boards/widget-links";
import { rendersSavedWidgets } from "@/lib/boards/board-types";
import { PERSONAL_LAYOUT_MAX_BYTES } from "@/lib/boards/personal-layout";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import type { AuthContext } from "@/lib/rbac/check";
import {
  deleteMyBoardLayout,
  getMyBoardLayout,
  putMyBoardLayout,
} from "./route.contract";

/**
 * GET / PUT / DELETE …/boards/[boardId]/my-layout
 *
 * The CALLER'S OWN arrangement of a dashboard. It changes what they see and
 * nothing else — the board's shared layout (`Board.config.widgets`) stays the
 * one everyone else gets, and only the board's managers or its creator can
 * change that (`boards/[boardId]` PUT).
 *
 * WHO MAY KEEP ONE: anyone who may open the dashboard. That is the whole gate,
 * on purpose. A personal layout can only rearrange widgets, and every widget
 * draws from the routes the dashboard already reads (`/work-items`,
 * `/intervals`, `/members`) under the viewer's own access — so a layout cannot
 * reach data its owner could not already see on the board. Holding it to the
 * board-read gate is the same rule `tab-prefs` uses for a person's own tab
 * strip.
 *
 * Every read and write is keyed by `ctx.userId`, never by anything in the
 * request, so no caller can read or change another person's layout.
 */

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; boardId: string }>;
};

/** The dashboard this request names, gated exactly as the board itself is. */
async function dashboardFor(
  ctx: AuthContext,
  orgId: string,
  projectId: string,
  boardId: string,
) {
  // The project axis (visibility, classification, an ABAC deny, an API key's
  // project scope), then the team axis — the two questions every board route
  // asks, in the order they ask them.
  await requireProjectRead(ctx, projectId, "BOARD_READ");
  const board = await prisma.board.findFirst({
    where: { id: boardId, projectId, orgId },
    select: { id: true, type: true, teamId: true },
  });
  await requireBoardRead(ctx, projectId, board);
  return board!;
}

function layoutOf(row: { widgets: unknown; updatedAt: Date } | null) {
  if (!row) return null;
  return {
    widgets: Array.isArray(row.widgets) ? row.widgets : [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getMyBoardLayout);
    const {
      params: { orgId, projectId, boardId },
    } = await parseRequest(getMyBoardLayout, request, params);
    await dashboardFor(ctx, orgId, projectId, boardId);

    const row = await prisma.personalBoardLayout.findUnique({
      where: { boardId_userId: { boardId, userId: ctx.userId } },
      select: { widgets: true, updatedAt: true },
    });
    return respond(getMyBoardLayout, 200, { layout: layoutOf(row) });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, putMyBoardLayout);
    const {
      params: { orgId, projectId, boardId },
      body,
    } = await parseRequest(putMyBoardLayout, request, params);
    const board = await dashboardFor(ctx, orgId, projectId, boardId);

    // Only a board that DRAWS saved widgets can have a layout of them. Saving
    // one onto a Kanban would store something no screen ever shows.
    if (!rendersSavedWidgets(board.type)) {
      return problem(400, "invalid_request", "This board does not show widgets.", {
        request,
      });
    }
    if (JSON.stringify(body.widgets).length > PERSONAL_LAYOUT_MAX_BYTES) {
      return problem(400, "invalid_request", "This layout is too large to save.", {
        request,
      });
    }

    // The same link rule the Link List draws with, so a direct API write cannot
    // store a link the page would refuse to show (`widget-links.ts`).
    const linkProblems = widgetLinkProblems(body.widgets);
    if (linkProblems.length > 0) {
      return problem(400, "invalid_request", `A link can't be saved. ${linkProblems.join(" ")}`, {
        request,
      });
    }

    const widgets = body.widgets as Prisma.InputJsonValue;
    const row = await prisma.personalBoardLayout.upsert({
      where: { boardId_userId: { boardId, userId: ctx.userId } },
      create: { orgId, boardId, userId: ctx.userId, widgets },
      update: { widgets },
      select: { widgets: true, updatedAt: true },
    });
    return respond(putMyBoardLayout, 200, { layout: layoutOf(row) });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteMyBoardLayout);
    const {
      params: { orgId, projectId, boardId },
    } = await parseRequest(deleteMyBoardLayout, request, params);
    await dashboardFor(ctx, orgId, projectId, boardId);

    // deleteMany, not delete: going back to the shared layout when you are
    // already on it is a no-op, not an error.
    await prisma.personalBoardLayout.deleteMany({
      where: { boardId, userId: ctx.userId },
    });
    return respond(deleteMyBoardLayout, 204, null);
  } catch (error) {
    return handleApiError(error, request);
  }
}
