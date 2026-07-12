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
    let itemDId: string | undefined;
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

      const itemD = await prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: nextTicket + 3,
          title: `status-read join fixture D ${stamp}`, description: "", columnKey: "review",
          workItemTypeId: type.id, createdById: author.id,
        },
      });
      itemDId = itemD.id;

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
      // Item D: a `ship-failed` event — its prUrl must surface too, proving the join
      // reads the shared PARKED_EVENT_KINDS list (parked/gated/needs-input/ship-failed/
      // merged-undeployed) rather than a narrower inline set.
      const shipFailedEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: itemD.id, orgId: org.id, ticketKey: "TST-904", kind: "ship-failed",
          message: "ship failed before merge",
          data: { prUrl: "https://example.com/pr/4", version: "9.9.9", branch: "auto/TST-904" },
        },
      });
      eventIds.push(shipFailedEvent.id);

      const s = await assembleStatus(org.id);
      expect(s.paused).toBe(false);
      expect(s.hasHistory).toBe(true);
      // actorCanSteer is threaded from the arg (route computes the base-role gate):
      // default false, explicit true flips it. The cards surface regardless (F5).
      expect(s.actorCanSteer).toBe(false);
      expect((await assembleStatus(org.id, true)).actorCanSteer).toBe(true);

      const rowA = s.awaitingApproval.find((r) => r.workItemId === itemA.id);
      const rowB = s.awaitingApproval.find((r) => r.workItemId === itemB.id);
      const rowC = s.awaitingApproval.find((r) => r.workItemId === itemC.id);
      const rowD = s.awaitingApproval.find((r) => r.workItemId === itemD.id);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      expect(rowC).toBeDefined();
      expect(rowD).toBeDefined();
      // Every row carries projectId (added for the console's Approve POST URL).
      expect(rowA?.projectId).toBe(project.id);
      expect(rowB?.projectId).toBe(project.id);
      expect(rowC?.projectId).toBe(project.id);
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
      // D: ship-failed prUrl surfaced (shared PARKED_EVENT_KINDS).
      expect(rowD?.prUrl).toBe("https://example.com/pr/4");
      expect(rowD?.ticketKey).toBe("TST-904");
    } finally {
      for (const id of eventIds) await prisma.foremanEvent.delete({ where: { id } }).catch(() => undefined);
      if (itemAId) await prisma.workItem.delete({ where: { id: itemAId } }).catch(() => undefined);
      if (itemBId) await prisma.workItem.delete({ where: { id: itemBId } }).catch(() => undefined);
      if (itemCId) await prisma.workItem.delete({ where: { id: itemCId } }).catch(() => undefined);
      if (itemDId) await prisma.workItem.delete({ where: { id: itemDId } }).catch(() => undefined);
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

  it("returns upNext: todo-column items in claim order (priority then FIFO), why from the latest planned event and null when Foreman never touched it, scoped to delivery projects, no permission/member fields", async () => {
    const org = await prisma.organization.findFirstOrThrow({
      where: { slug: "test-org" },
      select: { id: true, settings: true },
    });
    const project = await prisma.project.findFirstOrThrow({ where: { orgId: org.id } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { OR: [{ orgId: org.id }, { orgId: null }] } });
    const author = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });

    const originalSettings = org.settings;
    const settingsRecord = (org.settings ?? {}) as Record<string, unknown>;

    const last = await prisma.workItem.findFirst({
      where: { projectId: project.id },
      orderBy: { ticketNumber: "desc" },
      select: { ticketNumber: true },
    });
    const nextTicket = (last?.ticketNumber ?? 0) + 1;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    let criticalId: string | undefined;
    let highOlderId: string | undefined;
    let highNewerId: string | undefined;
    let backlogId: string | undefined;
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

      // CRITICAL, newest columnEnteredAt, no planned event (human-dragged straight
      // into To-do) — must still outrank both HIGH items despite being the newest,
      // because priority tier beats age; why stays null.
      const critical = await prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: nextTicket,
          title: `upNext fixture CRITICAL ${stamp}`, description: "", columnKey: "todo", priority: "CRITICAL",
          workItemTypeId: type.id, createdById: author.id, columnEnteredAt: new Date(now - 1 * 3600_000),
        },
      });
      criticalId = critical.id;

      // HIGH, older columnEnteredAt, WITH a planned event carrying `why` — must
      // sort before the newer HIGH item within the same tier (FIFO).
      const highOlder = await prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: nextTicket + 1,
          title: `upNext fixture HIGH older ${stamp}`, description: "", columnKey: "todo", priority: "HIGH",
          workItemTypeId: type.id, createdById: author.id, columnEnteredAt: new Date(now - 5 * 3600_000),
        },
      });
      highOlderId = highOlder.id;
      const plannedEvent = await prisma.foremanEvent.create({
        data: {
          workItemId: highOlder.id, orgId: org.id, ticketKey: "TST-950", kind: "planned",
          message: "Planned TST-950 -> To-do: highest open ROI", data: { why: "Highest open ROI" },
          ts: new Date(now - 5 * 3600_000),
        },
      });
      eventIds.push(plannedEvent.id);
      // A later, non-planned event on the same item must not leak into `why`.
      const claimedEvent = await prisma.foremanEvent.create({
        data: { workItemId: highOlder.id, orgId: org.id, kind: "claimed", message: "claimed", ts: new Date(now - 4 * 3600_000) },
      });
      eventIds.push(claimedEvent.id);

      // HIGH, newer columnEnteredAt, no planned event — human-added, why null;
      // must sort AFTER highOlder within the same HIGH tier.
      const highNewer = await prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: nextTicket + 2,
          title: `upNext fixture HIGH newer ${stamp}`, description: "", columnKey: "todo", priority: "HIGH",
          workItemTypeId: type.id, createdById: author.id, columnEnteredAt: new Date(now - 2 * 3600_000),
        },
      });
      highNewerId = highNewer.id;

      // Backlog-column item, same org/project — must NOT appear (upNext is
      // scoped to the todo column only; backlog is a different surface).
      const backlog = await prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: nextTicket + 3,
          title: `upNext fixture BACKLOG ${stamp}`, description: "", columnKey: "backlog", priority: "CRITICAL",
          workItemTypeId: type.id, createdById: author.id, columnEnteredAt: new Date(now - 1 * 3600_000),
        },
      });
      backlogId = backlog.id;

      const s = await assembleStatus(org.id);

      const rowCritical = s.upNext.find((r) => r.workItemId === critical.id);
      const rowHighOlder = s.upNext.find((r) => r.workItemId === highOlder.id);
      const rowHighNewer = s.upNext.find((r) => r.workItemId === highNewer.id);
      expect(rowCritical).toBeDefined();
      expect(rowHighOlder).toBeDefined();
      expect(rowHighNewer).toBeDefined();
      expect(s.upNext.find((r) => r.workItemId === backlog.id)).toBeUndefined();

      // `why`: populated from the latest planned event; null for a human-added item.
      expect(rowHighOlder?.why).toBe("Highest open ROI");
      expect(rowCritical?.why).toBeNull();
      expect(rowHighNewer?.why).toBeNull();

      // Claim order: CRITICAL first (priority beats age), then HIGH tier oldest-first.
      const idx = (id: string) => s.upNext.findIndex((r) => r.workItemId === id);
      expect(idx(critical.id)).toBeLessThan(idx(highOlder.id));
      expect(idx(highOlder.id)).toBeLessThan(idx(highNewer.id));

      // Row shape: exactly the documented fields — no permission/member data.
      expect(Object.keys(rowCritical!).sort()).toEqual(
        ["projectId", "since", "ticketKey", "title", "why", "workItemId"].sort(),
      );
      expect(rowCritical?.projectId).toBe(project.id);
      expect(typeof rowCritical?.ticketKey).toBe("string");
      expect(rowCritical?.title).toBe(`upNext fixture CRITICAL ${stamp}`);
      expect(rowHighOlder?.since).toBe(new Date(now - 5 * 3600_000).toISOString());
    } finally {
      for (const id of eventIds) await prisma.foremanEvent.delete({ where: { id } }).catch(() => undefined);
      for (const id of [criticalId, highOlderId, highNewerId, backlogId]) {
        if (id) await prisma.workItem.delete({ where: { id } }).catch(() => undefined);
      }
      await prisma.organization.update({
        where: { id: org.id },
        data: { settings: originalSettings as unknown as Prisma.InputJsonValue },
      });
    }
  });
});
