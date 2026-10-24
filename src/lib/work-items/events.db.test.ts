// @vitest-environment node
//
// The domain-event outbox, against a real database: every write through the
// single writer records its event in the same transaction, a payload carries
// before/after but never free text, and old events are pruned.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { createWorkItemRow, rebuildTagMirror, updateWorkItems, updateWorkItemsUnchecked } from "./write.server";
import { applyWorkItemChange } from "./apply-change.server";
import { EVENT_RETENTION_DAYS, pruneDomainEvents, type WriteMeta } from "./events.server";

let orgId = "";
let projectId = "";
let userId = "";
let typeId = "";
let ticket = 0;

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  userId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `ev ${stamp}`, slug: `ev-${stamp}` } })).id;
  projectId = (await prisma.project.create({ data: { orgId, name: "E", key: `EV${stamp.slice(-4).toUpperCase()}` } })).id;
  await ensureFixtureStatuses(projectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

const META: WriteMeta = { actorId: null, source: "IMPORT" };

function create(meta: WriteMeta = META, extra: Record<string, unknown> = {}) {
  return createWorkItemRow(
    prisma,
    {
      data: {
        orgId, projectId, workItemTypeId: typeId, createdById: userId,
        title: "Secret plans", description: "", columnKey: "todo", ticketNumber: ++ticket, ...extra,
      },
      select: { title: true },
    },
    meta,
  );
}

const eventsFor = (subjectId: string) =>
  prisma.domainEvent.findMany({ where: { subjectId }, orderBy: { id: "asc" } });

async function lastCreatedId() {
  return (await prisma.workItem.findFirstOrThrow({ where: { projectId, ticketNumber: ticket } })).id;
}

describe("the work-item outbox", () => {
  it("records a create, with who and through what, whatever the caller selected", async () => {
    await create({ actorId: userId, source: "API" });
    const id = await lastCreatedId();
    const [e] = await eventsFor(id);
    expect(e).toMatchObject({
      orgId, projectId, type: "work_item.created", actorId: userId, source: "API", depth: 0,
      payload: { ticketNumber: ticket, columnKey: "todo", workItemTypeId: typeId, parentId: null },
    });
    expect(e.processedAt).toBeNull();
  });

  it("keeps a composed plugin's create exactly as it was: a PrismaPromise, batchable, with no event", async () => {
    const [row] = await prisma.$transaction([
      // write-meta: plugin form
      createWorkItemRow(prisma, {
        data: {
          orgId, projectId, workItemTypeId: typeId, createdById: userId,
          title: "from a plugin", description: "", columnKey: "todo", ticketNumber: ++ticket,
        },
      }),
    ]);
    expect(await eventsFor(row.id)).toEqual([]);
  });

  it("records a plugin's update (no meta) as PLUGIN, with no actor", async () => {
    await create();
    const id = await lastCreatedId();
    // write-meta: plugin form
    await updateWorkItems(prisma, [id], { storyPoints: 2 });
    expect((await eventsFor(id)).at(-1)).toMatchObject({ type: "work_item.updated", actorId: null, source: "PLUGIN" });
  });

  it("records a create made with connect forms, its ids read back from the row", async () => {
    await createWorkItemRow(
      prisma,
      {
        data: {
          org: { connect: { id: orgId } }, project: { connect: { id: projectId } },
          status: { connect: { projectId_key: { projectId, key: "todo" } } },
          workItemType: { connect: { id: typeId } }, createdById: userId,
          title: "connected", description: "", ticketNumber: ++ticket,
        },
        select: { id: true },
      },
      META,
    );
    const id = await lastCreatedId();
    expect((await eventsFor(id))[0]).toMatchObject({ orgId, projectId, type: "work_item.created", payload: { columnKey: "todo" } });
  });

  it("records an update's before and after, names free text without copying it, and skips a no-op", async () => {
    await create();
    const id = await lastCreatedId();
    await updateWorkItems(prisma, [id], { title: "Even more secret", storyPoints: 5 }, META);
    await updateWorkItems(prisma, [id], { storyPoints: 5 }, META);
    const events = await eventsFor(id);
    expect(events.map((e) => e.type)).toEqual(["work_item.created", "work_item.updated"]);
    expect(events[1].payload).toEqual({
      changes: { title: { from: null, to: null }, storyPoints: { from: null, to: 5 } },
    });
    expect(JSON.stringify(events.map((e) => e.payload)).toLowerCase()).not.toContain("secret");
  });

  it("never copies free text: an import's raw record, notes, resolution and custom fields are named, not valued", async () => {
    await create();
    const id = await lastCreatedId();
    await updateWorkItemsUnchecked(
      prisma,
      [id],
      {
        sourceRecord: { Summary: "Secret plans for the CUI program", Description: "Classified detail" },
        cancelNote: "Secret reason",
        resolution: "Secret outcome",
        customFields: { root_cause: "Secret cause" },
        externalId: "SECRET-1",
        storyPoints: 3,
      },
      META,
    );
    const e = (await eventsFor(id)).at(-1)!;
    expect(e.payload).toEqual({
      changes: {
        sourceRecord: { from: null, to: null },
        cancelNote: { from: null, to: null },
        resolution: { from: null, to: null },
        customFields: { from: null, to: null },
        externalId: { from: null, to: null },
        storyPoints: { from: null, to: 3 },
      },
    });
    expect(JSON.stringify(e.payload).toLowerCase()).not.toContain("secret");
  });

  it("rolls the event back with the write, inside a caller's transaction", async () => {
    await create();
    const id = await lastCreatedId();
    await expect(
      prisma.$transaction(async (tx) => {
        await updateWorkItems(tx, [id], { storyPoints: 8 }, META);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).storyPoints).toBeNull();
    expect((await eventsFor(id)).map((e) => e.type)).toEqual(["work_item.created"]);
  });

  it("rolls the write back when its event cannot be recorded, on the root client too", async () => {
    await create();
    const id = await lastCreatedId();
    // Not a uuid: the event insert fails in the database, after the row write.
    const broken: WriteMeta = { actorId: "not-a-uuid", source: "API" };
    await expect(updateWorkItems(prisma, [id], { storyPoints: 13 }, broken)).rejects.toThrow();
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id } })).storyPoints).toBeNull();
    await expect(create(broken)).rejects.toThrow();
    expect(await prisma.workItem.count({ where: { projectId, ticketNumber: ticket } })).toBe(0);
  });

  it("records a tag-mirror rebuild", async () => {
    await create();
    const id = await lastCreatedId();
    const label = await prisma.label.create({ data: { orgId, name: `L${ticket}` } });
    await prisma.workItemLabel.create({ data: { orgId, workItemId: id, labelId: label.id } });
    await rebuildTagMirror(prisma, [id], META);
    // Label names are people's words: named, not valued.
    expect((await eventsFor(id)).at(-1)?.payload).toEqual({ changes: { tags: { from: null, to: null } } });
  });

  it("records a status change as a transition, one per item, under one correlation id", async () => {
    await create();
    const a = await lastCreatedId();
    await create();
    const b = await lastCreatedId();
    await prisma.$transaction((tx) =>
      applyWorkItemChange(tx, {
        actorId: userId, orgId, projectId, itemIds: [a, b], patch: { columnKey: "done", tags: [] }, source: "BULK", actor: null,
      }),
    );
    const [ea, eb] = [(await eventsFor(a)).at(-1)!, (await eventsFor(b)).at(-1)!];
    for (const e of [ea, eb]) {
      expect(e).toMatchObject({ type: "work_item.transitioned", actorId: userId, source: "BULK" });
      expect(e.payload).toMatchObject({
        from: "todo",
        to: "done",
        changes: { columnKey: { from: "todo", to: "done" }, completedAt: { from: null, to: expect.any(String) } },
      });
      // The tags did not change (none before, none after), so they are not in it.
      expect(e.payload).not.toHaveProperty("changes.tags");
    }
    expect(ea.correlationId).toBe(eb.correlationId);
    // The change service records these itself: no second, generic event.
    expect((await eventsFor(a)).filter((e) => e.type !== "work_item.created")).toHaveLength(1);
  });
});

describe("pruneDomainEvents", () => {
  it("deletes processed events older than the retention window, in batches, and keeps the rest", async () => {
    await create();
    const id = await lastCreatedId();
    const now = new Date();
    const old = new Date(now.getTime() - (EVENT_RETENTION_DAYS + 1) * 86_400_000);
    await prisma.domainEvent.createMany({
      data: [1, 2, 3].map(() => ({ orgId, projectId, type: "work_item.updated", subjectId: id, source: "SYSTEM", createdAt: old, processedAt: old })),
    });
    expect(await eventsFor(id)).toHaveLength(4);
    // Other specs' old events may be pruned too, so only a floor on the count.
    expect((await pruneDomainEvents(prisma, { now, batchSize: 2 })).deleted).toBeGreaterThanOrEqual(3);
    expect((await eventsFor(id)).map((e) => e.type)).toEqual(["work_item.created"]);
  });

  it("never deletes an event nothing has processed, however old, and counts it as stuck", async () => {
    await create();
    const id = await lastCreatedId();
    const now = new Date();
    const old = new Date(now.getTime() - (EVENT_RETENTION_DAYS + 1) * 86_400_000);
    await prisma.domainEvent.create({ data: { orgId, projectId, type: "work_item.updated", subjectId: id, source: "SYSTEM", createdAt: old } });
    const r = await pruneDomainEvents(prisma, { now });
    expect((await eventsFor(id)).map((e) => e.type)).toEqual(["work_item.created", "work_item.updated"]);
    expect(r.stuck).toBeGreaterThanOrEqual(1);
  });
});
