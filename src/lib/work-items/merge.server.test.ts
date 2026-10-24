// COSMOS-207 (e2e DB): merging a duplicate into the item that survives moves
// every piece of tracked work and fills only the survivor's empty fields. The
// duplicate stays, Cancelled as MERGED and pointing at the survivor.
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { mergeWorkItems, MergeError } from "./merge.server";

describe("mergeWorkItems (e2e DB)", () => {
  const orgIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  });

  async function setup() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({ data: { name: `mg ${stamp}`, slug: `mg-${stamp}` } });
    orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const key = `MG${stamp.slice(-4).toUpperCase()}`;
    const project = await prisma.project.create({ data: { orgId: org.id, name: "P", key } });
    await ensureFixtureStatuses(project.id, ["todo", "done"]);
    const board = await prisma.board.create({ data: { orgId: org.id, projectId: project.id, name: "Board", type: "KANBAN" } });
    await prisma.boardColumn.createMany({
      data: [
        { boardId: board.id, key: "todo", name: "To Do", category: "TODO", sortOrder: 0 },
        { boardId: board.id, key: "done", name: "Done", category: "DONE", sortOrder: 1 },
      ],
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    let n = 0;
    const mk = (data: Record<string, unknown> = {}) =>
      prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: ++n, title: `wi-${n}`, description: "",
          columnKey: "todo", workItemTypeId: type.id, createdById: owner.id, ...data,
        },
      });
    return { org, project, key, owner, mk };
  }

  it("moves tracked work to the survivor and cancels the duplicate as MERGED", async () => {
    const { org, project, key, owner, mk } = await setup();
    const survivor = await mk({ title: "Login is slow", description: "Survivor's words", storyPoints: null, tags: ["perf"] });
    const dup = await mk({
      title: "Slow login (dup)", description: "Duplicate's words", storyPoints: 5,
      dueDate: new Date("2026-11-01T00:00:00Z"), tags: ["perf", "auth"], customFields: { env: "prod" },
    });
    const sub = await mk({ title: "sub-task", parentId: dup.id });
    const other = await mk({ title: "blocked work" });

    await prisma.comment.create({ data: { orgId: org.id, workItemId: dup.id, authorId: owner.id, content: "repro steps" } });
    await prisma.timeEntry.create({
      data: { orgId: org.id, userId: owner.id, workItemId: dup.id, date: new Date("2026-10-20T00:00:00Z"), hours: 3, description: "investigating" },
    });
    await prisma.workItemWatcher.create({ data: { orgId: org.id, workItemId: dup.id, userId: owner.id } });
    await prisma.workItemAssignee.create({ data: { workItemId: dup.id, userId: owner.id, sortOrder: 0 } });
    await prisma.workItem.update({ where: { id: dup.id }, data: { assigneeId: owner.id } });
    // dup blocks `other`; dup also already "relates" to survivor (would self-link).
    await prisma.workItemLink.createMany({
      data: [
        { orgId: org.id, sourceItemId: dup.id, targetItemId: other.id, type: "BLOCKS" },
        { orgId: org.id, sourceItemId: dup.id, targetItemId: survivor.id, type: "RELATES" },
      ],
    });

    const result = await prisma.$transaction((tx) =>
      mergeWorkItems(tx, { orgId: org.id, projectId: project.id, duplicateId: dup.id, survivorId: survivor.id, userId: owner.id }),
    );
    expect(result.moved).toMatchObject({ comments: 1, timeEntries: 1, children: 1, links: 1 });

    const s = await prisma.workItem.findUniqueOrThrow({ where: { id: survivor.id }, include: { assignees: true, watchers: true } });
    // Survivor wins: its own description stays; its empty fields are filled.
    expect(s.description).toBe("Survivor's words");
    expect(s.storyPoints).toBe(5);
    expect(s.dueDate?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(s.customFields).toMatchObject({ env: "prod" });
    expect(s.tags.sort()).toEqual(["auth", "perf"]);
    expect(s.assigneeId).toBe(owner.id);
    expect(s.assignees.map((a) => a.userId)).toEqual([owner.id]);
    expect(s.watchers.map((w) => w.userId)).toEqual([owner.id]);

    // Tracked work now lives on the survivor.
    expect(await prisma.comment.count({ where: { workItemId: survivor.id } })).toBe(1);
    expect((await prisma.timeEntry.findFirstOrThrow({ where: { description: "investigating", orgId: org.id } })).workItemId).toBe(survivor.id);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: sub.id } })).parentId).toBe(survivor.id);
    const links = await prisma.workItemLink.findMany({ where: { orgId: org.id } });
    expect(links.map((l) => `${l.sourceItemId === survivor.id ? "S" : l.sourceItemId === dup.id ? "D" : "O"}>${l.targetItemId === survivor.id ? "S" : l.targetItemId === dup.id ? "D" : "O"}:${l.type}`).sort()).toEqual([
      "D>S:DUPLICATES", // the record of the merge
      "S>O:BLOCKS", // re-pointed; the RELATES self-link was dropped
    ]);

    // The duplicate is kept, Cancelled as MERGED, pointing at the survivor.
    const d = await prisma.workItem.findUniqueOrThrow({ where: { id: dup.id } });
    expect(d).toMatchObject({ cancelReason: "MERGED", cancelNote: `Merged into ${key}-${survivor.ticketNumber}`, mergedIntoId: survivor.id });
    const col = await prisma.boardColumn.findFirstOrThrow({ where: { board: { projectId: project.id }, key: d.columnKey } });
    expect(col.category).toBe("CANCELLED");
    expect(await prisma.activity.count({ where: { workItemId: { in: [dup.id, survivor.id] }, action: "merged" } })).toBe(2);
  });

  it("refuses to merge an item into itself, into a cancelled item, or twice", async () => {
    const { org, project, owner, mk } = await setup();
    const a = await mk();
    const b = await mk();
    const c = await mk({ cancelReason: "OBE" });
    const run = (dupId: string, intoId: string) =>
      prisma.$transaction((tx) =>
        mergeWorkItems(tx, { orgId: org.id, projectId: project.id, duplicateId: dupId, survivorId: intoId, userId: owner.id }),
      );
    await expect(run(a.id, a.id)).rejects.toBeInstanceOf(MergeError);
    await expect(run(a.id, c.id)).rejects.toBeInstanceOf(MergeError);
    await run(a.id, b.id);
    await expect(run(a.id, b.id)).rejects.toThrow(/already merged/);
  });

  /** Every item's parent chain ends without revisiting anything: still a tree. */
  async function expectTree(projectId: string) {
    const rows = await prisma.workItem.findMany({ where: { projectId }, select: { id: true, parentId: true } });
    const parent = new Map(rows.map((r) => [r.id, r.parentId]));
    for (const r of rows) {
      const seen = new Set<string>();
      for (let cur: string | null | undefined = r.id; cur; cur = parent.get(cur)) {
        expect(seen.has(cur), `cycle through ${cur}`).toBe(false);
        seen.add(cur);
      }
    }
  }

  it("won't give the survivor a parent that sits below it (ops' case)", async () => {
    const { org, project, owner, mk } = await setup();
    const survivor = await mk({ title: "b" });
    const c = await mk({ title: "c", parentId: survivor.id });
    const dup = await mk({ title: "a", parentId: c.id });
    await prisma.$transaction((tx) =>
      mergeWorkItems(tx, { orgId: org.id, projectId: project.id, duplicateId: dup.id, survivorId: survivor.id, userId: owner.id }),
    );
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: survivor.id } })).parentId).toBeNull();
    await expectTree(project.id);
  });

  it("lifts the duplicate's child that the survivor hangs under, instead of looping", async () => {
    const { org, project, owner, mk } = await setup();
    const epic = await mk({ title: "epic" });
    const dup = await mk({ title: "a", parentId: epic.id });
    const c = await mk({ title: "c", parentId: dup.id });
    const survivor = await mk({ title: "b", parentId: c.id });
    const sibling = await mk({ title: "d", parentId: dup.id });
    await prisma.$transaction((tx) =>
      mergeWorkItems(tx, { orgId: org.id, projectId: project.id, duplicateId: dup.id, survivorId: survivor.id, userId: owner.id }),
    );
    const parentOf = async (id: string) => (await prisma.workItem.findUniqueOrThrow({ where: { id } })).parentId;
    expect(await parentOf(c.id)).toBe(epic.id); // takes the duplicate's place
    expect(await parentOf(survivor.id)).toBe(c.id); // unchanged
    expect(await parentOf(sibling.id)).toBe(survivor.id); // an ordinary sub-item moves over
    await expectTree(project.id);
  });

  it("keeps the survivor out of a loop when it was the duplicate's own sub-item", async () => {
    const { org, project, owner, mk } = await setup();
    const parent = await mk({ title: "epic" });
    const dup = await mk({ parentId: parent.id });
    const survivor = await mk({ parentId: dup.id });
    await prisma.$transaction((tx) =>
      mergeWorkItems(tx, { orgId: org.id, projectId: project.id, duplicateId: dup.id, survivorId: survivor.id, userId: owner.id }),
    );
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: survivor.id } })).parentId).toBe(parent.id);
    await expectTree(project.id);
  });
});
