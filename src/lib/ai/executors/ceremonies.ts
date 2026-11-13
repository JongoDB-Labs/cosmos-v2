import { CeremonyKind } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import {
  addCeremonyAction,
  addCeremonyNote,
  closeCeremony,
  deleteCeremonyAction,
  deleteCeremonyNote,
  findDefaultCeremonyInterval,
  getCeremonyPayload,
  listCeremonyBoards,
  openCeremony,
  promoteCeremonyAction,
  updateCeremonyAction,
  updateCeremonyNote,
  type CeremonyCaller,
  type CeremonyScope,
} from "@/lib/intervals/ceremony.server";
import {
  assertPermission,
  assertProjectRead,
  loadAuthContext,
  serviceRefusal,
  type ToolContext,
} from "./_ctx";

/**
 * Sprint ceremony executors. Each one calls the SAME function the matching
 * route calls (lib/intervals/ceremony.server.ts), so the gate is the route's:
 * any project member may add, edit and delete notes and actions; opening and
 * closing need the facilitator's SPRINT_COMPLETE or a project manager;
 * promoting needs ITEM_CREATE or a project manager.
 *
 * Every executor first checks SPRINT_READ, before parsing. That is not a gate
 * the route lacks: every ceremony route's gate begins with `requireProjectRead`
 * on SPRINT_READ (a key's SPRINT_CREATE comes with SPRINT_READ in every scope
 * that grants it), so it refuses no one the route admits.
 *
 * The service also checks the BOARD's team on every call, for the tools and
 * the routes alike: a ceremony on a board narrowed to another team reads as
 * not found.
 */

const TOOL_CALLER: CeremonyCaller = { source: "AI" };

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

/** A refusal thrown by the shared service, in the route's words; anything else is rethrown. */
function refusalOrThrow(e: unknown): { error: string } {
  const refused = serviceRefusal(e);
  if (refused) return refused;
  throw e;
}

/**
 * The project gate every ceremony tool passes, then the caller's own
 * AuthContext for the shared service.
 */
async function projectGate(
  ctx: ToolContext,
  projectId: string,
): Promise<{ auth: AuthContext } | { error: string }> {
  const outOfScope = await assertProjectRead(ctx, projectId, "SPRINT_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };
  return { auth };
}

const scopeFields = {
  projectId: z.string().uuid(),
  intervalId: z.string().uuid(),
};

function scopeOf(ctx: ToolContext, data: { projectId: string; intervalId: string }): CeremonyScope {
  return { orgId: ctx.orgId, projectId: data.projectId, intervalId: data.intervalId };
}

// ── get_ceremony ─────────────────────────────────────────────────────────────
const getSchema = z.object({
  projectId: z.string().uuid(),
  intervalId: z.string().uuid().optional(),
  boardId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
});

/**
 * Without a boardId, the boards to choose from (the read needs one, and no
 * other tool returns a ceremony board). With one, the board's full review.
 * Without an intervalId, the sprint the board itself would open on.
 */
export async function getCeremony(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = getSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, boardId, teamId } = parsed.data;

  const gate = await projectGate(ctx, projectId);
  if ("error" in gate) return gate;

  try {
    let intervalId = parsed.data.intervalId;
    if (!intervalId) {
      const fallback = await findDefaultCeremonyInterval(gate.auth, ctx.orgId, projectId);
      if (!fallback) {
        return { interval: null, boards: [], note: "This project has no sprint yet, so there is no ceremony to show." };
      }
      intervalId = fallback.id;
    }
    const scope = scopeOf(ctx, { projectId, intervalId });

    if (!boardId) return await listCeremonyBoards(gate.auth, scope);

    const p = await getCeremonyPayload(gate.auth, scope, { boardId, teamId: teamId ?? null });
    const config = (p.board.config ?? {}) as { showNoteAuthors?: boolean };
    return {
      sprint: p.sprint,
      board: { id: p.board.id, name: p.board.name, type: p.board.type, showsNoteAuthors: !!config.showNoteAuthors },
      columns: p.columns.map((c) => ({ key: c.key, name: c.name })),
      metrics: p.metrics,
      shipped: p.shipped.map((i) => ({ id: i.id, ticketNumber: i.ticketNumber, title: i.title, storyPoints: i.storyPoints })),
      carried: {
        kind: p.carried.kind,
        items: p.carried.items.map((i) => ({ id: i.id, ticketNumber: i.ticketNumber, title: i.title, statusLabel: i.statusLabel })),
      },
      nextSprint: p.nextSprint,
      ceremony: p.ceremony
        ? {
            id: p.ceremony.id,
            kind: p.ceremony.kind,
            status: p.ceremony.status,
            closedAt: p.ceremony.closedAt,
            // `authorId` is already withheld by the service unless the board
            // shows authors, exactly as the board itself renders it.
            notes: p.ceremony.notes,
            actionItems: p.ceremony.actionItems.map((a) => ({
              id: a.id,
              text: a.text,
              ownerId: a.ownerId,
              dueDate: a.dueDate,
              workItemId: a.workItemId,
            })),
          }
        : null,
    };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

// ── open_ceremony / close_ceremony ───────────────────────────────────────────
const openSchema = z.object({
  ...scopeFields,
  boardId: z.string().uuid(),
  kind: z.nativeEnum(CeremonyKind),
});

export async function openCeremonyTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = openSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { boardId, kind } = parsed.data;

  const gate = await projectGate(ctx, parsed.data.projectId);
  if ("error" in gate) return gate;

  try {
    const ceremony = await openCeremony(gate.auth, scopeOf(ctx, parsed.data), async () => ({ boardId, kind }), TOOL_CALLER);
    return { opened: true, ceremony };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

const closeSchema = z.object({ ...scopeFields, ceremonyId: z.string().uuid() });

export async function closeCeremonyTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ceremonyId } = parsed.data;

  const gate = await projectGate(ctx, parsed.data.projectId);
  if ("error" in gate) return gate;

  try {
    const ceremony = await closeCeremony(gate.auth, scopeOf(ctx, parsed.data), async () => ({ ceremonyId }), TOOL_CALLER);
    return { closed: true, ceremony };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

// ── notes ────────────────────────────────────────────────────────────────────
const addNoteSchema = z.object({
  ...scopeFields,
  ceremonyId: z.string().uuid(),
  columnKey: z.string().min(1),
  text: z.string(),
});

export async function addCeremonyNoteTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = addNoteSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ceremonyId, columnKey, text } = parsed.data;

  const gate = await projectGate(ctx, parsed.data.projectId);
  if ("error" in gate) return gate;

  try {
    const note = await addCeremonyNote(gate.auth, scopeOf(ctx, parsed.data), async () => ({ ceremonyId, columnKey, text }));
    return { created: true, note: { id: note.id, columnKey: note.columnKey, createdAt: note.createdAt } };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

const editNoteSchema = z.object({ ...scopeFields, noteId: z.string().uuid(), text: z.string() });

export async function updateCeremonyNoteTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = editNoteSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { noteId, text } = parsed.data;

  const gate = await projectGate(ctx, parsed.data.projectId);
  if ("error" in gate) return gate;

  try {
    const note = await updateCeremonyNote(gate.auth, scopeOf(ctx, parsed.data), noteId, async () => ({ text }));
    return { updated: true, note: { id: note.id } };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

const deleteNoteSchema = z.object({ ...scopeFields, noteId: z.string().uuid() });

export async function deleteCeremonyNoteTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = deleteNoteSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  const gate = await projectGate(ctx, parsed.data.projectId);
  if ("error" in gate) return gate;

  try {
    const { id } = await deleteCeremonyNote(gate.auth, scopeOf(ctx, parsed.data), parsed.data.noteId);
    return { deleted: true, id };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

// ── action items ─────────────────────────────────────────────────────────────
const addActionSchema = z.object({
  ...scopeFields,
  ceremonyId: z.string().uuid(),
  text: z.string(),
  ownerId: z.string().uuid().nullish(),
  dueDate: z.string().nullish(),
});

export async function addCeremonyActionTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = addActionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { ceremonyId, text, ownerId, dueDate } = parsed.data;

  const gate = await projectGate(ctx, parsed.data.projectId);
  if ("error" in gate) return gate;

  try {
    const action = await addCeremonyAction(
      gate.auth,
      scopeOf(ctx, parsed.data),
      async () => ({ ceremonyId, text, ownerId, dueDate }),
    );
    return {
      created: true,
      action: { id: action.id, ownerId: action.ownerId, dueDate: action.dueDate, createdAt: action.createdAt },
    };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

const editActionSchema = z.object({
  ...scopeFields,
  actionId: z.string().uuid(),
  text: z.string().optional(),
  ownerId: z.string().uuid().nullish(),
  dueDate: z.string().nullish(),
});

export async function updateCeremonyActionTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = editActionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  // Only the fields the caller named: an absent field is unchanged, a null clears.
  const { projectId, intervalId, actionId, ...changes } = parsed.data;

  const gate = await projectGate(ctx, projectId);
  if ("error" in gate) return gate;

  try {
    const action = await updateCeremonyAction(
      gate.auth,
      scopeOf(ctx, { projectId, intervalId }),
      actionId,
      async () => changes,
    );
    return {
      updated: true,
      action: { id: action.id, ownerId: action.ownerId, dueDate: action.dueDate, workItemId: action.workItemId },
    };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

const actionRefSchema = z.object({ ...scopeFields, actionId: z.string().uuid() });

export async function deleteCeremonyActionTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = actionRefSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  const gate = await projectGate(ctx, parsed.data.projectId);
  if ("error" in gate) return gate;

  try {
    const out = await deleteCeremonyAction(gate.auth, scopeOf(ctx, parsed.data), parsed.data.actionId);
    return { deleted: true, id: out.id, promotedWorkItemId: out.promotedWorkItemId };
  } catch (e) {
    return refusalOrThrow(e);
  }
}

export async function promoteCeremonyActionTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = actionRefSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  const gate = await projectGate(ctx, parsed.data.projectId);
  if ("error" in gate) return gate;

  try {
    return await promoteCeremonyAction(gate.auth, scopeOf(ctx, parsed.data), parsed.data.actionId, TOOL_CALLER);
  } catch (e) {
    return refusalOrThrow(e);
  }
}
