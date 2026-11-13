/**
 * Board reads and writes, with their gates, for every entry point.
 *
 * The board REST routes and the assistant's board tools both call these. The
 * assistant is a second API onto the same tables, and a tool that re-derives a
 * route's rule drifts from it; one that calls the rule cannot. So the
 * authorization, validation, seeding and audit that used to live in the route
 * handlers live here, and each route is a thin adapter: resolve the org, build
 * the AuthContext, call, map the throw to a status.
 *
 * Refusals throw the route error classes (`ForbiddenError` 403, `NotFoundError`
 * 404, `ConflictError` 409, `ProblemError`, `ZodError` 400) so `handleApiError`
 * answers with the status the routes always gave.
 *
 * Who may change a board: whoever manages the project's boards (an org-wide
 * BOARD_UPDATE/BOARD_DELETE holder or a project MANAGER, within an API key's or
 * an assistant's project ceiling), or the person who made it, on a board that
 * draws saved widgets and only while they could still create a board here
 * (`canManageOwnBoard`, lib/rbac/board-ownership.ts). The creator's rights stop
 * at the board's name and widget layout, and at deleting a board no ceremony
 * hangs off. Every board a caller receives from here goes through
 * `boardForReader`: who made it reaches them only as `ownedByMe`.
 */
import { z } from "zod";
import { BoardType, ColumnCategory, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { ConflictError, ForbiddenError, NotFoundError, type AuthContext } from "@/lib/rbac/check";
import { ProblemError } from "@/lib/openapi/problem";
import { Permission } from "@/lib/rbac/permissions";
import { canManageBoardsInProject } from "@/lib/rbac/project-role";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { canAdministerProject, requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireBoardRead } from "@/lib/rbac/board-access";
import { isProjectVisible } from "@/lib/rbac/project-access";
import {
  canManageOwnBoard,
  mergeOwnerConfig,
  OWNER_EDITABLE_BOARD_FIELDS,
  OWNER_LAYOUT_CONFIG_KEYS,
} from "@/lib/rbac/board-ownership";
import { boardForReader } from "@/lib/boards/board-dto";
import { widgetLinkProblems, widgetLinkRefusal } from "@/lib/boards/widget-links";
import { uniqueBoardSlug } from "@/lib/templates/slugify";
import { BOARD_TYPE_REGISTRY } from "@/lib/boards/board-types";
import { DEFAULT_COLUMNS } from "@/lib/boards/default-columns";
import { seedBoardColumns, type ColumnSpec } from "@/lib/workflow/provision.server";
import { boardShowsStatuses, ensureStatuses, renameStatusIfUnshared } from "@/lib/workflow/statuses.server";
import { withStatusCategories } from "@/lib/workflow/column-categories.server";

/** Request details the audit row records. The assistant has none to give. */
export interface BoardWriteMeta {
  ipAddress?: string | null;
}

/** How `updateBoard` treats a creator's `config` change beyond the widget layout. */
export interface BoardUpdateOptions {
  /**
   * Refuse it, instead of keeping the stored value. The REST route leaves this
   * off: the builder sends the whole config back, so a key it merely echoes is
   * kept, not refused (`mergeOwnerConfig`). The assistant turns it on, because it
   * sends only what it means to change: kept silently, the change would be
   * reported as made when it was not.
   */
  refuseIgnoredConfig?: boolean;
}

/** The refusal a caller who neither manages the project's boards nor made this one gets. */
const NOT_A_BOARD_MANAGER = "You must be a manager of this project, or hold the org-wide permission, to do that.";

/**
 * Refuse a widget layout carrying a link the Link List would not draw. The same
 * rule the widget draws with (`widget-links.ts`), so no door can store a link
 * the page would refuse to show.
 */
function assertWidgetLinks(config: Record<string, unknown> | undefined) {
  const problems = widgetLinkProblems((config as { widgets?: unknown } | undefined)?.widgets);
  if (problems.length > 0) {
    throw new ProblemError(400, "invalid_request", widgetLinkRefusal(problems), undefined, problems.map((message) => ({ message })));
  }
}

/** JSON with sorted keys, so two equal values compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The `config` keys a creator's change would set, change or remove that
 * `mergeOwnerConfig` keeps at their stored value. A query is two keys
 * (`query` and the legacy `savedFilter` beside it); both read as "query".
 */
function ignoredOwnerConfigKeys(stored: unknown, sent: Record<string, unknown>): string[] {
  const before = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const layout = new Set<string>(OWNER_LAYOUT_CONFIG_KEYS);
  const keys = new Set([...Object.keys(before), ...Object.keys(sent)]);
  const changed = [...keys].filter((k) => !layout.has(k) && canonicalJson(before[k]) !== canonicalJson(sent[k]));
  return [...new Set(changed.map((k) => (k === "savedFilter" ? "query" : k)))].sort();
}

export const createBoardSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.nativeEnum(BoardType).default(BoardType.KANBAN),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const updateBoardSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.nativeEnum(BoardType).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
  // Which team owns this board; null shares it with the whole project. Nullable
  // rather than optional-undefined so "share it again" is expressible — the
  // undefined case means "leave as-is", which is a different instruction.
  teamId: z.string().uuid().nullable().optional(),
});

export const boardColumnSchema = z.object({
  id: z.string().uuid().nullish(),
  name: z.string().min(1).max(50),
  key: z.string().min(1).max(30),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  wipLimit: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int(),
  category: z.nativeEnum(ColumnCategory).optional(),
});

export const replaceColumnsSchema = z.object({
  columns: z.array(boardColumnSchema),
});

/**
 * Delivery boards that start with the project's workflow as their columns
 * (COSMOS-231). Their columns come from seedBoardColumns, never also from the
 * registry's defaultColumns, so a type can't get both.
 */
const SEEDED_FROM_PROJECT = new Set<BoardType>([BoardType.KANBAN, BoardType.SCRUM]);

/** One board, as `GET .../boards/:boardId` answers it. Hidden and missing are the same 404. */
export async function getBoard(ctx: AuthContext, projectId: string, boardId: string) {
  await requireProjectRead(ctx, projectId, "BOARD_READ");
  const board = await prisma.board.findFirst({
    where: { id: boardId, projectId, orgId: ctx.orgId },
    include: { columns: { orderBy: { sortOrder: "asc" } } },
  });
  // Throws NotFoundError for a board on another team as well as for one that
  // does not exist — deliberately the same answer. A 403 here would confirm the
  // board exists, which is the one fact team scoping is meant to withhold.
  await requireBoardRead(ctx, projectId, board);
  return boardForReader((await withStatusCategories(prisma, projectId, [board!]))[0], ctx.userId);
}

/** Create a board in a project: `POST .../boards`, and the assistant's `create_board`. */
export async function createBoard(ctx: AuthContext, projectId: string, input: unknown, meta: BoardWriteMeta = {}) {
  const orgId = ctx.orgId;
  await requireProjectVisible(ctx, projectId);
  // Inheriting authority, now including the PROJECT role: an org-wide
  // BOARD_CREATE holder, or a MANAGER/LEAD of this project. A project VIEWER
  // is refused even holding the org bit — that is what the label promises.
  if (!(await canManageBoardsInProject(ctx, projectId))) {
    throw new ForbiddenError("You do not have permission to create boards in this project");
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
  if (!project) throw new NotFoundError("Not found");

  const data = createBoardSchema.parse(input);
  assertWidgetLinks(data.config);

  // Respect the project's board-type allow-list (settings.disabledBoardTypes).
  const disabledTypes =
    ((project.settings as { disabledBoardTypes?: string[] } | null)?.disabledBoardTypes) ?? [];
  if (disabledTypes.includes(data.type)) {
    throw new ForbiddenError("This board type is disabled for this project");
  }

  const maxSort = await prisma.board.aggregate({ where: { projectId }, _max: { sortOrder: true } });
  const slug = await uniqueBoardSlug(data.name, projectId);
  const seeded = SEEDED_FROM_PROJECT.has(data.type);
  const board = await prisma.$transaction(async (tx) => {
    const row = await tx.board.create({
      data: {
        orgId,
        projectId,
        name: data.name,
        slug,
        type: data.type,
        // The creator owns it, so they can keep changing what they made — its
        // name and its widget layout — without managing the project
        // (`canManageOwnBoard`). Nothing else about the board changes: it is
        // still the project's board, visible to everyone who could see it. The
        // assistant creates as the user it acts for, so that user owns it.
        ownerId: ctx.userId,
        config: (data.config ?? {}) as Prisma.InputJsonValue,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        // Types whose columns ARE their structure get them at creation. A retro
        // board with no columns opens with nowhere to put a note, which reads
        // as a broken feature rather than an unconfigured one.
        columns: {
          create: (seeded ? [] : (BOARD_TYPE_REGISTRY[data.type].defaultColumns ?? [])).map(
            (c, i) => ({ ...c, sortOrder: i }),
          ),
        },
      },
    });
    // A new Kanban or Scrum board (Issues' "Save as board", the gallery, the
    // assistant) shows the project's workflow: the main Kanban board's columns,
    // or the default ones. Through the status provisioning path, so every
    // column is a view onto a status that exists.
    if (seeded) await seedBoardColumns(tx, row, await kanbanColumnsFor(tx, projectId));
    return tx.board.findUniqueOrThrow({
      where: { id: row.id },
      include: { columns: { orderBy: { sortOrder: "asc" } } },
    });
  });

  await logAudit({
    orgId,
    userId: ctx.userId,
    action: "board.created",
    entity: "board",
    entityId: board.id,
    metadata: { name: data.name, type: data.type } as Record<string, string>,
    ipAddress: meta.ipAddress ?? undefined,
  });
  return boardForReader(board, ctx.userId);
}

/** Update a board's name, type, baseline (`config`), order or team: `PUT .../boards/:boardId`. */
export async function updateBoard(
  ctx: AuthContext,
  projectId: string,
  boardId: string,
  input: unknown,
  meta: BoardWriteMeta = {},
  opts: BoardUpdateOptions = {},
) {
  const orgId = ctx.orgId;
  // Visible first: an org-wide BOARD_UPDATE holder kept out of a team-scoped
  // project must not change its boards. Then the authority: org-wide
  // BOARD_UPDATE or a MANAGER of the project that owns this board, through
  // `canAdministerProject`, which also holds an API key (or an assistant
  // limited to some projects) to its projects. The routes used to inline
  // `hasPermission || canManageProject`, whose first branch checked neither.
  await requireProjectVisible(ctx, projectId);
  const managesBoards = await canAdministerProject(ctx, projectId, Permission.BOARD_UPDATE);

  const existing = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });

  // …or the person who made this board (`canManageOwnBoard`). Asked only when
  // the manager gate said no, and answered with the SAME 403, whether the board
  // is missing or someone else's, so a member probing ids learns nothing they
  // could not learn before. The owner path stands on the board being theirs to
  // SEE as well: a creator later shut out of the project's boards must not keep
  // editing one through a URL.
  if (!managesBoards) {
    if (!existing || !(await canManageOwnBoard(ctx, projectId, existing))) throw new ForbiddenError(NOT_A_BOARD_MANAGER);
    await requireProjectRead(ctx, projectId, "BOARD_READ");
  }
  if (!existing) throw new NotFoundError("Board not found");
  // The team axis, as every by-id board surface asks it: a board on a team the
  // caller is not on is a board that is not there, for writes as for reads.
  // Without it, an org-wide BOARD_UPDATE holder outside the team could change
  // a board they cannot open, and a creator whose board was moved to another
  // team could keep changing it.
  await requireBoardRead(ctx, projectId, existing);

  const data = updateBoardSchema.parse(input);

  // A creator may rename their board and change its layout. Team, type and tab
  // order are project-management acts: they change how the project is
  // organised for everyone, not what this one board shows.
  if (!managesBoards) {
    const beyond = (Object.keys(data) as Array<keyof typeof data>).filter(
      (k) => data[k] !== undefined && !(OWNER_EDITABLE_BOARD_FIELDS as readonly string[]).includes(k),
    );
    if (beyond.length > 0) throw new ForbiddenError(`Only a project manager can change a board's ${beyond.join(", ")}.`);
  }

  assertWidgetLinks(data.config);

  // A team id from another project would otherwise be accepted and make the
  // board invisible to everyone on THIS one — the FK only proves the team
  // exists, not that it is relevant here.
  if (data.teamId) {
    const team = await prisma.team.findFirst({ where: { id: data.teamId, projectId }, select: { id: true } });
    if (!team) throw new ProblemError(400, "invalid_request", "That team is not part of this project.");
  }

  // A manager writes the config they send. A creator writes only its layout
  // keys over what is stored (`mergeOwnerConfig`): the rest of a board's config
  // (its query, its classification, a ceremony board's showNoteAuthors) is not
  // theirs, even when the builder echoes it back.
  let config = data.config;
  if (config !== undefined && !managesBoards) {
    const ignored = opts.refuseIgnoredConfig ? ignoredOwnerConfigKeys(existing.config, config) : [];
    if (ignored.length > 0) throw new ForbiddenError(`Only a project manager can change a board's ${ignored.join(", ")}.`);
    config = mergeOwnerConfig(existing.config, config);
  }

  const updated = await prisma.board.update({
    where: { id: boardId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.type !== undefined && { type: data.type }),
      ...(config !== undefined && { config: config as Prisma.InputJsonValue }),
      ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      ...(data.teamId !== undefined && { teamId: data.teamId }),
    },
    include: { columns: { orderBy: { sortOrder: "asc" } } },
  });

  await logAudit({
    orgId,
    userId: ctx.userId,
    action: "board.updated",
    entity: "board",
    entityId: boardId,
    metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
    ipAddress: meta.ipAddress ?? undefined,
  });
  return boardForReader((await withStatusCategories(prisma, projectId, [updated]))[0], ctx.userId);
}

/** Delete a board: `DELETE .../boards/:boardId`. Its work items are untouched. */
export async function deleteBoard(ctx: AuthContext, projectId: string, boardId: string, meta: BoardWriteMeta = {}) {
  const orgId = ctx.orgId;
  // As updateBoard: visible, then org-wide BOARD_DELETE or project MANAGER, or
  // the board's own creator, with the same 403 for missing and not-theirs.
  await requireProjectVisible(ctx, projectId);
  const managesBoards = await canAdministerProject(ctx, projectId, Permission.BOARD_DELETE);

  const existing = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });
  if (!managesBoards) {
    if (!existing || !(await canManageOwnBoard(ctx, projectId, existing))) throw new ForbiddenError(NOT_A_BOARD_MANAGER);
    await requireProjectRead(ctx, projectId, "BOARD_READ");
  }
  if (!existing) throw new NotFoundError("Board not found");
  // Team axis, as in updateBoard: a hidden board is a missing one.
  await requireBoardRead(ctx, projectId, existing);
  // Deleting a board cascades to its ceremonies and every note on them: other
  // people's writing. That is a manager's call, whoever made the board.
  if (!managesBoards && (await prisma.sprintCeremony.count({ where: { boardId: existing.id } })) > 0) {
    throw new ForbiddenError("This board has ceremony notes on it. Only a project manager can delete it.");
  }

  await prisma.board.delete({ where: { id: boardId } });

  await logAudit({
    orgId,
    userId: ctx.userId,
    action: "board.deleted",
    entity: "board",
    entityId: boardId,
    metadata: { name: existing.name } as Record<string, string>,
    ipAddress: meta.ipAddress ?? undefined,
  });
  return { id: existing.id, name: existing.name };
}

/**
 * Replace a board's columns (every column, in order): `PUT .../boards/:boardId/columns`.
 * A delivery board's columns are views onto statuses, so this provisions,
 * renames and restores statuses as the route always has.
 */
export async function replaceBoardColumns(
  ctx: AuthContext,
  projectId: string,
  boardId: string,
  input: unknown,
  meta: BoardWriteMeta = {},
) {
  const orgId = ctx.orgId;
  // A project the caller cannot see first, whatever bit they hold: an org-wide
  // holder passes the gate below for every project. Its boards are not there,
  // with the same NotFound as a missing board.
  if (!(await isProjectVisible(ctx, projectId))) throw new NotFoundError("Board not found");
  // Org-wide BOARD_UPDATE or project MANAGER, inside a key's project ceiling.
  await requireProjectManage(ctx, projectId, Permission.BOARD_UPDATE);

  const board = await prisma.board.findFirst({ where: { id: boardId, projectId, orgId } });
  // The team axis: a board you may not open is a board whose columns you may
  // not read or restructure. Same NotFound for hidden as for missing.
  await requireBoardRead(ctx, projectId, board);

  const { columns } = replaceColumnsSchema.parse(input);

  const result = await prisma.$transaction(async (tx) => {
    const existingColumns = await tx.boardColumn.findMany({
      where: { boardId },
      select: { id: true, key: true, category: true },
    });
    const existingIds = existingColumns.map((c) => c.id);

    // A delivery board's columns are views onto the project's statuses, so
    // every column must name one. A key edited on an existing column renames
    // its status when no other board still shows the old key, so the items
    // follow instead of being left on a key nothing shows; then each column's
    // status is made sure of. Deleting a column only removes the view: its
    // status and items stay. Ceremony boards are prompts, not statuses, and
    // are left out of all of this.
    //
    // A column's category is its status's (design §6.4): it is set on the
    // status, in Settings → Workflows. Here it only names the category of a
    // status the column creates, or brings back from the archive.
    // The keys of the columns that start showing a status in this save.
    const touchedKeys: string[] = [];
    if (board && boardShowsStatuses(board.type)) {
      for (const col of columns) {
        const before = existingColumns.find((c) => c.id === col.id);
        if (before && before.key !== col.key) {
          await renameStatusIfUnshared(tx, { projectId, from: before.key, to: col.key, columnId: before.id });
        }
      }
      const known = new Map(
        (
          await tx.workflowStatus.findMany({
            where: { projectId, key: { in: columns.map((c) => c.key) } },
            select: { key: true, category: true, archivedAt: true },
          })
        ).map((st) => [st.key, st]),
      );
      for (const c of columns) {
        const status = known.get(c.key);
        const before = existingColumns.find((e) => e.id === c.id);
        // Sent back as it was (even where a conflicted board's lane disagrees
        // with its status) is fine; a new category is the workflow editor's.
        if (status && !status.archivedAt && c.category && c.category !== status.category && c.category !== before?.category) {
          throw new ConflictError(`A column's category is its status's: change "${c.key}" in Settings → Workflows.`);
        }
      }
      // A new status in a project on a custom workflow is a workflow change.
      if (columns.some((c) => !known.has(c.key)) && (await tx.workflowAssignment.count({ where: { projectId } })) > 0) {
        await requireProjectManage(ctx, projectId, Permission.WORKFLOW_MANAGE);
      }
      await ensureStatuses(
        tx,
        { orgId, projectId },
        columns.map((c) => {
          const before = existingColumns.find((e) => e.id === c.id);
          // A save sends every column. Only a column that starts showing a
          // status here (new, or re-keyed) may restore it from the archive.
          const shows = !before || before.key !== c.key;
          if (shows) touchedKeys.push(c.key);
          return { key: c.key, name: c.name, color: c.color, category: c.category, sortOrder: c.sortOrder, restore: shows };
        }),
      );
    }

    const incomingIds = columns.filter((c) => c.id).map((c) => c.id!);
    const toDelete = existingIds.filter((id) => !incomingIds.includes(id));

    if (toDelete.length > 0) {
      await tx.boardColumn.deleteMany({ where: { id: { in: toDelete } } });
    }

    for (const col of columns) {
      if (col.id && existingIds.includes(col.id)) {
        await tx.boardColumn.update({
          where: { id: col.id },
          data: {
            name: col.name,
            key: col.key,
            color: col.color ?? undefined,
            wipLimit: col.wipLimit ?? null,
            sortOrder: col.sortOrder,
          },
        });
      } else {
        await tx.boardColumn.create({
          data: {
            boardId,
            name: col.name,
            key: col.key,
            color: col.color ?? "#7dd3fc",
            wipLimit: col.wipLimit ?? null,
            sortOrder: col.sortOrder,
            category: col.category ?? "TODO",
          },
        });
      }
    }

    // A column that starts showing a status here stores the status's
    // category, so it is never mistaken for a lane the backfill found
    // conflicting (column-categories.server.ts). Columns sent back as they
    // were keep theirs: a conflicted lane's counts until it is resolved.
    if (board && boardShowsStatuses(board.type) && touchedKeys.length > 0) {
      await tx.$executeRaw`
        UPDATE board_columns bc SET category = s.category
        FROM workflow_statuses s
        WHERE bc.board_id = ${boardId}::uuid AND s.project_id = ${projectId}::uuid
          AND s.key = bc.key AND bc.category <> s.category
          AND bc.key = ANY(${touchedKeys}::text[])
      `;
    }

    const saved = await tx.boardColumn.findMany({ where: { boardId }, orderBy: { sortOrder: "asc" } });
    return board ? (await withStatusCategories(tx, projectId, [{ type: board.type, columns: saved }]))[0].columns : saved;
  });

  await logAudit({
    orgId,
    userId: ctx.userId,
    action: "board.columns_updated",
    entity: "board",
    entityId: boardId,
    metadata: { columnCount: String(columns.length) } as Record<string, string>,
    ipAddress: meta.ipAddress ?? undefined,
  });
  return result;
}

/** The columns a new Kanban board starts with: the project's first Kanban board's, else the defaults. */
async function kanbanColumnsFor(tx: Prisma.TransactionClient, projectId: string): Promise<ColumnSpec[]> {
  const primary = await tx.board.findFirst({
    where: { projectId, type: BoardType.KANBAN, columns: { some: {} } },
    orderBy: { sortOrder: "asc" },
    select: { columns: { orderBy: { sortOrder: "asc" }, select: { name: true, key: true, color: true, category: true } } },
  });
  const columns = primary?.columns ?? DEFAULT_COLUMNS;
  return columns.map((c, i) => ({ name: c.name, key: c.key, color: c.color, category: c.category, sortOrder: i }));
}
