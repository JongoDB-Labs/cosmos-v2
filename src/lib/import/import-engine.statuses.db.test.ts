// @vitest-environment node
//
// An import puts items only in the project's live statuses. A ceremony board's
// prompts (Start / Stop / Continue) are columns but not statuses, and the
// fallback status is a request value like any other: both used to be accepted,
// and the item then failed the status foreign key at commit.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { runImport } from "./import-engine";
import type { ImportRequest } from "./work-item-fields";

let orgId = "";
let projectId = "";
let userId = "";
let typeId = "";

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  userId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `imp ${stamp}`, slug: `imp-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "OWNER" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "I", key: `IM${stamp.slice(-4).toUpperCase()}` } })).id;
  await ensureFixtureStatuses(projectId);
  await prisma.workflowStatus.update({ where: { projectId_key: { projectId, key: "review" } }, data: { archivedAt: new Date() } });
  const retro = await prisma.board.create({ data: { orgId, projectId, name: "Retro", type: "SPRINT_REVIEW" } });
  await prisma.boardColumn.create({ data: { boardId: retro.id, key: "start", name: "Start", category: "TODO", sortOrder: 0 } });
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, isBuiltIn: true } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

const request = (statuses: string[], fallback = "todo"): ImportRequest => ({
  mode: "validate",
  mapping: { Summary: "title", Status: "status" },
  valueMaps: { status: { "In flight": "in-progress", Retro: "start", Old: "review" } },
  rows: statuses.map((s, i) => ({ Summary: `row ${i}`, Status: s })),
  defaults: { columnKey: fallback, workItemTypeId: typeId, priority: "MEDIUM" },
});

describe("import statuses", () => {
  it("puts a mapped live status in place, and falls back for a ceremony prompt or an archived status", async () => {
    const report = await runImport({ orgId, projectId, userId }, { ...request(["In flight", "Retro", "Old"]), mode: "commit" });
    expect(report.errors).toEqual([]);
    const items = await prisma.workItem.findMany({ where: { projectId }, orderBy: { title: "asc" }, select: { title: true, columnKey: true } });
    expect(items).toEqual([
      { title: "row 0", columnKey: "in-progress" },
      { title: "row 1", columnKey: "todo" },
      { title: "row 2", columnKey: "todo" },
    ]);
    await prisma.workItem.deleteMany({ where: { projectId } });
  });

  it("refuses rows whose fallback is not a status, instead of failing at commit", async () => {
    const report = await runImport({ orgId, projectId, userId }, request(["Retro", "In flight"], "start"));
    expect(report.errors).toEqual([{ row: 1, message: expect.stringContaining('No status "start"') }]);
    expect(report.willCreate).toBe(1);
  });
});
