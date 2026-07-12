// DB-backed (real e2e DB, no mocks besides the fixtures) coverage for
// getDemotionFacts in scripts/foreman/db.mts: the batched per-item facts the
// planner's demotion-respect check consumes (newest `planned` event ts, the
// item's updatedAt, newest comment ts). Mirrors fresh-mentions.test.ts's harness —
// a dedicated THROWAWAY org+project per test (vitest runs test FILES in parallel
// against one e2e DB, and a shared project's ticketNumber allocation races across
// files), cleaned up in `finally`. getDemotionFacts queries strictly by item id
// (no deliveryProjects/org-settings read), so there is no autonomousDelivery
// config to seed.
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { getDemotionFacts } from "../../../../scripts/foreman/db.mjs";

describe("getDemotionFacts — batched planner demotion facts", () => {
  it("reports newest planned-event ts / updatedAt / newest comment ts per item, null when absent", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });

    const org = await prisma.organization.create({
      data: { name: `planner-demotions-${stamp}`, slug: `planner-demotions-${stamp}` },
    });
    const orgId = org.id;
    const orgIds = [orgId];
    const project = await prisma.project.create({
      data: { orgId, name: "Planner Demotions Test", key: `PD${stamp.slice(-6).toUpperCase()}` },
    });
    const projectId = project.id;

    const itemIds: string[] = [];
    const eventIds: string[] = [];

    async function createItem(ticketNumber: number, suffix: string, columnEnteredAt: Date) {
      const it = await prisma.workItem.create({
        data: {
          orgId,
          projectId,
          ticketNumber,
          title: `[planner-demotions] ${stamp}-${suffix}`,
          description: "",
          columnKey: "backlog",
          workItemTypeId: type.id,
          createdById: alice.id,
          columnEnteredAt,
        },
      });
      itemIds.push(it.id);
      return it;
    }

    try {
      const demotedAt = new Date(Date.now() - 2 * 24 * 3600_000); // 2 days ago
      const plannedTs = new Date(demotedAt.getTime() - 24 * 3600_000); // 1 day before the demotion

      // Item 1: a `planned` event (Foreman promoted it) BEFORE it was demoted back
      // to backlog, and no comments → plannedAt = the event ts, lastCommentAt null.
      // A NON-planned event on the same item must NOT count as a plannedAt.
      const item1 = await createItem(1, "planned-no-comment", demotedAt);
      const ev1 = await prisma.foremanEvent.create({
        data: { workItemId: item1.id, orgId, ticketKey: "PD-1", kind: "planned", ts: plannedTs, message: "Planned PD-1 → To-do: top ROI", data: { why: "top ROI" } },
      });
      eventIds.push(ev1.id);
      const ev1b = await prisma.foremanEvent.create({
        data: { workItemId: item1.id, orgId, ticketKey: "PD-1", kind: "claimed", ts: new Date(), message: "claimed" },
      });
      eventIds.push(ev1b.id);

      // Item 2: a planned event AND a later comment → lastCommentAt reflects it.
      const item2 = await createItem(2, "planned-with-comment", demotedAt);
      const ev2 = await prisma.foremanEvent.create({
        data: { workItemId: item2.id, orgId, ticketKey: "PD-2", kind: "planned", ts: plannedTs, message: "Planned PD-2 → To-do", data: { why: "votes" } },
      });
      eventIds.push(ev2.id);
      const commentAt = new Date(Date.now() - 3600_000); // 1h ago (after the demotion)
      const c2 = await prisma.comment.create({ data: { orgId, workItemId: item2.id, authorId: alice.id, content: "still want this" } });
      // Comment.createdAt can't be set on create (mirrors fresh-mentions.test.ts) — backdate via raw SQL.
      await prisma.$executeRawUnsafe(`UPDATE "comments" SET "created_at" = $1 WHERE "id" = $2`, commentAt, c2.id);

      // Item 3: never planned, no comments → plannedAt null, lastCommentAt null.
      const item3 = await createItem(3, "never-planned", demotedAt);

      const facts = await getDemotionFacts([item1.id, item2.id, item3.id]);

      const f1 = facts.get(item1.id);
      expect(f1).toBeDefined();
      expect(f1?.plannedAt?.getTime()).toBe(plannedTs.getTime());
      expect(f1?.lastCommentAt).toBeNull();
      expect(f1?.updatedAt).toBeInstanceOf(Date);

      const f2 = facts.get(item2.id);
      expect(f2?.plannedAt?.getTime()).toBe(plannedTs.getTime());
      expect(f2?.lastCommentAt?.getTime()).toBe(commentAt.getTime());

      const f3 = facts.get(item3.id);
      expect(f3).toBeDefined();
      expect(f3?.plannedAt).toBeNull();
      expect(f3?.lastCommentAt).toBeNull();

      // Empty input short-circuits to an empty map (no queries).
      expect((await getDemotionFacts([])).size).toBe(0);
    } finally {
      await prisma.comment.deleteMany({ where: { workItemId: { in: itemIds } } });
      await prisma.foremanEvent.deleteMany({ where: { id: { in: eventIds } } });
      // work_items has no FK to organizations/projects (plain denormalized columns),
      // so the org delete below won't cascade to them — clean up explicitly first.
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });

  it("returns the NEWEST planned event ts when an item has several", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });
    const org = await prisma.organization.create({ data: { name: `planner-newest-${stamp}`, slug: `planner-newest-${stamp}` } });
    const orgId = org.id;
    const orgIds = [orgId];
    const project = await prisma.project.create({ data: { orgId, name: "Planner Newest Test", key: `PN${stamp.slice(-6).toUpperCase()}` } });

    const itemIds: string[] = [];
    const eventIds: string[] = [];
    try {
      const item = await prisma.workItem.create({
        data: { orgId, projectId: project.id, ticketNumber: 1, title: `[planner-newest] ${stamp}`, description: "", columnKey: "backlog", workItemTypeId: type.id, createdById: alice.id },
      });
      itemIds.push(item.id);
      const older = new Date(Date.now() - 5 * 24 * 3600_000);
      const newer = new Date(Date.now() - 1 * 24 * 3600_000);
      for (const ts of [older, newer]) {
        const ev = await prisma.foremanEvent.create({ data: { workItemId: item.id, orgId, kind: "planned", ts, message: "planned" } });
        eventIds.push(ev.id);
      }

      const facts = await getDemotionFacts([item.id]);
      expect(facts.get(item.id)?.plannedAt?.getTime()).toBe(newer.getTime());
    } finally {
      await prisma.foremanEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });
});
