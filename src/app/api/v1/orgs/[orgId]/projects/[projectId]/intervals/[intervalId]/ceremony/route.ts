import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireBoardRead } from "@/lib/rbac/board-access";
import { success, handleApiError } from "@/lib/api-helpers";
import { computeSprintReview } from "@/lib/intervals/sprint-review";
import { resolveCarriedItems } from "@/lib/intervals/ceremony-carried";
import { shippedItems, statusLabelFor } from "@/lib/intervals/ceremony-payload";
import { computeNextSprintDefaults } from "@/lib/intervals/next-sprint";
import { nextPlannedSprint } from "@/lib/intervals/carry-forward-target";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

const querySchema = z.object({ boardId: z.string().uuid() });

/**
 * Everything a sprint ceremony board renders, in ONE request.
 *
 * Per-tab fetching would issue a request per panel exactly when a facilitator is
 * standing in front of the team waiting for a screen — the PI Planning program
 * board learned the same lesson about per-cell loading.
 *
 * Nothing here is stored except the notes and action items. Points, counts, what
 * shipped and the next sprint's window all derive on read, so a ceremony
 * reopened a year from now still reconciles with the board it describes. The one
 * exception is WHICH items carried forward, which completion destroys — see
 * resolveCarriedItems.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "SPRINT_READ");

    const parsed = querySchema.safeParse({
      boardId: request.nextUrl.searchParams.get("boardId"),
    });
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: "boardId is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const { boardId } = parsed.data;

    // Optional team scope. A review belongs to the squad that did the work, so a
    // lead running their own retro should not be reading another team's numbers
    // back to the room.
    //
    // A team's WORK is whatever its members are assigned — items carry no team
    // of their own. Narrowed by `assigneeId`, the same key the planning endpoint
    // and the velocity suggestions use, so every panel counts the same people.
    const teamId = request.nextUrl.searchParams.get("teamId");
    let teamUserIds: string[] | null = null;
    if (teamId) {
      const team = await prisma.team.findFirst({
        where: { id: teamId, projectId },
        select: {
          members: {
            select: {
              projectMember: { select: { orgMember: { select: { userId: true } } } },
            },
          },
        },
      });
      // Unknown team → NOBODY, never a silent fall back to the whole project.
      teamUserIds = (team?.members ?? []).map(
        (m) => m.projectMember.orgMember.userId,
      );
    }
    const teamItemFilter = teamUserIds ? { assigneeId: { in: teamUserIds } } : {};

    const [interval, board] = await Promise.all([
      prisma.interval.findFirst({
        where: { id: intervalId, orgId, projectId },
        include: {
          parent: {
            select: { id: true, name: true, startDate: true, endDate: true },
          },
          workItems: {
            // Everything downstream — metrics, what shipped, what carries —
            // derives from this list, so scoping it here scopes the whole
            // review at once rather than in four places that could disagree.
            where: teamItemFilter,
            select: {
              id: true,
              ticketNumber: true,
              title: true,
              columnKey: true,
              storyPoints: true,
              priority: true,
            },
          },
        },
      }),
      prisma.board.findFirst({
        where: { id: boardId, projectId },
        include: {
          columns: { orderBy: { sortOrder: "asc" } },
          ceremonies: {
            where: { intervalId },
            include: {
              notes: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
              actionItems: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
        },
      }),
    ]);
    if (!interval) return new Response("Interval not found", { status: 404 });
    // Boards can be scoped to a team. Without this gate a ceremony could be read
    // through its board id by someone the board was deliberately narrowed away
    // from. Throws NotFoundError rather than 403 so it cannot be used to
    // enumerate a project's team structure.
    await requireBoardRead(ctx, projectId, board);
    if (!board) return new Response("Board not found", { status: 404 });

    const ceremony = board.ceremonies[0] ?? null;
    const config = (board.config ?? {}) as { showNoteAuthors?: boolean };

    const metrics = computeSprintReview({
      startDate: interval.startDate,
      endDate: interval.endDate,
      items: interval.workItems,
    });

    const carried = resolveCarriedItems({
      status: interval.status,
      items: interval.workItems,
      report: interval.report,
    });

    // Once a sprint completes its carried items belong to another sprint, so
    // they are no longer in `interval.workItems` and must be fetched by ID.
    const carriedItems =
      carried.kind === "unrecorded" || carried.itemIds.length === 0
        ? []
        : await prisma.workItem.findMany({
            // Scoped too. For a COMPLETED sprint these ids come from the
            // recorded report, which spans the whole sprint — so without this a
            // team's review would list other squads' carry-forward beside its
            // own metrics.
            where: { id: { in: carried.itemIds }, orgId, ...teamItemFilter },
            select: {
              id: true,
              ticketNumber: true,
              title: true,
              columnKey: true,
              storyPoints: true,
            },
          });

    // The sprint that FOLLOWS this one. Prefer the real one the team has already
    // planned; fall back to a computed suggestion only when none exists.
    //
    // This tab used to render the suggestion unconditionally, so a team who had
    // planned Sprint 2 was shown a fabricated sprint — with invented dates — in
    // the same voice as fact. `planned` lets the UI say which one it is looking at.
    const siblings = await prisma.interval.findMany({
      where: { orgId, projectId },
      select: {
        id: true,
        number: true,
        name: true,
        status: true,
        intervalKind: true,
        startDate: true,
        endDate: true,
      },
    });

    const alreadyPlanned = nextPlannedSprint(interval, siblings);
    const nextSprint = alreadyPlanned
      ? {
          name: alreadyPlanned.name,
          startDate: alreadyPlanned.startDate.toISOString(),
          endDate: alreadyPlanned.endDate.toISOString(),
          planned: true,
        }
      : {
          ...computeNextSprintDefaults(
            {
              name: interval.name,
              startDate: interval.startDate,
              endDate: interval.endDate,
            },
            // Skip names already in use so a suggestion cannot duplicate one.
            siblings.map((s) => s.name),
          ),
          planned: false,
        };

    return success({
      sprint: {
        id: interval.id,
        number: interval.number,
        name: interval.name,
        goal: interval.goal,
        startDate: interval.startDate,
        endDate: interval.endDate,
        status: interval.status,
      },
      increment: interval.parent,
      board: {
        id: board.id,
        name: board.name,
        type: board.type,
        config: board.config,
      },
      columns: board.columns.map((c) => ({
        key: c.key,
        name: c.name,
        color: c.color,
        category: c.category,
        sortOrder: c.sortOrder,
      })),
      metrics,
      shipped: shippedItems(interval.workItems),
      carried: {
        kind: carried.kind,
        items: carriedItems.map((i) => ({
          ...i,
          statusLabel: statusLabelFor(i.columnKey, board.columns),
        })),
      },
      nextSprint,
      ceremony: ceremony
        ? {
            id: ceremony.id,
            kind: ceremony.kind,
            status: ceremony.status,
            closedAt: ceremony.closedAt,
            notes: ceremony.notes.map((n) => ({
              id: n.id,
              columnKey: n.columnKey,
              text: n.text,
              // A retro is honest only when nobody has to sign their complaint,
              // so the author is withheld unless the board opts in. Stored
              // either way, so a person can still delete their own note.
              authorId: config.showNoteAuthors ? n.authorId : null,
              isMine: n.authorId === ctx.userId,
              createdAt: n.createdAt,
            })),
            actionItems: ceremony.actionItems,
          }
        : null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
