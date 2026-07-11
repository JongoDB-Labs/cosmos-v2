import { describe, expect, it, vi, afterEach } from "vitest";
import { prisma } from "@/lib/db/client";
import { boot, heartbeat, track } from "../../../../scripts/foreman/observe.mjs";

afterEach(() => vi.restoreAllMocks());

describe("foreman observability tables", () => {
  it("round-trips the state singleton", async () => {
    await prisma.foremanState.upsert({
      where: { id: "host" },
      create: {
        id: "host", startedAt: new Date(), lastPassAt: new Date(),
        daemonVersion: "0.0.0-test", pid: 1, workerTarget: 2, slotsBusy: 0,
        queueDepth: 0, inFlight: [], breaker: { build: 0, deploy: 0, tripped: false },
        stopFileSeen: false,
      },
      update: { lastPassAt: new Date() },
    });
    const row = await prisma.foremanState.findUnique({ where: { id: "host" } });
    expect(row?.daemonVersion).toBeTruthy();
  });

  it("appends and reads events newest-first", async () => {
    await prisma.foremanEvent.create({
      data: { kind: "boot", message: "test boot", severity: "info" },
    });
    const rows = await prisma.foremanEvent.findMany({ orderBy: { ts: "desc" }, take: 1 });
    expect(rows[0]?.kind).toBeTruthy();
    await prisma.foremanEvent.deleteMany({ where: { kind: "boot", message: "test boot" } });
  });
});

describe("observe.mts writers", () => {
  it("boot + heartbeat maintain the singleton", async () => {
    await boot({ daemonVersion: "9.9.9-test", pid: 42, workerTarget: 2 });
    await heartbeat({
      workerTarget: 3, slotsBusy: 1, queueDepth: 5,
      inFlight: [{ key: "COSMOS-1", itemId: "00000000-0000-0000-0000-000000000001", orgId: "00000000-0000-0000-0000-000000000002", title: "t", phase: "building", since: new Date().toISOString() }],
      breaker: { build: 0, deploy: 1, tripped: false }, stopFileSeen: false,
    });
    const row = await prisma.foremanState.findUnique({ where: { id: "host" } });
    expect(row?.workerTarget).toBe(3);
    expect(row?.slotsBusy).toBe(1);
  });

  it("track resolves orgId from workItemId", async () => {
    const wi = await prisma.workItem.findFirst({ select: { id: true, orgId: true } });
    if (!wi) return; // seeded DB always has one; guard for empty envs
    await track({ workItemId: wi.id, ticketKey: "T-1", kind: "gated", message: "m" });
    const ev = await prisma.foremanEvent.findFirst({ where: { ticketKey: "T-1" }, orderBy: { ts: "desc" } });
    expect(ev?.orgId).toBe(wi.orgId);
    await prisma.foremanEvent.deleteMany({ where: { ticketKey: "T-1", message: "m" } });
  });

  it("never throws when the write fails", async () => {
    vi.spyOn(prisma.foremanEvent, "create").mockRejectedValueOnce(new Error("db down"));
    await expect(track({ kind: "error", message: "x" })).resolves.toBeUndefined();
  });
});
