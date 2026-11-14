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

  // Rows that point at the duplicate but belong to another org (what an older,
  // unchecked write could leave) are not the merge's to move: each nested move
  // is scoped to this org, and sub-items to this project. Each kind has the
  // org's own row beside it, which does move.
  it("moves only this org's rows, and only this project's sub-items", async () => {
    const { org, project, owner, mk } = await setup();
    const stamp = Math.random().toString(36).slice(2, 8);
    const orgB = await prisma.organization.create({ data: { name: `mgb ${stamp}`, slug: `mgb-${stamp}` } });
    orgIds.push(orgB.id);
    const stranger = await prisma.user.create({ data: { email: `mg-stranger-${stamp}@merge.test`, displayName: "S" } });
    const pB = await prisma.project.create({ data: { orgId: orgB.id, name: "PB", key: `MB${stamp.slice(0, 4).toUpperCase()}` } });
    const p2 = await prisma.project.create({ data: { orgId: org.id, name: "P2", key: `MC${stamp.slice(0, 4).toUpperCase()}` } });
    await ensureFixtureStatuses(pB.id, ["todo"]);
    await ensureFixtureStatuses(p2.id, ["todo"]);
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const rawItem = (orgId: string, projectId: string, ticketNumber: number, parentId?: string) =>
      prisma.workItem.create({
        data: { orgId, projectId, ticketNumber, title: `x-${ticketNumber}`, columnKey: "todo", workItemTypeId: type.id, createdById: owner.id, parentId },
      });

    const survivor = await mk({ title: "survivor" });
    const dup = await mk({ title: "dup" });
    const subA = await mk({ title: "own sub", parentId: dup.id });
    const subB = await rawItem(orgB.id, pB.id, 1, dup.id);
    const subP2 = await rawItem(org.id, p2.id, 1, dup.id);
    const itemB = await rawItem(orgB.id, pB.id, 2);
    const other = await mk({ title: "linked" });

    /** One row of each kind that points at the duplicate, in `orgId`. */
    const plant = async (orgId: string, projectId: string, who: string, target: string) => {
      const board = await prisma.board.create({ data: { orgId, projectId, name: "B", type: "KANBAN" } });
      const interval = await prisma.interval.create({
        data: { orgId, projectId, number: 1, name: "S", startDate: new Date("2026-11-02"), endDate: new Date("2026-11-13") },
      });
      const ceremony = await prisma.sprintCeremony.create({ data: { orgId, boardId: board.id, intervalId: interval.id, kind: "REVIEW" } });
      const goal = await prisma.goal.create({ data: { orgId, projectId, title: "G" } });
      const objective = await prisma.objective.create({ data: { orgId, projectId, title: "O" } });
      const kr = await prisma.keyResult.create({ data: { objectiveId: objective.id, title: "KR" } });
      const milestone = await prisma.milestone.create({ data: { orgId, projectId, title: "M", dueDate: new Date("2026-12-01") } });
      const workItemId = dup.id;
      return {
        comment: (await prisma.comment.create({ data: { orgId, workItemId, authorId: who, content: "c" } })).id,
        timeEntry: (await prisma.timeEntry.create({ data: { orgId, userId: who, workItemId, date: new Date("2026-10-20"), hours: 1 } })).id,
        document: (await prisma.document.create({
          data: { orgId, workItemId, uploadedById: who, title: "d", filename: "d.txt", contentType: "text/plain", size: 1, storageKey: `k-${orgId}` },
        })).id,
        feedback: (await prisma.feedbackItem.create({ data: { orgId, workItemId, authorId: who, title: "f" } })).id,
        retro: (await prisma.retroActionItem.create({ data: { ceremonyId: ceremony.id, text: "r", workItemId } })).id,
        goalLink: (await prisma.goalLink.create({ data: { goalId: goal.id, kind: "WORK_ITEM", workItemId } })).id,
        milestoneLink: (await prisma.milestoneLink.create({ data: { milestoneId: milestone.id, workItemId } })).id,
        link: (await prisma.workItemLink.create({ data: { orgId, sourceItemId: workItemId, targetItemId: target, type: "BLOCKS" } })).id,
        kr: kr.id,
        objective: objective.id,
        watcher: who,
        krLink: (await prisma.keyResultLink.create({ data: { orgId, keyResultId: kr.id, workItemId } })).id,
        objectiveLink: (await prisma.objectiveLink.create({ data: { orgId, objectiveId: objective.id, workItemId } })).id,
        watcherRow: (await prisma.workItemWatcher.create({ data: { orgId, workItemId, userId: who } })).id,
      };
    };
    const mine = await plant(org.id, project.id, owner.id, other.id);
    const theirs = await plant(orgB.id, pB.id, stranger.id, itemB.id);

    await prisma.$transaction((tx) =>
      mergeWorkItems(tx, { orgId: org.id, projectId: project.id, duplicateId: dup.id, survivorId: survivor.id, userId: owner.id }),
    );

    /** Which item each planted row now points at: S for the survivor, D for the duplicate. */
    const at = async (rows: Awaited<ReturnType<typeof plant>>) => {
      const where = (id: string | null | undefined) => (id === survivor.id ? "S" : id === dup.id ? "D" : `? ${id}`);
      const link = await prisma.workItemLink.findUnique({ where: { id: rows.link } });
      return {
        comment: where((await prisma.comment.findUniqueOrThrow({ where: { id: rows.comment } })).workItemId),
        timeEntry: where((await prisma.timeEntry.findUniqueOrThrow({ where: { id: rows.timeEntry } })).workItemId),
        document: where((await prisma.document.findUniqueOrThrow({ where: { id: rows.document } })).workItemId),
        feedback: where((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: rows.feedback } })).workItemId),
        retro: where((await prisma.retroActionItem.findUniqueOrThrow({ where: { id: rows.retro } })).workItemId),
        goalLink: where((await prisma.goalLink.findUniqueOrThrow({ where: { id: rows.goalLink } })).workItemId),
        milestoneLink: where((await prisma.milestoneLink.findUniqueOrThrow({ where: { id: rows.milestoneLink } })).workItemId),
        link: where(link?.sourceItemId),
        // Copied to the survivor and dropped from the duplicate, or left alone.
        krLink: (await prisma.keyResultLink.count({ where: { keyResultId: rows.kr, workItemId: survivor.id } })) === 1 ? "S" : "D",
        objectiveLink: (await prisma.objectiveLink.count({ where: { objectiveId: rows.objective, workItemId: survivor.id } })) === 1 ? "S" : "D",
        watcher: (await prisma.workItemWatcher.count({ where: { workItemId: survivor.id, userId: rows.watcher } })) === 1 ? "S" : "D",
      };
    };
    const everywhere = (v: string) => ({
      comment: v, timeEntry: v, document: v, feedback: v, retro: v, goalLink: v, milestoneLink: v, link: v, krLink: v, objectiveLink: v, watcher: v,
    });
    expect(await at(mine)).toEqual(everywhere("S"));
    expect(await at(theirs)).toEqual(everywhere("D"));
    // Another org's key-result and objective links are still on the duplicate, not dropped.
    expect(await prisma.keyResultLink.count({ where: { id: theirs.krLink, workItemId: dup.id } })).toBe(1);
    expect(await prisma.objectiveLink.count({ where: { id: theirs.objectiveLink, workItemId: dup.id } })).toBe(1);

    const parentOf = async (id: string) => (await prisma.workItem.findUniqueOrThrow({ where: { id } })).parentId;
    expect(await parentOf(subA.id)).toBe(survivor.id);
    expect(await parentOf(subB.id)).toBe(dup.id);
    expect(await parentOf(subP2.id)).toBe(dup.id);
  });
});
