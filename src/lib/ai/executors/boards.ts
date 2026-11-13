import { prisma } from "@/lib/db/client";
import { z } from "zod";
import { BoardType, ColumnCategory } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import { narrowBoards } from "@/lib/rbac/board-access";
import { createBoard, deleteBoard, getBoard, replaceBoardColumns, updateBoard } from "@/lib/boards/board-service.server";
import { boardConfigFromQuery } from "@/lib/boards/board-query";
import { BOARD_TYPE_REGISTRY, savableFromViewTypes } from "@/lib/boards/board-types";
import { prepareCql } from "@/lib/query/execute.server";
import { CqlError } from "@/lib/query/errors";
import { CQL_LIMITS, type CqlQuery } from "@/lib/query/ast";
import { validateAst } from "@/lib/query/normalize";
import { presentQuery, viewerScope } from "@/lib/query/saved-filters.server";
import { cfTypesFor } from "@/lib/query/saved-filter-input.server";
import {
  assertPermission,
  assertProjectManage,
  assertProjectRead,
  loadAuthContext,
  serviceRefusal,
  type ToolContext,
} from "./_ctx";
import { cqlOrg, diagnosticsForModel } from "./cql";

/**
 * Board executors. Mirror `api/v1/orgs/[orgId]/projects/[projectId]/boards`
 * (GET, POST), `.../boards/[boardId]` (GET, PUT, DELETE) and
 * `.../boards/[boardId]/columns` (PUT).
 *
 * The writes call the SAME board service those routes call
 * (`board-service.server.ts`), so the gate, the board-type allow-list, column
 * seeding and the audit row cannot drift from what the app does. That includes
 * who may change a board: a manager of the project's boards, or the person who
 * made it (a dashboard's creator renames it and deletes it without managing the
 * project). What a tool adds in front is only what a conversation needs: the
 * project is checked for visibility first, so a project the caller cannot open
 * reads as absent rather than forbidden, and a board on another team reads as
 * absent too. A tool must not pre-check the manager gate itself: that would
 * refuse the creator the app lets through.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

const listSchema = z.object({ projectId: z.string().uuid() });

export async function listBoards(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.BOARD_READ);
  if (denied) return denied;

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId } = parsed.data;

  const outOfScope = await assertProjectRead(ctx, projectId, "BOARD_READ");
  if (outOfScope) return outOfScope;

  const boards = await prisma.board.findMany({
    where: { orgId: ctx.orgId, projectId },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      projectId: true,
      type: true,
      sortOrder: true,
      name: true,
      createdAt: true,
      // Selected for the gate below, then dropped from the reply: which team
      // owns a board is not something the assistant needs to say out loud.
      teamId: true,
    },
  });

  // The TEAM axis, which `assertProjectRead` does not cover — it answers only
  // "may they open this project". Without this the assistant listed boards the
  // sidebar hides: the same second-surface gap as 2.265.3, one axis further in.
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Not a member of this organization" };
  const visible = await narrowBoards(auth, projectId, boards);

  return {
    count: visible.length,
    boards: visible.map(({ teamId: _teamId, ...rest }) => rest),
  };
}

// ── shared ──────────────────────────────────────────────────────────────────

const boardRef = z.object({ projectId: z.string().uuid(), boardId: z.string().uuid() });

/**
 * Where the board opens in the app, and its project's key (the chat's artifact
 * card builds the same link from it).
 */
async function boardLink(orgId: string, projectId: string, board: { id: string; slug: string | null }) {
  const [org, project] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { key: true } }),
  ]);
  if (!org || !project) return {};
  return { projectKey: project.key, path: `/${org.slug}/projects/${project.key}/boards/${board.slug ?? board.id}` };
}

/** The board's stored baseline query, if it has one that still parses. */
function storedBoardQuery(config: unknown): CqlQuery | null {
  const raw = config && typeof config === "object" ? (config as Record<string, unknown>).query : undefined;
  if (raw == null) return null;
  return validateAst(raw).query ?? null;
}

/**
 * Turn the model's CQL into the board's baseline config, through the SAME
 * prepare step the Issues list runs (scope, typecheck, resolve). Refuses when
 * the org has the query language off or the query does not check.
 */
async function baselineFrom(
  ctx: ToolContext,
  projectId: string,
  cql: string,
): Promise<{ config: Record<string, unknown>; cql: string } | { error: string; diagnostics?: unknown }> {
  const org = await cqlOrg(ctx);
  if ("error" in org) return org;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  try {
    const prepared = await prepareCql(auth, { cql }, { contextProjectId: projectId });
    return { config: boardConfigFromQuery(prepared.query, await cfTypesFor(ctx.orgId)), cql: prepared.cql };
  } catch (e) {
    if (e instanceof CqlError) {
      return { error: `${e.message} Fix the query and try again.`, diagnostics: diagnosticsForModel(e.diagnostics) };
    }
    throw e;
  }
}

function columnsForModel(columns: Array<{ id: string; key: string; name: string; category: string; wipLimit: number | null }>) {
  return columns.map((c) => ({ id: c.id, key: c.key, name: c.name, category: c.category, wipLimit: c.wipLimit }));
}

// ── get_board ───────────────────────────────────────────────────────────────

export async function getBoardTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.BOARD_READ);
  if (denied) return denied;
  const parsed = boardRef.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, boardId } = parsed.data;

  const outOfScope = await assertProjectRead(ctx, projectId, "BOARD_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  try {
    const board = await getBoard(auth, projectId, boardId);
    const query = storedBoardQuery(board.config);
    // Printed for THIS viewer: a value they cannot resolve prints as
    // ‹restricted›, exactly as a saved filter does, so a board's baseline
    // cannot name a project or person the caller may not see.
    const baseline = query ? await presentQuery(await viewerScope(auth), query) : null;
    // Wrapped as `board`, so a withheld (gov) result keeps its structural
    // fields: the egress projection drops a bare top-level string.
    return {
      board: {
        id: board.id,
        projectId: board.projectId,
        type: board.type,
        name: board.name,
        sortOrder: board.sortOrder,
        createdAt: board.createdAt,
      },
      ...(await boardLink(ctx.orgId, projectId, board)),
      baseline: baseline ? { cql: baseline.cql, partiallyRestricted: baseline.partiallyRestricted, ...(baseline.broken ? { broken: baseline.broken } : {}) } : null,
      columns: columnsForModel(board.columns),
    };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal;
    throw e;
  }
}

// ── create_board ────────────────────────────────────────────────────────────

const createSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  type: z.nativeEnum(BoardType).optional(),
  cql: z.string().trim().max(CQL_LIMITS.textLength).optional(),
});

export async function createBoardTool(input: Record<string, unknown>, ctx: ToolContext) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, name, cql } = parsed.data;
  const type = parsed.data.type ?? BoardType.KANBAN;

  // Visibility first, so a project the caller cannot open reads as absent. The
  // authority to create is the board service's (`canManageBoardsInProject`,
  // the route's own gate): an org-wide BOARD_CREATE holder, or a MANAGER/LEAD
  // of this project. Pre-checking the org bit here would refuse that manager.
  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  let config: Record<string, unknown> = {};
  let baseline: string | undefined;
  if (cql) {
    // Only the types that read `config.query` can show a query; on any other
    // the baseline would be stored and silently ignored.
    if (!savableFromViewTypes().includes(type)) {
      return {
        error: `A ${BOARD_TYPE_REGISTRY[type].label} board cannot show a query. Use one of: ${savableFromViewTypes().join(", ")}.`,
      };
    }
    const from = await baselineFrom(ctx, projectId, cql);
    if ("error" in from) return from;
    config = from.config;
    baseline = from.cql;
  }

  try {
    const board = await createBoard(auth, projectId, { name, type, config });
    return {
      created: true,
      id: board.id,
      board: { id: board.id, projectId, type: board.type, name: board.name },
      ...(baseline !== undefined ? { baseline } : {}),
      columnCount: board.columns.length,
      ...(await boardLink(ctx.orgId, projectId, board)),
    };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal;
    throw e;
  }
}

// ── update_board ────────────────────────────────────────────────────────────

const updateSchema = boardRef.extend({
  name: z.string().trim().min(1).max(100).optional(),
  // "" clears the baseline: the board shows everything in its project again.
  cql: z.string().trim().max(CQL_LIMITS.textLength).optional(),
});

export async function updateBoardTool(input: Record<string, unknown>, ctx: ToolContext) {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, boardId, name, cql } = parsed.data;
  if (name === undefined && cql === undefined) return { error: "Nothing to change: give a new name or a query." };

  // Visibility here; the authority is the board service's own, the route's
  // gate: org-wide BOARD_UPDATE, managing this project, or having made this
  // board (a dashboard's creator may rename it, not change its query).
  const outOfScope = await assertProjectRead(ctx, projectId, "BOARD_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  try {
    // Read through the board's own gate first (team axis: a hidden board reads
    // as absent), and to MERGE the config — PUT replaces `config` whole, and a
    // board keeps more than its query there (a builder layout, a Table's types).
    const existing = await getBoard(auth, projectId, boardId);
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    let baseline: string | null | undefined;
    if (cql !== undefined) {
      const current = { ...((existing.config as Record<string, unknown> | null) ?? {}) };
      delete current.query;
      delete current.savedFilter;
      if (cql === "") {
        patch.config = current;
        baseline = null;
      } else {
        if (!savableFromViewTypes().includes(existing.type)) {
          return { error: `A ${BOARD_TYPE_REGISTRY[existing.type].label} board cannot show a query.` };
        }
        const from = await baselineFrom(ctx, projectId, cql);
        if ("error" in from) return from;
        patch.config = { ...current, ...from.config };
        baseline = from.cql;
      }
    }
    // A change the caller may not make (a creator changing the query) is
    // refused, not kept at its stored value: this reply says what changed.
    const updated = await updateBoard(auth, projectId, boardId, patch, {}, { refuseIgnoredConfig: true });
    return {
      updated: true,
      id: updated.id,
      board: { id: updated.id, projectId, type: updated.type, name: updated.name },
      ...(baseline !== undefined ? { baseline } : {}),
      ...(await boardLink(ctx.orgId, projectId, updated)),
    };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal;
    throw e;
  }
}

// ── set_board_columns ───────────────────────────────────────────────────────

const columnInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(50),
  key: z.string().trim().min(1).max(30),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  wipLimit: z.number().int().min(0).nullable().optional(),
  category: z.nativeEnum(ColumnCategory).optional(),
});
const columnsSchema = boardRef.extend({ columns: z.array(columnInput).min(1).max(30) });

export async function setBoardColumns(input: Record<string, unknown>, ctx: ToolContext) {
  const parsed = columnsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, boardId, columns } = parsed.data;

  const denied = await assertProjectManage(ctx, projectId, Permission.BOARD_UPDATE);
  if (denied) return denied;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  try {
    const existing = await getBoard(auth, projectId, boardId);
    // A column named by key keeps its id (and so its wip limit and history); an
    // id the board does not have is dropped rather than trusted.
    const byKey = new Map(existing.columns.map((c) => [c.key, c.id]));
    const ids = new Set(existing.columns.map((c) => c.id));
    const saved = await replaceBoardColumns(auth, projectId, boardId, {
      columns: columns.map((c, i) => ({
        id: c.id && ids.has(c.id) ? c.id : (byKey.get(c.key) ?? null),
        name: c.name,
        key: c.key,
        color: c.color ?? null,
        wipLimit: c.wipLimit ?? null,
        sortOrder: i,
        ...(c.category ? { category: c.category } : {}),
      })),
    });
    return { updated: true, board: { id: boardId, projectId }, columns: columnsForModel(saved) };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal;
    throw e;
  }
}

// ── delete_board ────────────────────────────────────────────────────────────

export async function deleteBoardTool(input: Record<string, unknown>, ctx: ToolContext) {
  const parsed = boardRef.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, boardId } = parsed.data;

  // Visibility here; the authority (a manager, or the board's creator while no
  // ceremony hangs off it) is the board service's, as for update_board.
  const outOfScope = await assertProjectRead(ctx, projectId, "BOARD_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  try {
    // A board on another team reads as absent here, as it does in the app.
    await getBoard(auth, projectId, boardId);
    const gone = await deleteBoard(auth, projectId, boardId);
    return { deleted: true, id: gone.id, board: { id: gone.id, projectId, name: gone.name } };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal;
    throw e;
  }
}
