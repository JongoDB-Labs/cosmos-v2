// @vitest-environment node
//
// The event backlog read, against a real database: unprocessed events and how
// old the oldest is, and the webhook queue. Other spec files share the
// database, so each read is scoped to this file's own org.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { eventBacklogHealth, readEventBacklog } from "./backlog.server";

let orgId = "";
const subjectId = crypto.randomUUID();

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({ data: { name: `bl ${stamp}`, slug: `bl-${stamp}` } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

describe("readEventBacklog", () => {
  it("counts unprocessed events and ages the oldest, and leaves processed ones out", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 20 * 60_000);
    await prisma.domainEvent.create({ data: { orgId, type: "work_item.updated", subjectId, source: "SYSTEM", createdAt: old } });
    await prisma.domainEvent.create({ data: { orgId, type: "work_item.updated", subjectId, source: "SYSTEM", createdAt: new Date(now.getTime() - 60 * 60_000), processedAt: now } });

    // The processed one, older still, is neither counted nor the oldest.
    expect(await readEventBacklog(prisma, now, orgId)).toMatchObject({ unprocessed: 1, oldestAgeSeconds: 20 * 60 });
    // Unscoped, as the admin page reads it: a 20-minute-old event is a stalled worker.
    expect((await eventBacklogHealth(prisma, now)).tone).toBe("error");

    await prisma.domainEvent.updateMany({ where: { orgId }, data: { processedAt: now } });
    expect(await readEventBacklog(prisma, now, orgId)).toMatchObject({ unprocessed: 0, oldestAgeSeconds: null });
  });

  it("counts queued and recently failed webhook deliveries", async () => {
    const hook = await prisma.webhook.create({ data: { orgId, url: "https://hooks.example/in", events: [], secret: "s" } });
    await prisma.webhookDelivery.createMany({
      data: [
        { webhookId: hook.id, event: "e", payload: {}, status: "PENDING", nextAttemptAt: new Date() },
        // A test delivery: not queued, not counted.
        { webhookId: hook.id, event: "test", payload: {}, status: "PENDING" },
        { webhookId: hook.id, event: "e", payload: {}, status: "FAILED", lastAttemptAt: new Date() },
        { webhookId: hook.id, event: "e", payload: {}, status: "FAILED", lastAttemptAt: new Date(Date.now() - 2 * 3_600_000) },
      ],
    });
    expect(await readEventBacklog(prisma, new Date(), orgId)).toMatchObject({ pendingDeliveries: 1, failedDeliveriesLastHour: 1 });
  });
});
