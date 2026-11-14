// @vitest-environment node
//
// The ceremony tools call the routes' own service (lib/intervals/ceremony.server),
// so these specs drive REAL members from the database through the tools and
// assert the route's rules hold: who may type into a retro, who may open, close
// and promote, and what a caller outside the project, outside a board's team or
// outside a key's project scope gets back. Each refusal has a control beside it
// showing the same call succeeding for someone it should succeed for.
//
// Own org and own users; the seeded ones are never touched.
//
// Needs the local e2e DB: DATABASE_URL=postgresql://ci:ci@localhost:5441/<db>
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { memberToolCtx, stubToolCtx } from "@/lib/testing/tool-auth";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import type { OrgRole } from "@prisma/client";
import type { ToolContext } from "./_ctx";
import {
  addCeremonyActionTool,
  addCeremonyNoteTool,
  closeCeremonyTool,
  deleteCeremonyActionTool,
  deleteCeremonyNoteTool,
  getCeremony,
  openCeremonyTool,
  promoteCeremonyActionTool,
  updateCeremonyActionTool,
  updateCeremonyNoteTool,
} from "./ceremonies";

// The REST half: the routes resolve the caller through getAuthContext, so the
// specs below hand them the same member the tools use.
const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
import { POST as closeRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/close/route";
import { POST as addNoteRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/notes/route";
import { PATCH as editNoteRoute, DELETE as deleteNoteRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/notes/[noteId]/route";
import { POST as addActionRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/actions/route";
import { PATCH as editActionRoute, DELETE as deleteActionRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/actions/[actionId]/route";

type RouteHandler = (r: NextRequest, c: never) => Promise<Response>;
/** Call a ceremony route as `actor`. */
async function rest(actor: ToolContext, handler: RouteHandler, extra: Record<string, string>, method: string, body?: unknown) {
  getAuthContext.mockResolvedValue(actor.auth);
  return handler(
    new NextRequest("http://localhost/x", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: Promise.resolve({ orgId, projectId, intervalId, ...extra }) } as never,
  );
}
/** Call a ceremony route as `actor`; returns the HTTP status. */
async function asRest(actor: ToolContext, handler: RouteHandler, extra: Record<string, string>, method: string, body?: unknown) {
  return (await rest(actor, handler, extra, method, body)).status;
}

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userIds: string[] = [];
let orgId = "", projectId = "", otherProjectId = "", intervalId = "", nextIntervalId = "";
let sharedBoard = "", otherTeamBoard = "", authorsBoard = "";
/** OWNER: sees and may do everything. */
let owner: ToolContext;
/** Org MEMBER on the project and on team 1. */
let member: ToolContext;
/** Org VIEWER on the project and on team 1. */
let viewer: ToolContext;
/** Org MEMBER who MANAGES the project: holds no SPRINT_COMPLETE of their own. */
let manager: ToolContext;
/** Org MEMBER who is not on the team-scoped project at all. */
let outsider: ToolContext;
/**
 * Org MEMBER on the project and on team 1 holding SPRINT_COMPLETE of their own:
 * may run any retro they can see, but is not a project manager, so a board
 * narrowed to team 2 stays hidden from them.
 */
let facilitator: ToolContext;

type Out = Record<string, unknown> & { error?: string };
const call = async (fn: (i: Record<string, unknown>, c: ToolContext) => Promise<unknown>, input: Record<string, unknown>, ctx: ToolContext) =>
  (await fn(input, ctx)) as Out;
const at = (extra: Record<string, unknown> = {}) => ({ projectId, intervalId, ...extra });

async function user(name: string) {
  const u = await prisma.user.create({ data: { email: `${name}-${stamp}@ceremony.test`, displayName: name } });
  userIds.push(u.id);
  return u.id;
}

async function ceremonyBoard(name: string, teamId: string | null, config: object = {}) {
  return (
    await prisma.board.create({
      data: {
        orgId, projectId, teamId, name, type: "SPRINT_REVIEW", config,
        columns: {
          create: [
            { key: "went_well", name: "Went well", sortOrder: 0 },
            { key: "improve", name: "To improve", sortOrder: 1 },
          ],
        },
      },
    })
  ).id;
}

/** A RUNNING ceremony on `boardId` for this sprint, opened by the owner through the tool. */
async function running(boardId: string): Promise<string> {
  const out = await call(openCeremonyTool, at({ boardId, kind: "REVIEW" }), owner);
  expect(out.error).toBeUndefined();
  return (out.ceremony as { id: string }).id;
}

beforeAll(async () => {
  const ownerId = await user("owner");
  const memberId = await user("member");
  const viewerId = await user("viewer");
  const managerId = await user("manager");
  const outsiderId = await user("outsider");
  const facilitatorId = await user("facilitator");

  orgId = (await prisma.organization.create({ data: { name: `ceremony ${stamp}`, slug: `ceremony-${stamp}` } })).id;
  const om = async (userId: string, role: OrgRole) =>
    (await prisma.orgMember.create({ data: { orgId, userId, role } })).id;
  await om(ownerId, "OWNER");
  const memberOm = await om(memberId, "MEMBER");
  const viewerOm = await om(viewerId, "VIEWER");
  const managerOm = await om(managerId, "MEMBER");
  await om(outsiderId, "MEMBER");
  const facilitatorOm = (await prisma.orgMember.create({
    data: { orgId, userId: facilitatorId, role: "MEMBER", permissions: maskToDb(Permission.SPRINT_COMPLETE) },
  })).id;

  // teamScopedAccess is what hides the project from a non-member; without it
  // every member reads every project and there is no boundary to test.
  projectId = (await prisma.project.create({
    data: { orgId, name: "Ceremonies", key: `CR${stamp.slice(-4)}`, teamScopedAccess: true },
  })).id;
  otherProjectId = (await prisma.project.create({
    data: { orgId, name: "Elsewhere", key: `EL${stamp.slice(-4)}` },
  })).id;

  const pm = async (orgMemberId: string, role: "MANAGER" | "MEMBER") =>
    (await prisma.projectMember.create({ data: { projectId, orgMemberId, role } })).id;
  const memberPm = await pm(memberOm, "MEMBER");
  const viewerPm = await pm(viewerOm, "MEMBER");
  await pm(managerOm, "MANAGER");
  const facilitatorPm = await pm(facilitatorOm, "MEMBER");

  const teamOne = await prisma.team.create({ data: { orgId, projectId, name: "One" } });
  const teamTwo = await prisma.team.create({ data: { orgId, projectId, name: "Two" } });
  await prisma.teamMember.createMany({
    data: [
      { teamId: teamOne.id, projectMemberId: memberPm },
      { teamId: teamOne.id, projectMemberId: viewerPm },
      { teamId: teamOne.id, projectMemberId: facilitatorPm },
    ],
  });

  // Promotion files work on a delivery board's to-do status.
  await ensureFixtureStatuses(projectId, ["todo"]);
  await prisma.board.create({
    data: {
      orgId, projectId, name: "Delivery", type: "KANBAN",
      columns: { create: [{ key: "todo", name: "To do", category: "TODO", sortOrder: 0 }] },
    },
  });
  sharedBoard = await ceremonyBoard("Retro", null);
  otherTeamBoard = await ceremonyBoard("Team two retro", teamTwo.id);
  authorsBoard = await ceremonyBoard("Signed retro", null, { showNoteAuthors: true });

  intervalId = (await prisma.interval.create({
    data: {
      orgId, projectId, number: 1, name: "Sprint 1", status: "ACTIVE",
      startDate: new Date("2026-01-05"), endDate: new Date("2026-01-16"),
    },
  })).id;
  nextIntervalId = (await prisma.interval.create({
    data: {
      orgId, projectId, number: 2, name: "Sprint 2",
      startDate: new Date("2026-01-19"), endDate: new Date("2026-01-30"),
    },
  })).id;

  owner = await memberToolCtx(orgId, ownerId);
  member = await memberToolCtx(orgId, memberId);
  viewer = await memberToolCtx(orgId, viewerId);
  manager = await memberToolCtx(orgId, managerId);
  outsider = await memberToolCtx(orgId, outsiderId);
  facilitator = await memberToolCtx(orgId, facilitatorId);
  for (const c of [owner, member, viewer, manager, outsider, facilitator]) expect(c.auth).toBeDefined();
}, 120_000);

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe("who may type into a retro, and who runs it", () => {
  it("a plain MEMBER adds a note and an action item", async () => {
    const ceremonyId = await running(sharedBoard);
    const note = await call(addCeremonyNoteTool, at({ ceremonyId, columnKey: "went_well", text: "pairing helped" }), member);
    expect(note.error).toBeUndefined();
    const action = await call(addCeremonyActionTool, at({ ceremonyId, text: "write the runbook" }), member);
    expect(action.error).toBeUndefined();

    const noteId = (note.note as { id: string }).id;
    const actionId = (action.action as { id: string }).id;
    expect(await prisma.retroNote.findUniqueOrThrow({ where: { id: noteId } })).toMatchObject({
      ceremonyId, columnKey: "went_well", text: "pairing helped", authorId: member.userId,
    });
    expect(await prisma.retroActionItem.findUniqueOrThrow({ where: { id: actionId } })).toMatchObject({
      ceremonyId, text: "write the runbook",
    });
  });

  it("a plain MEMBER cannot open or close a ceremony; a project MANAGER can", async () => {
    const refusedOpen = await call(openCeremonyTool, at({ boardId: authorsBoard, kind: "REVIEW" }), member);
    expect(refusedOpen.error).toMatch(/manager of this project/);
    expect(await prisma.sprintCeremony.count({ where: { boardId: authorsBoard, intervalId } })).toBe(0);

    // Control: the same call from the project's manager, who holds no
    // SPRINT_COMPLETE of their own and is admitted as its manager.
    const opened = await call(openCeremonyTool, at({ boardId: authorsBoard, kind: "REVIEW" }), manager);
    expect(opened.error).toBeUndefined();
    const ceremonyId = (opened.ceremony as { id: string }).id;
    expect((opened.ceremony as { status: string }).status).toBe("RUNNING");

    const refusedClose = await call(closeCeremonyTool, at({ ceremonyId }), member);
    expect(refusedClose.error).toMatch(/manager of this project/);
    expect((await prisma.sprintCeremony.findUniqueOrThrow({ where: { id: ceremonyId } })).status).toBe("RUNNING");

    const closed = await call(closeCeremonyTool, at({ ceremonyId }), manager);
    expect(closed.error).toBeUndefined();
    expect((await prisma.sprintCeremony.findUniqueOrThrow({ where: { id: ceremonyId } })).status).toBe("CLOSED");

    // The route's own refusals come back in its words, not as an internal failure.
    expect(await call(closeCeremonyTool, at({ ceremonyId }), manager)).toEqual({ error: "This ceremony is already closed" });
    expect(await call(addCeremonyNoteTool, at({ ceremonyId, columnKey: "went_well", text: "late" }), member)).toEqual({
      error: "This ceremony is closed. Reopen it to add notes.",
    });

    // Reopen for the specs below that use this board.
    expect((await call(openCeremonyTool, at({ boardId: authorsBoard, kind: "REVIEW" }), manager)).error).toBeUndefined();
  });

  it("promoting needs ITEM_CREATE or the project's manager: a VIEWER is refused, a MEMBER is not", async () => {
    // The route gates promotion on requireProjectManage(ITEM_CREATE), and the
    // MEMBER role holds ITEM_CREATE org-wide, so a member promotes in the app;
    // the tool must agree. A VIEWER holds SPRINT_READ (so may add the action)
    // but not ITEM_CREATE.
    const ceremonyId = await running(sharedBoard);
    const added = await call(addCeremonyActionTool, at({ ceremonyId, text: "fix the flaky deploy", ownerId: member.userId }), viewer);
    expect(added.error).toBeUndefined();
    const actionId = (added.action as { id: string }).id;

    const refused = await call(promoteCeremonyActionTool, at({ actionId }), viewer);
    expect(refused.error).toMatch(/manager of this project/);
    expect((await prisma.retroActionItem.findUniqueOrThrow({ where: { id: actionId } })).workItemId).toBeNull();

    const promoted = await call(promoteCeremonyActionTool, at({ actionId }), member);
    expect(promoted.error).toBeUndefined();
    expect(promoted.created).toBe(true);
    const workItemId = (promoted.workItem as { id: string }).id;
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: workItemId } })).toMatchObject({
      projectId, columnKey: "todo", assigneeId: member.userId, intervalId: nextIntervalId, title: "fix the flaky deploy",
    });

    // Idempotent, as the route is: the second promote hands back the same item.
    const again = await call(promoteCeremonyActionTool, at({ actionId }), member);
    expect(again).toMatchObject({ created: false, workItem: { id: workItemId } });
  });

  it("a note is its author's to edit; another member is refused, a facilitator may delete it", async () => {
    const ceremonyId = await running(sharedBoard);
    const noteId = ((await call(addCeremonyNoteTool, at({ ceremonyId, columnKey: "improve", text: "too many meetings" }), member))
      .note as { id: string }).id;

    expect(await call(updateCeremonyNoteTool, at({ noteId, text: "rewritten" }), viewer)).toEqual({
      error: "Only the note's author or a facilitator can change it",
    });
    expect(await call(deleteCeremonyNoteTool, at({ noteId }), viewer)).toEqual({
      error: "Only the note's author or a facilitator can change it",
    });
    expect((await prisma.retroNote.findUniqueOrThrow({ where: { id: noteId } })).text).toBe("too many meetings");

    // Controls: the author edits it; the project's manager removes it.
    expect((await call(updateCeremonyNoteTool, at({ noteId, text: "fewer meetings" }), member)).error).toBeUndefined();
    expect((await prisma.retroNote.findUniqueOrThrow({ where: { id: noteId } })).text).toBe("fewer meetings");
    expect(await call(deleteCeremonyNoteTool, at({ noteId }), manager)).toEqual({ deleted: true, id: noteId });
    expect(await prisma.retroNote.count({ where: { id: noteId } })).toBe(0);
  });

  it("action items are edited and deleted through the same rules", async () => {
    const ceremonyId = await running(sharedBoard);
    const actionId = ((await call(addCeremonyActionTool, at({ ceremonyId, text: "agree a definition of done" }), member))
      .action as { id: string }).id;

    const edited = await call(updateCeremonyActionTool, at({ actionId, ownerId: viewer.userId, dueDate: "2026-02-01" }), member);
    expect(edited.error).toBeUndefined();
    expect(await prisma.retroActionItem.findUniqueOrThrow({ where: { id: actionId } })).toMatchObject({
      ownerId: viewer.userId, text: "agree a definition of done",
    });
    // An owner from outside the org is refused in the route's words.
    expect(await call(updateCeremonyActionTool, at({ actionId, ownerId: "9f8e7d6c-5b4a-4321-8fed-cba987654321" }), member)).toEqual({
      error: "That owner is not a member of this organization",
    });

    expect(await call(deleteCeremonyActionTool, at({ actionId }), member)).toEqual({
      deleted: true, id: actionId, promotedWorkItemId: null,
    });
    expect(await prisma.retroActionItem.count({ where: { id: actionId } })).toBe(0);
  });
});

describe("an action item's owner is a current member of the org", () => {
  const NOT_A_MEMBER = "That owner is not a member of this organization";
  let deactivatedId = "";
  let removedId = "";

  beforeAll(async () => {
    // Own users: the seeded ones are shared by every DB spec.
    deactivatedId = await user("deactivated");
    await prisma.orgMember.create({ data: { orgId, userId: deactivatedId, role: "MEMBER" } });
    await prisma.user.update({ where: { id: deactivatedId }, data: { deactivatedAt: new Date() } });
    removedId = await user("removed");
    await prisma.orgMember.create({ data: { orgId, userId: removedId, role: "MEMBER", removedAt: new Date() } });
  });

  it("control: a current member is accepted as owner, through the route and the tool", async () => {
    const ceremonyId = await running(sharedBoard);
    expect(await asRest(member, addActionRoute as RouteHandler, {}, "POST", { ceremonyId, text: "owned by a current member", ownerId: viewer.userId })).toBe(200);
    expect((await call(addCeremonyActionTool, at({ ceremonyId, text: "owned by a current member, too", ownerId: viewer.userId }), member)).error).toBeUndefined();
    expect(await prisma.retroActionItem.count({
      where: { ceremonyId, ownerId: viewer.userId, text: { in: ["owned by a current member", "owned by a current member, too"] } },
    })).toBe(2);
  });

  it("a deactivated user is refused as owner when the action is created", async () => {
    const ceremonyId = await running(sharedBoard);
    expect(await asRest(member, addActionRoute as RouteHandler, {}, "POST", { ceremonyId, text: "owned by a deactivated user", ownerId: deactivatedId })).toBe(400);
    expect(await call(addCeremonyActionTool, at({ ceremonyId, text: "owned by a deactivated user", ownerId: deactivatedId }), member)).toEqual({ error: NOT_A_MEMBER });
    expect(await prisma.retroActionItem.count({ where: { ownerId: deactivatedId } })).toBe(0);
  });

  // Not the change above: a removed member was refused before it too. Two layers
  // hold this, the client's removed-member filter (lib/db/client.ts) and
  // assignableMembersWhere's own `removedAt: null`, so it fails only if both go,
  // or if the lookup moves to a nested load, which the client filter skips.
  it("a removed member stays refused as owner (guards the two removed-member layers)", async () => {
    const ceremonyId = await running(sharedBoard);
    expect(await asRest(member, addActionRoute as RouteHandler, {}, "POST", { ceremonyId, text: "owned by a removed member", ownerId: removedId })).toBe(400);
    expect(await call(addCeremonyActionTool, at({ ceremonyId, text: "owned by a removed member", ownerId: removedId }), member)).toEqual({ error: NOT_A_MEMBER });
    expect(await prisma.retroActionItem.count({ where: { ownerId: removedId } })).toBe(0);
  });
});

describe("every note and action write leaves one audit row", () => {
  const rows = (action: string, entityId: string) => prisma.auditLog.findMany({ where: { orgId, action, entityId } });
  /** What was written stays out of the trail, as on the other ceremony rows: neither the old text nor the new. */
  const textFree = (row: { metadata: unknown }, ...texts: string[]) => {
    const metadata = JSON.stringify(row.metadata);
    expect(texts.filter((t) => metadata.includes(t))).toEqual([]);
  };

  it("notes: add, edit and delete through the routes; a refused edit records nothing", async () => {
    const ceremonyId = await running(sharedBoard);
    const added = await rest(member, addNoteRoute as RouteHandler, {}, "POST", { ceremonyId, columnKey: "went_well", text: "audited note text" });
    expect(added.status).toBe(200);
    const noteId = ((await added.json()) as { id: string }).id;
    const add = await rows("ceremony.note.add", noteId);
    expect(add).toHaveLength(1);
    expect(add[0]).toMatchObject({ userId: member.userId, entity: "RetroNote" });
    expect(add[0].metadata).toMatchObject({ ceremonyId, intervalId, columnKey: "went_well" });
    textFree(add[0], "audited note text");

    expect(await asRest(viewer, editNoteRoute as RouteHandler, { noteId }, "PATCH", { text: "not yours" })).toBe(403);
    expect(await rows("ceremony.note.update", noteId)).toHaveLength(0);
    expect(await asRest(member, editNoteRoute as RouteHandler, { noteId }, "PATCH", { text: "edited note text" })).toBe(200);
    const update = await rows("ceremony.note.update", noteId);
    expect(update).toHaveLength(1);
    expect(update[0].metadata).toMatchObject({ ceremonyId, intervalId });
    textFree(update[0], "audited note text", "edited note text");

    expect(await asRest(member, deleteNoteRoute as RouteHandler, { noteId }, "DELETE")).toBe(200);
    const removed = await rows("ceremony.note.delete", noteId);
    expect(removed).toHaveLength(1);
    expect(removed[0].metadata).toMatchObject({ ceremonyId, intervalId });
    textFree(removed[0], "audited note text", "edited note text");
  });

  it("actions: add, edit and delete through the routes", async () => {
    const ceremonyId = await running(sharedBoard);
    const added = await rest(member, addActionRoute as RouteHandler, {}, "POST", { ceremonyId, text: "audited action text" });
    expect(added.status).toBe(200);
    const actionId = ((await added.json()) as { id: string }).id;
    const add = await rows("ceremony.action.add", actionId);
    expect(add).toHaveLength(1);
    expect(add[0]).toMatchObject({ userId: member.userId, entity: "RetroActionItem" });
    expect(add[0].metadata).toMatchObject({ ceremonyId, intervalId });
    textFree(add[0], "audited action text");

    // The edit changes the text too, so the row has an old and a new text to leave out.
    expect(await asRest(member, editActionRoute as RouteHandler, { actionId }, "PATCH", { ownerId: viewer.userId, text: "edited action text" })).toBe(200);
    const update = await rows("ceremony.action.update", actionId);
    expect(update).toHaveLength(1);
    expect(update[0].metadata).toMatchObject({ ceremonyId, intervalId, changed: ["text", "ownerId"] });
    textFree(update[0], "audited action text", "edited action text");

    expect(await asRest(member, deleteActionRoute as RouteHandler, { actionId }, "DELETE")).toBe(200);
    const removed = await rows("ceremony.action.delete", actionId);
    expect(removed).toHaveLength(1);
    expect(removed[0].metadata).toMatchObject({ ceremonyId, intervalId, promotedWorkItemId: null });
    textFree(removed[0], "audited action text", "edited action text");
  });

  it("a write through the assistant is marked as the assistant's", async () => {
    const ceremonyId = await running(sharedBoard);
    const out = await call(addCeremonyNoteTool, at({ ceremonyId, columnKey: "improve", text: "via the assistant" }), member);
    expect(out.error).toBeUndefined();
    const add = await rows("ceremony.note.add", (out.note as { id: string }).id);
    expect(add).toHaveLength(1);
    expect(add[0].metadata).toMatchObject({ via: "assistant" });
    textFree(add[0], "via the assistant");
  });
});

describe("what a caller outside the boundary gets", () => {
  it("a non-member of a team-scoped project gets 'Project not found', for reads and writes", async () => {
    const ceremonyId = await running(sharedBoard);
    expect(await call(getCeremony, { projectId, intervalId }, outsider)).toEqual({ error: "Project not found" });
    expect(await call(addCeremonyNoteTool, at({ ceremonyId, columnKey: "went_well", text: "x" }), outsider)).toEqual({
      error: "Project not found",
    });

    // Control: a project member gets the boards from the same call.
    const listed = await call(getCeremony, { projectId, intervalId }, member);
    expect(listed.error).toBeUndefined();
    expect((listed.boards as { id: string }[]).map((b) => b.id)).toContain(sharedBoard);
  });

  it("a board narrowed to another team is not there for the tool, read or write", async () => {
    // The owner may see every board, so opens it; the member is on team one.
    const ceremonyId = await running(otherTeamBoard);

    const listed = await call(getCeremony, { projectId, intervalId }, member);
    expect((listed.boards as { id: string }[]).map((b) => b.id)).not.toContain(otherTeamBoard);
    expect(await call(getCeremony, { projectId, intervalId, boardId: otherTeamBoard }, member)).toEqual({ error: "Board not found" });
    expect(await call(addCeremonyNoteTool, at({ ceremonyId, columnKey: "went_well", text: "x" }), member)).toEqual({
      error: "Ceremony not found",
    });
    expect(await call(addCeremonyActionTool, at({ ceremonyId, text: "x" }), member)).toEqual({ error: "Ceremony not found" });
    expect(await prisma.retroNote.count({ where: { ceremonyId } })).toBe(0);

    // Controls: the board is real and listed for its team's view (the owner),
    // and the member's same write lands on a board shared with the project.
    const ownerList = await call(getCeremony, { projectId, intervalId }, owner);
    expect((ownerList.boards as { id: string }[]).map((b) => b.id)).toContain(otherTeamBoard);
    const shared = await running(sharedBoard);
    expect((await call(addCeremonyNoteTool, at({ ceremonyId: shared, columnKey: "went_well", text: "x" }), member)).error).toBeUndefined();
  });

  it("a note or action on another team's board is not there either, by id", async () => {
    const ceremonyId = await running(otherTeamBoard);
    const note = await prisma.retroNote.create({ data: { ceremonyId, columnKey: "went_well", text: "theirs", authorId: owner.userId } });
    const action = await prisma.retroActionItem.create({ data: { ceremonyId, text: "theirs" } });

    expect(await call(deleteCeremonyNoteTool, at({ noteId: note.id }), member)).toEqual({ error: "Note not found" });
    expect(await call(deleteCeremonyActionTool, at({ actionId: action.id }), member)).toEqual({ error: "Action item not found" });
    expect(await call(promoteCeremonyActionTool, at({ actionId: action.id }), member)).toEqual({ error: "Action item not found" });
    expect(await prisma.retroNote.count({ where: { id: note.id } })).toBe(1);
    expect((await prisma.retroActionItem.findUniqueOrThrow({ where: { id: action.id } })).workItemId).toBeNull();

    // Control: the owner, who sees the board, deletes the same note.
    expect(await call(deleteCeremonyNoteTool, at({ noteId: note.id }), owner)).toEqual({ deleted: true, id: note.id });
  });

  it("the app's routes refuse the same by-id writes on another team's board", async () => {
    // These routes used to skip the board's team: close and the note and
    // action writes found the row by id and wrote to it.
    const ceremonyId = await running(otherTeamBoard);
    const note = await prisma.retroNote.create({ data: { ceremonyId, columnKey: "went_well", text: "theirs", authorId: owner.userId } });
    const action = await prisma.retroActionItem.create({ data: { ceremonyId, text: "theirs" } });
    // The earlier specs may have left rows on this same running ceremony.
    const notesBefore = await prisma.retroNote.count({ where: { ceremonyId } });
    const actionsBefore = await prisma.retroActionItem.count({ where: { ceremonyId } });

    expect(await asRest(member, addNoteRoute as RouteHandler, {}, "POST", { ceremonyId, columnKey: "went_well", text: "x" })).toBe(404);
    expect(await asRest(member, addActionRoute as RouteHandler, {}, "POST", { ceremonyId, text: "x" })).toBe(404);
    expect(await asRest(member, editActionRoute as RouteHandler, { actionId: action.id }, "PATCH", { text: "changed" })).toBe(404);
    // The facilitator may delete anyone's note and close any retro they can see.
    expect(await asRest(facilitator, deleteNoteRoute as RouteHandler, { noteId: note.id }, "DELETE")).toBe(404);
    expect(await asRest(facilitator, closeRoute as RouteHandler, {}, "POST", { ceremonyId })).toBe(404);

    expect(await prisma.retroNote.count({ where: { ceremonyId } })).toBe(notesBefore);
    expect(await prisma.retroNote.count({ where: { id: note.id } })).toBe(1);
    expect(await prisma.retroActionItem.count({ where: { ceremonyId } })).toBe(actionsBefore);
    expect((await prisma.retroActionItem.findUniqueOrThrow({ where: { id: action.id } })).text).toBe("theirs");
    expect((await prisma.sprintCeremony.findUniqueOrThrow({ where: { id: ceremonyId } })).status).toBe("RUNNING");

    // Controls: the same member's note lands through the route on a board shared
    // with the project, the facilitator closes that one, and the owner, who
    // sees team two's board, closes the hidden one.
    const shared = await running(sharedBoard);
    expect(await asRest(member, addNoteRoute as RouteHandler, {}, "POST", { ceremonyId: shared, columnKey: "went_well", text: "x" })).toBe(200);
    expect(await asRest(facilitator, closeRoute as RouteHandler, {}, "POST", { ceremonyId: shared })).toBe(200);
    expect(await asRest(owner, closeRoute as RouteHandler, {}, "POST", { ceremonyId })).toBe(200);
    expect((await prisma.sprintCeremony.findUniqueOrThrow({ where: { id: ceremonyId } })).status).toBe("CLOSED");
  });

  it("a projectScope that leaves the project out reads as 'Project not found'", async () => {
    const ceremonyId = await running(sharedBoard);
    const scoped = (projectScope: string[]): ToolContext => ({ ...manager, auth: { ...manager.auth, projectScope } });

    expect(await call(getCeremony, { projectId, intervalId }, scoped([otherProjectId]))).toEqual({ error: "Project not found" });
    expect(await call(closeCeremonyTool, at({ ceremonyId }), scoped([otherProjectId]))).toEqual({ error: "Project not found" });
    expect((await prisma.sprintCeremony.findUniqueOrThrow({ where: { id: ceremonyId } })).status).toBe("RUNNING");

    // Control: the same manager, scoped to this project, is admitted.
    const listed = await call(getCeremony, { projectId, intervalId }, scoped([projectId]));
    expect(listed.error).toBeUndefined();
    expect((listed.boards as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("get_ceremony", () => {
  type Full = { ceremony: { notes: { text: string; authorId: string | null; isMine: boolean }[] } };
  const notesOn = async (boardId: string, ctx: ToolContext) =>
    ((await call(getCeremony, { projectId, intervalId, boardId }, ctx)) as unknown as Full).ceremony.notes;

  it("withholds a note's author unless the board shows authors", async () => {
    const quiet = await running(sharedBoard);
    await call(addCeremonyNoteTool, at({ ceremonyId: quiet, columnKey: "improve", text: "unsigned complaint" }), member);
    const signed = await running(authorsBoard);
    await call(addCeremonyNoteTool, at({ ceremonyId: signed, columnKey: "improve", text: "signed complaint" }), member);

    const fromOwner = (await notesOn(sharedBoard, owner)).find((n) => n.text === "unsigned complaint")!;
    expect(fromOwner).toMatchObject({ authorId: null, isMine: false });
    // The author still knows it is theirs, which is how they delete it.
    expect((await notesOn(sharedBoard, member)).find((n) => n.text === "unsigned complaint")).toMatchObject({
      authorId: null, isMine: true,
    });

    // Control: on a board that opts in, the author IS returned, so the null
    // above is the rule and not a field this read never fills.
    expect((await notesOn(authorsBoard, owner)).find((n) => n.text === "signed complaint")).toMatchObject({
      authorId: member.userId, isMine: false,
    });
  });

  it("without an interval, opens on the active sprint; with a board, returns the review", async () => {
    const listed = await call(getCeremony, { projectId }, member);
    expect(listed.error).toBeUndefined();
    expect((listed.interval as { id: string }).id).toBe(intervalId);
    const shared = (listed.boards as { id: string; ceremony: { status: string; noteCount: number } | null }[])
      .find((b) => b.id === sharedBoard)!;
    expect(shared.ceremony?.status).toBe("RUNNING");
    expect(shared.ceremony!.noteCount).toBeGreaterThan(0);

    const full = await call(getCeremony, { projectId, boardId: sharedBoard }, member);
    expect(full.error).toBeUndefined();
    expect(full).toMatchObject({
      sprint: { id: intervalId, name: "Sprint 1" },
      board: { id: sharedBoard, type: "SPRINT_REVIEW", showsNoteAuthors: false },
      columns: [{ key: "went_well", name: "Went well" }, { key: "improve", name: "To improve" }],
      nextSprint: { name: "Sprint 2", planned: true },
    });
    expect(full.metrics).toHaveProperty("totalItems");
  });
});

describe("every ceremony tool depends on the caller's permissions", () => {
  // What tool-auth.arch.test.ts asks of each registered tool: an empty call must
  // answer a caller with no permissions differently from one with all of them.
  const ALL = Object.values(Permission).reduce((m, b) => m | b, 0n);
  const TOOLS = {
    getCeremony, openCeremonyTool, closeCeremonyTool, addCeremonyNoteTool, updateCeremonyNoteTool,
    deleteCeremonyNoteTool, addCeremonyActionTool, updateCeremonyActionTool, deleteCeremonyActionTool,
    promoteCeremonyActionTool,
  };

  it.each(Object.entries(TOOLS))("%s", async (_name, fn) => {
    const powerless = stubToolCtx("org", "user", { permissions: 0n, basePermissions: 0n, orgRole: "VIEWER" as OrgRole });
    const omnipotent = stubToolCtx("org", "user", { permissions: ALL, basePermissions: ALL, orgRole: "OWNER" as OrgRole });
    const weak = await fn({}, powerless);
    const strong = await fn({}, omnipotent);
    expect(weak).toEqual({ error: "Insufficient permissions" });
    expect(strong).not.toEqual(weak);
  });
});
