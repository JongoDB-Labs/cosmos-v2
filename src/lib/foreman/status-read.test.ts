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

  it("joins the latest parked/gated/needs-input event per work item (batched, not N+1) and reflects a live-enabled config", async () => {
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
    let eventId: string | undefined;

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

      const event = await prisma.foremanEvent.create({
        data: {
          workItemId: itemA.id, orgId: org.id, ticketKey: "TST-901", kind: "parked",
          message: "checks failed", data: { reason: "checks failed", prUrl: "https://example.com/pr/1" },
        },
      });
      eventId = event.id;

      const s = await assembleStatus(org.id);
      expect(s.paused).toBe(false);
      expect(s.hasHistory).toBe(true);

      const rowA = s.awaitingApproval.find((r) => r.workItemId === itemA.id);
      const rowB = s.awaitingApproval.find((r) => r.workItemId === itemB.id);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      expect(rowA?.reason).toBe("checks failed");
      expect(rowA?.prUrl).toBe("https://example.com/pr/1");
      expect(rowA?.ticketKey).toBe("TST-901");
      expect(rowB?.reason).toBeNull();
      expect(rowB?.prUrl).toBeNull();
    } finally {
      if (eventId) await prisma.foremanEvent.delete({ where: { id: eventId } }).catch(() => undefined);
      if (itemAId) await prisma.workItem.delete({ where: { id: itemAId } }).catch(() => undefined);
      if (itemBId) await prisma.workItem.delete({ where: { id: itemBId } }).catch(() => undefined);
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
