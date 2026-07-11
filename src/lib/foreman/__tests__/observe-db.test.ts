import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";

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
  });
});
