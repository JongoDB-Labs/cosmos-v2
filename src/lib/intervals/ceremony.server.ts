import { BoardType, CeremonyKind } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { ConflictError, ForbiddenError, NotFoundError, type AuthContext } from "@/lib/rbac/check";
import { ProblemError } from "@/lib/openapi/problem";
import { Permission } from "@/lib/rbac/permissions";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { isBoardVisible, narrowBoards, requireBoardRead } from "@/lib/rbac/board-access";
import type { BoardLike } from "@/lib/rbac/board-visibility";
import { computeSprintReview } from "@/lib/intervals/sprint-review";
import { loadStatusCategories } from "@/lib/boards/status-categories.server";
import { resolveCarriedItems } from "@/lib/intervals/ceremony-carried";
import { shippedItems, statusLabelFor } from "@/lib/intervals/ceremony-payload";
import { computeNextSprintDefaults } from "@/lib/intervals/next-sprint";
import { nextPlannedSprint } from "@/lib/intervals/carry-forward-target";
import { defaultCeremonyInterval } from "@/lib/intervals/ceremony-intervals";
import { columnCategoryResolver } from "@/lib/workflow/column-categories.server";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { assignableMembersWhere } from "@/lib/work-items/apply-change.server";
import { allocateTicketNumber, allocateSortOrder } from "@/lib/work-items/allocate";

/**
 * Sprint ceremonies (planning and review/retro boards): the gate and the work,
 * shared by the REST routes under intervals/[intervalId]/ceremony and the
 * assistant's ceremony tools. One gate, two entry points: a tool that restated
 * these rules would drift from them, which is how the agent became "a second
 * API" elsewhere.
 *
 * The split matters: ANY project member may add notes and action items, because
 * a retro only the facilitator can type into is theatre. Opening and closing a
 * ceremony is the facilitator's, gated on the same permission that completes a
 * sprint.
 *
 * Refusals THROW (NotFoundError, ForbiddenError, ConflictError, ProblemError)
 * in the routes' own words: a route's handleApiError turns them into its status
 * codes, and a tool folds them into its answer with serviceRefusal.
 *
 * The route gate scans (lib/auth/__tests__/gate-bits.ts) follow this module as
 * if it were a route's own helper, so keep every gate a top-level `function`.
 */

export interface CeremonyScope {
  orgId: string;
  projectId: string;
  intervalId: string;
}

/** Who is calling the shared work, and which checks they get. */
export interface CeremonyCaller {
  /** Recorded on a promoted work item's history: the app, or the assistant. */
  source: "API" | "AI";
  ipAddress?: string;
}

/** A request body, read only after the gate, as the routes always have. */
export type CeremonyBody = () => Promise<unknown>;

// ── Gates ────────────────────────────────────────────────────────────────────

/** Reading a ceremony board: the GET route's gate. */
export async function requireCeremonyViewer(ctx: AuthContext, projectId: string): Promise<void> {
  await requireProjectRead(ctx, projectId, "SPRINT_READ");
}

/**
 * Every contributor action is a write (add, edit or delete a note or action
 * item). A session needs only SPRINT_READ, so any project member can type into
 * a retro; a key also needs SPRINT_CREATE (items:write or planning:write), so a
 * read key can't rewrite or delete the room's notes and actions, and its creator
 * needs the SPRINT_READ their session would (keyMay).
 */
export async function requireCeremonyContributor(ctx: AuthContext, projectId: string): Promise<void> {
  await requireProjectRead(ctx, projectId, { key: "SPRINT_CREATE", session: "SPRINT_READ" });
}

/** As above, plus the facilitator permission that opening/closing requires. */
export async function requireCeremonyFacilitator(ctx: AuthContext, projectId: string): Promise<void> {
  await requireCeremonyContributor(ctx, projectId);
  await requireProjectManage(ctx, projectId, Permission.SPRINT_COMPLETE);
}

/**
 * Editing and deleting a note are the AUTHOR's, with the facilitator able to
 * remove anything: someone must be able to take down what should not have been
 * written, and the person who wrote it may have left the room.
 */
async function mayModifyNote(ctx: AuthContext, projectId: string, authorId: string | null): Promise<boolean> {
  if (authorId && authorId === ctx.userId) return true;
  try {
    await requireProjectManage(ctx, projectId, Permission.SPRINT_COMPLETE);
    return true;
  } catch {
    return false;
  }
}

/**
 * The board check every write by id gets, from the app and the assistant
 * alike: a ceremony on a board narrowed to a team the caller is not on is not
 * there. A hidden board answers with the same not-found as a missing row, so
 * the refusal cannot be used to learn which ceremonies exist on boards narrowed
 * away from the caller. (The REST writes used to skip it: close and the note
 * and action writes reached another team's retro by id.)
 */
async function requireCeremonyBoardFor(
  ctx: AuthContext,
  projectId: string,
  board: BoardLike,
  notFound: string,
): Promise<void> {
  if (!(await isBoardVisible(ctx, projectId, board))) throw new NotFoundError(notFound);
}

// ── Lookups ──────────────────────────────────────────────────────────────────
//
// Notes and actions are addressed by their own ids, so each lookup proves the
// row belongs to this org, project and sprint: without the join, a valid id
// from another tenant's ceremony would be reachable here.

async function findCeremony(ceremonyId: string, scope: CeremonyScope) {
  return prisma.sprintCeremony.findFirst({
    where: {
      id: ceremonyId,
      orgId: scope.orgId,
      intervalId: scope.intervalId,
      board: { projectId: scope.projectId },
    },
    select: { id: true, status: true, kind: true, boardId: true, board: { select: { id: true, teamId: true } } },
  });
}

async function findNote(noteId: string, scope: CeremonyScope) {
  return prisma.retroNote.findFirst({
    where: {
      id: noteId,
      ceremony: {
        orgId: scope.orgId,
        intervalId: scope.intervalId,
        board: { projectId: scope.projectId },
      },
    },
    select: {
      id: true,
      authorId: true,
      ceremonyId: true,
      ceremony: { select: { status: true, board: { select: { id: true, teamId: true } } } },
    },
  });
}

async function findAction(actionId: string, scope: CeremonyScope) {
  return prisma.retroActionItem.findFirst({
    where: {
      id: actionId,
      ceremony: {
        orgId: scope.orgId,
        intervalId: scope.intervalId,
        board: { projectId: scope.projectId },
      },
    },
    select: {
      id: true,
      text: true,
      ownerId: true,
      dueDate: true,
      ceremonyId: true,
      workItemId: true,
      ceremony: { select: { status: true, boardId: true, board: { select: { id: true, teamId: true } } } },
    },
  });
}

/**
 * Tell every open client that a ceremony changed, by REFERENCE only. The
 * project rides along so the stream sends it only to people who can read it.
 *
 * Note text must never ride the bus: the pg adapter caps payloads at 6 KB
 * (Postgres NOTIFY allows 8 KB, minus headroom) and a room full of people
 * typing is exactly the load that would truncate. Clients receive the ref and
 * refetch through their org-scoped query key.
 */
export function publishCeremonyChanged(orgId: string, projectId: string, ceremonyId: string) {
  publishToOrg(orgId, "ceremony.changed", { ceremonyId, projectId });
}

/** Marks an audit row the assistant wrote; the app's rows are unchanged. */
function auditVia(caller: CeremonyCaller): Record<string, string> {
  return caller.source === "AI" ? { via: "assistant" } : {};
}

// ── Reads ────────────────────────────────────────────────────────────────────

const payloadQuery = z.object({ boardId: z.string().uuid() });

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
export async function getCeremonyPayload(
  ctx: AuthContext,
  scope: CeremonyScope,
  query: { boardId: string | null; teamId: string | null },
) {
  const { orgId, projectId, intervalId } = scope;
  await requireCeremonyViewer(ctx, projectId);

  const parsed = payloadQuery.safeParse({ boardId: query.boardId });
  if (!parsed.success) throw new ProblemError(400, "invalid_request", "boardId is required");
  const { boardId } = parsed.data;

  // Optional team scope. A review belongs to the squad that did the work, so a
  // lead running their own retro should not be reading another team's numbers
  // back to the room.
  //
  // A team's WORK is whatever its members are assigned — items carry no team
  // of their own. Narrowed by `assigneeId`, the same key the planning endpoint
  // and the velocity suggestions use, so every panel counts the same people.
  let teamUserIds: string[] | null = null;
  if (query.teamId) {
    const team = await prisma.team.findFirst({
      where: { id: query.teamId, projectId },
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
          // The org's own items (an older, unchecked write may have left
          // another org's item pointing at this sprint), then the team.
          where: { orgId, ...teamItemFilter },
          select: {
            id: true,
            ticketNumber: true,
            title: true,
            columnKey: true,
            storyPoints: true,
            priority: true,
            // Keep in step with BOTH `CeremonyItem` declarations — the client
            // copy in components/boards/ceremony/use-ceremony.ts and the
            // server one in lib/intervals/ceremony-payload.ts. They are
            // hand-duplicated, and tsc cannot see a field missing from here.
            highlight: true,
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
  if (!interval) throw new NotFoundError("Interval not found");
  // Boards can be scoped to a team. Without this gate a ceremony could be read
  // through its board id by someone the board was deliberately narrowed away
  // from. Throws NotFoundError rather than 403 so it cannot be used to
  // enumerate a project's team structure.
  await requireBoardRead(ctx, projectId, board);
  if (!board) throw new NotFoundError("Board not found");

  const ceremony = board.ceremonies[0] ?? null;
  const config = (board.config ?? {}) as { showNoteAuthors?: boolean };

  // "Done" is a status CATEGORY, read from the project's work boards: this
  // ceremony board's own columns are prompts (Start/Stop/Continue), not statuses.
  const statuses = await loadStatusCategories(prisma, projectId);

  const metrics = computeSprintReview({
    startDate: interval.startDate,
    endDate: interval.endDate,
    items: interval.workItems,
    columns: statuses,
  });

  const carried = resolveCarriedItems({
    status: interval.status,
    items: interval.workItems,
    report: interval.report,
    statuses,
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

  return {
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
    shipped: shippedItems(interval.workItems, statuses),
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
  };
}

const CEREMONY_BOARD_TYPES = [BoardType.SPRINT_PLANNING, BoardType.SPRINT_REVIEW];

/**
 * The interval a ceremony opens on when none is named: the one the team is in,
 * else the one they just finished, else the next one up. Program Increments are
 * never picked (see ceremony-intervals.ts). Null when there is none.
 */
export async function findDefaultCeremonyInterval(ctx: AuthContext, orgId: string, projectId: string) {
  await requireCeremonyViewer(ctx, projectId);
  const intervals = await prisma.interval.findMany({
    where: { orgId, projectId },
    select: { id: true, number: true, name: true, status: true, intervalKind: true },
  });
  return defaultCeremonyInterval(intervals);
}

/**
 * The project's ceremony boards that this caller may see, each with its
 * ceremony for this interval (or null when none has been opened). How a caller
 * finds the `boardId` the full read needs. Note and action counts only; the
 * text is in the full read, where the author rule applies.
 */
export async function listCeremonyBoards(ctx: AuthContext, scope: CeremonyScope) {
  const { orgId, projectId, intervalId } = scope;
  await requireCeremonyViewer(ctx, projectId);

  const interval = await prisma.interval.findFirst({
    where: { id: intervalId, orgId, projectId },
    select: { id: true, number: true, name: true, status: true },
  });
  if (!interval) throw new NotFoundError("Interval not found");

  const boards = await prisma.board.findMany({
    where: { orgId, projectId, type: { in: CEREMONY_BOARD_TYPES } },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      type: true,
      teamId: true,
      ceremonies: {
        where: { intervalId },
        select: {
          id: true,
          kind: true,
          status: true,
          closedAt: true,
          _count: { select: { notes: true, actionItems: true } },
        },
      },
    },
  });
  const visible = await narrowBoards(ctx, projectId, boards);

  return {
    interval,
    boards: visible.map((b) => {
      const c = b.ceremonies[0] ?? null;
      return {
        id: b.id,
        name: b.name,
        type: b.type,
        teamId: b.teamId,
        ceremony: c
          ? {
              id: c.id,
              kind: c.kind,
              status: c.status,
              closedAt: c.closedAt,
              noteCount: c._count.notes,
              actionCount: c._count.actionItems,
            }
          : null,
      };
    }),
  };
}

// ── Facilitator writes ───────────────────────────────────────────────────────

const openSchema = z.object({
  boardId: z.string().uuid(),
  kind: z.nativeEnum(CeremonyKind),
});

/**
 * Open the ceremony for this board and sprint, creating it if this is the first
 * time. Idempotent: re-opening a RUNNING ceremony returns the same row rather
 * than a second one, which the (boardId, intervalId) unique index also enforces
 * at the database.
 *
 * Re-opening a CLOSED ceremony is allowed and deliberate — a team that closed
 * early and wants to add one more action should not have to lose the retro.
 */
export async function openCeremony(ctx: AuthContext, scope: CeremonyScope, body: CeremonyBody, caller: CeremonyCaller) {
  const { orgId, projectId, intervalId } = scope;
  await requireCeremonyFacilitator(ctx, projectId);

  const data = openSchema.parse(await body());

  // Prove the board and sprint are this project's before writing a row that
  // joins them.
  const [board, interval] = await Promise.all([
    prisma.board.findFirst({
      where: { id: data.boardId, projectId },
      select: { id: true, teamId: true },
    }),
    prisma.interval.findFirst({
      where: { id: intervalId, orgId, projectId },
      select: { id: true },
    }),
  ]);
  // Same team gate as the read path: opening a ceremony on a board narrowed
  // away from you would create the row the read path then refuses to show.
  await requireBoardRead(ctx, projectId, board);
  if (!interval) throw new NotFoundError("Interval not found");

  const ceremony = await prisma.sprintCeremony.upsert({
    where: {
      boardId_intervalId: { boardId: data.boardId, intervalId },
    },
    create: {
      orgId,
      boardId: data.boardId,
      intervalId,
      kind: data.kind,
      status: "RUNNING",
    },
    update: { status: "RUNNING", closedAt: null },
  });

  await logAudit({
    orgId,
    userId: ctx.userId,
    action: "ceremony.open",
    entity: "SprintCeremony",
    entityId: ceremony.id,
    metadata: { boardId: data.boardId, intervalId, kind: data.kind, ...auditVia(caller) },
    ipAddress: caller.ipAddress,
  });
  publishCeremonyChanged(orgId, projectId, ceremony.id);

  return {
    id: ceremony.id,
    kind: ceremony.kind,
    status: ceremony.status,
    closedAt: ceremony.closedAt,
  };
}

const closeSchema = z.object({ ceremonyId: z.string().uuid() });

/**
 * Close the ceremony. This is a real event, not a view: a CLOSED row with a
 * `closedAt` is what distinguishes "we held this retro" from "nobody ever
 * opened the board", and no derived figure can tell those apart.
 */
export async function closeCeremony(ctx: AuthContext, scope: CeremonyScope, body: CeremonyBody, caller: CeremonyCaller) {
  const { orgId, projectId, intervalId } = scope;
  await requireCeremonyFacilitator(ctx, projectId);

  const data = closeSchema.parse(await body());
  const ceremony = await findCeremony(data.ceremonyId, scope);
  if (!ceremony) throw new NotFoundError("Ceremony not found");
  await requireCeremonyBoardFor(ctx, projectId, ceremony.board, "Ceremony not found");

  if (ceremony.status === "CLOSED") throw new ConflictError("This ceremony is already closed");

  const updated = await prisma.sprintCeremony.update({
    where: { id: ceremony.id },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  await logAudit({
    orgId,
    userId: ctx.userId,
    action: "ceremony.close",
    entity: "SprintCeremony",
    entityId: ceremony.id,
    metadata: { intervalId, kind: ceremony.kind, ...auditVia(caller) },
    ipAddress: caller.ipAddress,
  });
  publishCeremonyChanged(orgId, projectId, ceremony.id);

  return {
    id: updated.id,
    status: updated.status,
    closedAt: updated.closedAt,
  };
}

// ── Notes ────────────────────────────────────────────────────────────────────

const noteText = z.string().trim().min(1).max(2000);
const addNoteSchema = z.object({
  ceremonyId: z.string().uuid(),
  columnKey: z.string().min(1),
  text: noteText,
});

/**
 * Add a note to a retro column. Any project member may — a retro only the
 * facilitator can type into is theatre.
 *
 * The author is recorded but the read path withholds it unless the board opts
 * in, so a person can delete their own note without the room seeing who wrote
 * what.
 */
export async function addCeremonyNote(ctx: AuthContext, scope: CeremonyScope, body: CeremonyBody) {
  await requireCeremonyContributor(ctx, scope.projectId);

  const data = addNoteSchema.parse(await body());
  const ceremony = await findCeremony(data.ceremonyId, scope);
  if (!ceremony) throw new NotFoundError("Ceremony not found");
  await requireCeremonyBoardFor(ctx, scope.projectId, ceremony.board, "Ceremony not found");

  if (ceremony.status === "CLOSED") {
    throw new ConflictError("This ceremony is closed. Reopen it to add notes.");
  }

  // The column must be one this board actually has, or a note lands in a
  // column nothing renders and simply disappears.
  const column = await prisma.boardColumn.findFirst({
    where: { boardId: ceremony.boardId, key: data.columnKey },
    select: { key: true },
  });
  if (!column) throw new ProblemError(400, "invalid_request", "That column is not on this board");

  const max = await prisma.retroNote.aggregate({
    where: { ceremonyId: ceremony.id, columnKey: data.columnKey },
    _max: { sortOrder: true },
  });

  const note = await prisma.retroNote.create({
    data: {
      ceremonyId: ceremony.id,
      columnKey: data.columnKey,
      text: data.text,
      authorId: ctx.userId,
      sortOrder: (max._max.sortOrder ?? -1) + 1,
    },
  });

  publishCeremonyChanged(scope.orgId, scope.projectId, ceremony.id);

  return {
    id: note.id,
    columnKey: note.columnKey,
    text: note.text,
    isMine: true,
    createdAt: note.createdAt,
  };
}

const NOT_YOURS = "Only the note's author or a facilitator can change it";
const editNoteSchema = z.object({ text: noteText });

export async function updateCeremonyNote(
  ctx: AuthContext,
  scope: CeremonyScope,
  noteId: string,
  body: CeremonyBody,
) {
  await requireCeremonyContributor(ctx, scope.projectId);

  const note = await findNote(noteId, scope);
  if (!note) throw new NotFoundError("Note not found");
  await requireCeremonyBoardFor(ctx, scope.projectId, note.ceremony.board, "Note not found");
  if (note.ceremony.status === "CLOSED") throw new ConflictError("This ceremony is closed");
  if (!(await mayModifyNote(ctx, scope.projectId, note.authorId))) throw new ForbiddenError(NOT_YOURS);

  const data = editNoteSchema.parse(await body());
  const updated = await prisma.retroNote.update({
    where: { id: note.id },
    data: { text: data.text },
  });

  publishCeremonyChanged(scope.orgId, scope.projectId, note.ceremonyId);
  return { id: updated.id, text: updated.text };
}

/** Deleting is allowed on a closed ceremony, as it always was. */
export async function deleteCeremonyNote(ctx: AuthContext, scope: CeremonyScope, noteId: string) {
  await requireCeremonyContributor(ctx, scope.projectId);

  const note = await findNote(noteId, scope);
  if (!note) throw new NotFoundError("Note not found");
  await requireCeremonyBoardFor(ctx, scope.projectId, note.ceremony.board, "Note not found");
  if (!(await mayModifyNote(ctx, scope.projectId, note.authorId))) throw new ForbiddenError(NOT_YOURS);

  await prisma.retroNote.delete({ where: { id: note.id } });
  publishCeremonyChanged(scope.orgId, scope.projectId, note.ceremonyId);
  return { id: note.id };
}

// ── Action items ─────────────────────────────────────────────────────────────

const NOT_A_MEMBER = "That owner is not a member of this organization";
const addActionSchema = z.object({
  ceremonyId: z.string().uuid(),
  text: z.string().trim().min(1).max(2000),
  ownerId: z.string().uuid().nullish(),
  dueDate: z.coerce.date().nullish(),
});

/**
 * Capture an action item. Owner and due date are optional at this point on
 * purpose: an action is typed mid-conversation, and demanding both before the
 * row exists stops the conversation. The board nags for them afterwards, and
 * promotion needs them.
 */
export async function addCeremonyAction(ctx: AuthContext, scope: CeremonyScope, body: CeremonyBody) {
  await requireCeremonyContributor(ctx, scope.projectId);

  const data = addActionSchema.parse(await body());
  const ceremony = await findCeremony(data.ceremonyId, scope);
  if (!ceremony) throw new NotFoundError("Ceremony not found");
  await requireCeremonyBoardFor(ctx, scope.projectId, ceremony.board, "Ceremony not found");
  if (ceremony.status === "CLOSED") {
    throw new ConflictError("This ceremony is closed. Reopen it to add actions.");
  }

  // An owner must be a member of this org, or the action is assigned to
  // somebody who will never see it.
  if (data.ownerId) {
    const member = await prisma.orgMember.findFirst({
      where: { orgId: scope.orgId, userId: data.ownerId },
      select: { id: true },
    });
    if (!member) throw new ProblemError(400, "invalid_request", NOT_A_MEMBER);
  }

  const max = await prisma.retroActionItem.aggregate({
    where: { ceremonyId: ceremony.id },
    _max: { sortOrder: true },
  });

  const action = await prisma.retroActionItem.create({
    data: {
      ceremonyId: ceremony.id,
      text: data.text,
      ownerId: data.ownerId ?? null,
      dueDate: data.dueDate ?? null,
      sortOrder: (max._max.sortOrder ?? -1) + 1,
    },
  });

  publishCeremonyChanged(scope.orgId, scope.projectId, ceremony.id);
  return action;
}

const editActionSchema = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  ownerId: z.string().uuid().nullish(),
  dueDate: z.coerce.date().nullish(),
});

export async function updateCeremonyAction(
  ctx: AuthContext,
  scope: CeremonyScope,
  actionId: string,
  body: CeremonyBody,
) {
  await requireCeremonyContributor(ctx, scope.projectId);

  const action = await findAction(actionId, scope);
  if (!action) throw new NotFoundError("Action item not found");
  await requireCeremonyBoardFor(ctx, scope.projectId, action.ceremony.board, "Action item not found");
  if (action.ceremony.status === "CLOSED") throw new ConflictError("This ceremony is closed");

  const data = editActionSchema.parse(await body());
  // Same rule as creating one: an owner must be a member of this org (the
  // owner becomes the assignee when the action is promoted to a work item).
  if (data.ownerId) {
    const member = await prisma.orgMember.findFirst({
      where: assignableMembersWhere(scope.orgId, [data.ownerId]),
      select: { id: true },
    });
    if (!member) throw new ProblemError(400, "invalid_request", NOT_A_MEMBER);
  }
  const updated = await prisma.retroActionItem.update({
    where: { id: action.id },
    data: {
      ...(data.text !== undefined ? { text: data.text } : {}),
      ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
      ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
    },
  });

  publishCeremonyChanged(scope.orgId, scope.projectId, action.ceremonyId);
  return updated;
}

/**
 * Deleting the action does NOT delete a work item already promoted from it:
 * the team committed to that work, and it now lives in the backlog on its own
 * terms. Allowed on a closed ceremony, as it always was.
 */
export async function deleteCeremonyAction(ctx: AuthContext, scope: CeremonyScope, actionId: string) {
  await requireCeremonyContributor(ctx, scope.projectId);

  const action = await findAction(actionId, scope);
  if (!action) throw new NotFoundError("Action item not found");
  await requireCeremonyBoardFor(ctx, scope.projectId, action.ceremony.board, "Action item not found");

  await prisma.retroActionItem.delete({ where: { id: action.id } });

  publishCeremonyChanged(scope.orgId, scope.projectId, action.ceremonyId);
  return { id: action.id, promotedWorkItemId: action.workItemId };
}

/**
 * Promote a retro action into real, tracked work.
 *
 * Retro actions that never enter the backlog are the ones that quietly die, so
 * this is one click: the action's text becomes a work item in the project's
 * first To-Do column, carrying its owner and due date, landing on the sprint
 * that follows this one so it shows up in the next planning session.
 *
 * Idempotent by design. Re-promoting returns the work item already created
 * rather than a second copy — a double-click during a live ceremony must not
 * put two identical stories in the backlog.
 */
export async function promoteCeremonyAction(ctx: AuthContext, scope: CeremonyScope, actionId: string, caller: CeremonyCaller) {
  const { orgId, projectId, intervalId } = scope;
  await requireCeremonyContributor(ctx, projectId);

  // Creating work is a different authority from contributing to a retro.
  await requireProjectManage(ctx, projectId, Permission.ITEM_CREATE);

  const action = await findAction(actionId, scope);
  if (!action) throw new NotFoundError("Action item not found");
  await requireCeremonyBoardFor(ctx, projectId, action.ceremony.board, "Action item not found");

  // Already promoted: hand back what exists. Only if it still exists — the
  // work item may have been deleted since, which nulls the link.
  if (action.workItemId) {
    const existing = await prisma.workItem.findUnique({
      where: { id: action.workItemId },
      select: { id: true, ticketNumber: true, title: true },
    });
    if (existing) return { workItem: existing, created: false };
  }

  // Land it on a DELIVERY board, never on the ceremony board that produced it.
  // A retro board's columns are Start / Stop / Continue, so taking "the first
  // TODO column of this board" would file real tracked work under "Start",
  // where no one tracking work would ever look for it.
  // Narrowed by the team gate before we pick one: filing work onto a board
  // this actor cannot see would put it somewhere they can never open.
  const candidateBoards = await prisma.board.findMany({
    where: {
      projectId,
      type: { notIn: [BoardType.SPRINT_REVIEW, BoardType.SPRINT_PLANNING] },
      columns: { some: {} },
    },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      teamId: true,
      columns: {
        orderBy: { sortOrder: "asc" },
        select: { key: true, category: true },
      },
    },
  });
  const deliveryBoard = (
    await narrowBoards(ctx, projectId, candidateBoards)
  )[0];

  // Fall back to the ceremony board only when the project has no delivery
  // board at all — a home that reads oddly still beats refusing the promotion
  // and losing the team's decision.
  // A delivery board's column has its status's category (column-categories.server.ts).
  const categoryOf = deliveryBoard ? await columnCategoryResolver(prisma, projectId) : null;
  const columns =
    deliveryBoard?.columns.map((c) => ({ ...c, category: categoryOf!(c) })) ??
    (await prisma.boardColumn.findMany({
      where: { boardId: action.ceremony.boardId },
      orderBy: { sortOrder: "asc" },
      select: { key: true, category: true },
    }));
  const target =
    columns.find((c) => c.category === "TODO") ?? columns[0] ?? null;
  if (!target) {
    throw new ConflictError("This board has no columns, so there is nowhere to put the work.");
  }

  // The sprint that follows this one, if the team has created it. Null is
  // fine — the item lands in the backlog instead of a sprint that is not real.
  const thisInterval = await prisma.interval.findUnique({
    where: { id: intervalId },
    select: { number: true },
  });
  const nextInterval = thisInterval
    ? await prisma.interval.findFirst({
        where: { orgId, projectId, number: { gt: thisInterval.number } },
        orderBy: { number: "asc" },
        select: { id: true },
      })
    : null;

  const workItemType = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: { endsWith: ".task" } },
    select: { id: true },
  });
  if (!workItemType) {
    throw new ProblemError(500, "internal_error", "No built-in task type is available");
  }

  const created = await prisma.$transaction(async (tx) => {
    const ticketNumber = await allocateTicketNumber(tx, { orgId, projectId });
    const sortOrder = await allocateSortOrder(tx, {
      orgId,
      projectId,
      columnKey: target.key,
    });

    // The owner becomes the assignee only while they are still in the org
    // (someone who has left would be assigned work they can never see).
    const ownerInOrg = action.ownerId
      ? (await tx.orgMember.count({ where: assignableMembersWhere(orgId, [action.ownerId]) })) > 0
      : false;

    const item = await createWorkItemRow(tx, {
      data: {
        orgId,
        projectId,
        workItemTypeId: workItemType.id,
        title: action.text.slice(0, 255),
        description: "",
        columnKey: target.key,
        assigneeId: ownerInOrg ? action.ownerId : null,
        dueDate: action.dueDate,
        intervalId: nextInterval?.id ?? null,
        ticketNumber,
        sortOrder,
        createdById: ctx.userId,
      },
      select: { id: true, ticketNumber: true, title: true },
    }, { actorId: ctx.userId, source: caller.source });

    await tx.retroActionItem.update({
      where: { id: action.id },
      data: { workItemId: item.id },
    });

    return item;
  });

  await logAudit({
    orgId,
    userId: ctx.userId,
    action: "ceremony.action.promote",
    entity: "RetroActionItem",
    entityId: action.id,
    metadata: { workItemId: created.id, intervalId: nextInterval?.id ?? null, ...auditVia(caller) },
    ipAddress: caller.ipAddress,
  });
  publishCeremonyChanged(orgId, projectId, action.ceremonyId);

  return { workItem: created, created: true };
}
