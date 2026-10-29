// @vitest-environment node
//
// COSMOS-206: the project's Cancelled status, when it has one but it is
// ARCHIVED.
//
// Archiving a status hides it from the pickers; the items in it keep it. So a
// project that archived Cancelled still HAS a Cancelled status, and the first
// cancel after that must bring that one back — not add a second "Cancelled"
// beside it and append another Cancelled column to every board, which is what
// the user had just hidden.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type BoardType, type ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";

import { seedBoardColumns } from "../provision.server";
import { ensureCancelledStatus, loadStatuses } from "../statuses.server";

let orgId = "";

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({ data: { name: `wfca ${stamp}`, slug: `wfca-${stamp}` } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

const COLS: { key: string; name: string; category: ColumnCategory }[] = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "done", name: "Done", category: "DONE" },
];

async function project() {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return prisma.project.create({ data: { orgId, name: `CA ${suffix}`, key: `CA${suffix}` } });
}

async function board(projectId: string, type: BoardType, columns: Parameters<typeof seedBoardColumns>[2]) {
  const b = await prisma.board.create({ data: { orgId, projectId, name: type, type } });
  await prisma.$transaction((tx) => seedBoardColumns(tx, b, columns));
  return b;
}

const cancelledStatuses = async (projectId: string) =>
  (await loadStatuses(prisma, projectId, { includeArchived: true }))
    .filter((s) => s.category === "CANCELLED")
    .map((s) => ({ key: s.key, archived: s.archivedAt !== null }));

const run = (projectId: string, preferred?: string) =>
  prisma.$transaction((tx) => ensureCancelledStatus(tx, projectId, preferred));

describe("ensureCancelledStatus with an archived Cancelled status", () => {
  it("restores the project's own Cancelled status instead of adding a second one", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN", [...COLS, { key: "cancelled", name: "Cancelled", category: "CANCELLED" }]);
    await prisma.workflowStatus.update({
      where: { projectId_key: { projectId: p.id, key: "cancelled" } },
      data: { archivedAt: new Date() },
    });

    expect(await run(p.id)).toBe("cancelled");
    expect(await cancelledStatuses(p.id)).toEqual([{ key: "cancelled", archived: false }]);
    // ...and no second Cancelled lane on the board the user had cleared it from.
    expect(
      (await prisma.boardColumn.findMany({ where: { boardId: kanban.id }, select: { key: true } })).map((c) => c.key),
    ).toEqual(["todo", "done", "cancelled"]);
  });

  it("restores the one asked for when the project has several", async () => {
    const p = await project();
    await board(p.id, "KANBAN", [
      ...COLS,
      { key: "abandoned", name: "Abandoned", category: "CANCELLED" },
      { key: "wont-do", name: "Won't do", category: "CANCELLED" },
    ]);
    await prisma.workflowStatus.updateMany({
      where: { projectId: p.id, category: "CANCELLED" },
      data: { archivedAt: new Date() },
    });

    expect(await run(p.id, "wont-do")).toBe("wont-do");
    expect(await cancelledStatuses(p.id)).toEqual([
      { key: "abandoned", archived: true },
      { key: "wont-do", archived: false },
    ]);
  });

  it("still takes a fresh key when the archived status means something else", async () => {
    const p = await project();
    await board(p.id, "KANBAN", [{ key: "cancelled", name: "Called off", category: "TODO" }]);
    await prisma.workflowStatus.update({
      where: { projectId_key: { projectId: p.id, key: "cancelled" } },
      data: { archivedAt: new Date() },
    });

    expect(await run(p.id)).toBe("cancelled-2");
    expect(await cancelledStatuses(p.id)).toEqual([{ key: "cancelled-2", archived: false }]);
  });
});
