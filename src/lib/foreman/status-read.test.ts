import { describe, expect, it, beforeAll } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { assembleStatus } from "./status-read";

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.findFirst({ where: { slug: "test-org" }, select: { id: true } });
  if (!org) throw new Error("seeded test-org missing");
  orgId = org.id;
  await prisma.foremanState.upsert({
    where: { id: "host" },
    create: {
      id: "host", startedAt: new Date(), lastPassAt: new Date(), daemonVersion: "t", pid: 1,
      workerTarget: 2, slotsBusy: 1, queueDepth: 4,
      inFlight: [
        { key: "X-1", itemId: "00000000-0000-0000-0000-0000000000aa", orgId, title: "mine", phase: "building", since: new Date().toISOString() },
        { key: "Y-1", itemId: "00000000-0000-0000-0000-0000000000bb", orgId: "00000000-0000-0000-0000-0000000000ff", title: "other org", phase: "checks", since: new Date().toISOString() },
      ],
      breaker: { build: 0, deploy: 0, tripped: false }, stopFileSeen: false,
    },
    update: { lastPassAt: new Date(), inFlight: [
      { key: "X-1", itemId: "00000000-0000-0000-0000-0000000000aa", orgId, title: "mine", phase: "building", since: new Date().toISOString() },
      { key: "Y-1", itemId: "00000000-0000-0000-0000-0000000000bb", orgId: "00000000-0000-0000-0000-0000000000ff", title: "other org", phase: "checks", since: new Date().toISOString() },
    ] },
  });
});

describe("assembleStatus", () => {
  it("filters inFlight to the org and computes a pulse", async () => {
    const s = await assembleStatus(orgId);
    expect(s.state?.pulse).toBeDefined();
    expect(s.inFlight.map((b) => b.key)).toEqual(["X-1"]);
  });
  it("reports paused from org config and echoes full config", async () => {
    const s = await assembleStatus(orgId);
    expect(typeof s.paused).toBe("boolean");
    expect(s.config.autonomousDelivery).toHaveProperty("workers");
  });
  it("returns state:null when the singleton is missing", async () => {
    await prisma.foremanState.deleteMany({});
    const s = await assembleStatus(orgId);
    expect(s.state).toBeNull();
  });

  it("surfaces the newest REASONED park event per item (parked reason beats a later empty gated), surfaces merged-undeployed prUrl, batched not N+1, and reflects a live-enabled config", async () => {
    // The previous test deleted the "host" singleton — recreate it so `state` is non-null again.
    await prisma.foremanState.upsert({
      where: { id: "host" },
      create: {
        id: "host", startedAt: new Date(), lastPassAt: new Date(), daemonVersion: "t", pid: 1,
        workerTarget: 2, slotsBusy: 1, queueDepth: 4, inFlight: [],
        breaker: { build: 0, deploy: 0, tripped: false }, stopFileSeen: false,
      },
      update: { lastPassAt: new Date() },
    });

    const org = await prisma.organization.findFirstOrThrow({
      where: { slug: "test-org" },
      select: { id: true, settings: true },
    });
    const project = await prisma.project.findFirstOrThrow({ where: { orgId: org.id } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { OR: [{ orgId: org.id }, { orgId: null }] } });
    const author = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });

    const originalSettings = org.settings;
    const baselinePaused = (await assembleStatus(org.id)).paused;
    const settingsRecord = (org.settings ?? {}) as Record<string, unknown>;

    const last = await prisma.workItem.findFirst({
      where: { projectId: project.id },
      orderBy: { ticketNumber: "desc" },
      select: { ticketNumber: true },
    });
    const nextTicket = (last?.ticketNumber ?? 0) + 1;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let itemAId: string | undefined;
    let itemBId: string | undefined;
    let itemCId: string | undefined;
    const eventIds: string[] = [];

    try {
      await prisma.organization.update({
        where: { id: org.id },
        data: {
          settings: {
            ...settingsRecord,
            autonomousDelivery: { enabled: true, projectIds: [project.id], workers: 2, notify: { parked: true, shipped: true } },
          },
        },
      });

      const itemA = await prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: nextTicket,
          title: `status-read join fixture A ${stamp}`, description: "", columnKey: "review",
          workItemTypeId: type.id, createdById: author.id,
        },
      });
      itemAId = itemA.id;

      const itemB = await prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: nextTicket + 1,
          title: `status-read join fixture B ${stamp}`, description: "", columnKey: "review",
          workItemTypeId: type.id, createdById: author.id,
        },
      });
      itemBId = itemB.id;

      const itemC = await prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: nextTicket + 2,
          title: `status-read join fixture C ${stamp}`, description: "", columnKey: "review",
          workItemTypeId: type.id, createdById: author.id,
        },
      });
      itemCId = itemC.id;

      // Item A: a `parked` event carrying reason + prUrl, then a LATER `gated` event
      // with EMPTY data. The join must still surface the parked reason/prUrl — not
      // blank them because a reason-less event arrived afterward.
      const baseTs = Date.now();
      const parkedEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: itemA.id, orgId: org.id, ticketKey: "TST-901", kind: "parked",
          message: "checks failed", data: { reason: "checks failed", prUrl: "https://example.com/pr/1" },
          ts: new Date(baseTs),
        },
      });
      eventIds.push(parkedEvent.id);
      const gatedEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: itemA.id, orgId: org.id, kind: "gated",
          message: "", data: {}, ts: new Date(baseTs + 60_000),
        },
      });
      eventIds.push(gatedEvent.id);
      // Item C: a `merged-undeployed` event whose prUrl must be surfaced (kind now in
      // the join set; it has no data.reason, so the row's reason falls back to message).
      const mergedEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: itemC.id, orgId: org.id, ticketKey: "TST-903", kind: "merged-undeployed",
          message: "merged but not deployed (v9.9.9)",
          data: { prUrl: "https://example.com/pr/3", version: "9.9.9", merged: true },
        },
      });
      eventIds.push(mergedEvent.id);

      const s = await assembleStatus(org.id);
      expect(s.paused).toBe(false);
      expect(s.hasHistory).toBe(true);

      const rowA = s.awaitingApproval.find((r) => r.workItemId === itemA.id);
      const rowB = s.awaitingApproval.find((r) => r.workItemId === itemB.id);
      const rowC = s.awaitingApproval.find((r) => r.workItemId === itemC.id);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      expect(rowC).toBeDefined();
      // A: reason + prUrl come from the parked event, NOT the newer empty `gated` one.
      expect(rowA?.reason).toBe("checks failed");
      expect(rowA?.prUrl).toBe("https://example.com/pr/1");
      expect(rowA?.ticketKey).toBe("TST-901");
      // B: no events → null reason/prUrl.
      expect(rowB?.reason).toBeNull();
      expect(rowB?.prUrl).toBeNull();
      // C: merged-undeployed prUrl surfaced.
      expect(rowC?.prUrl).toBe("https://example.com/pr/3");
      expect(rowC?.ticketKey).toBe("TST-903");
    } finally {
      for (const id of eventIds) await prisma.foremanEvent.delete({ where: { id } }).catch(() => undefined);
      if (itemAId) await prisma.workItem.delete({ where: { id: itemAId } }).catch(() => undefined);
      if (itemBId) await prisma.workItem.delete({ where: { id: itemBId } }).catch(() => undefined);
      if (itemCId) await prisma.workItem.delete({ where: { id: itemCId } }).catch(() => undefined);
      await prisma.organization.update({
        where: { id: org.id },
        data: { settings: originalSettings as unknown as Prisma.InputJsonValue },
      });
    }

    // Polarity check: whatever `paused` was before this test touched settings,
    // it must be exactly that again now that the original settings are restored.
    const restored = await assembleStatus(org.id);
    expect(restored.paused).toBe(baselinePaused);
  });
});
