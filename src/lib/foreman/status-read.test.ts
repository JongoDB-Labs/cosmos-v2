import { describe, expect, it, beforeAll } from "vitest";
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
});
