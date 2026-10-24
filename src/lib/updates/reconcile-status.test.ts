// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { updateReconcileStatus: { findUnique: vi.fn(), upsert: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  recordReconcileStatus,
  getReconcileStatus,
  describeReconcileHealth,
  RECONCILE_STALE_MS,
  RECONCILE_STATUS_SCOPE,
  type ReconcileReport,
  type ReconcileStatusDto,
} from "./reconcile-status";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.updateReconcileStatus.upsert.mockResolvedValue({ id: "x" });
});

const NOW = new Date("2026-10-22T12:00:00Z");

const report = (over: Partial<ReconcileReport> = {}): ReconcileReport => ({
  outcome: "up-to-date",
  message: "Running 2.431.1, the newest release.",
  latestReleased: "2.431.1",
  runningVersion: "2.431.1",
  source: "registry.example.com/cosmos/assembly/alpha",
  ...over,
});

const dto = (over: Partial<ReconcileStatusDto> = {}): ReconcileStatusDto => ({
  ...report(),
  checkedAt: new Date(NOW.getTime() - 60_000).toISOString(),
  failingSince: null,
  ...over,
});

describe("recordReconcileStatus", () => {
  it("upserts the singleton on its scope, with checkedAt = now", async () => {
    await recordReconcileStatus(report(), NOW);
    const arg = prisma.updateReconcileStatus.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ scope: RECONCILE_STATUS_SCOPE });
    expect(arg.create).toMatchObject({ scope: RECONCILE_STATUS_SCOPE, outcome: "up-to-date", checkedAt: NOW });
    expect(arg.update).toMatchObject({ outcome: "up-to-date", checkedAt: NOW, failingSince: null });
  });

  it("STARTS the failing streak at now when the previous pass was not failing", async () => {
    prisma.updateReconcileStatus.findUnique.mockResolvedValue({ outcome: "up-to-date", failingSince: null });
    await recordReconcileStatus(report({ outcome: "failing", message: "pull denied" }), NOW);
    expect(prisma.updateReconcileStatus.upsert.mock.calls[0][0].update.failingSince).toEqual(NOW);
  });

  it("starts the streak at now when there is no previous report at all", async () => {
    prisma.updateReconcileStatus.findUnique.mockResolvedValue(null);
    await recordReconcileStatus(report({ outcome: "failing" }), NOW);
    expect(prisma.updateReconcileStatus.upsert.mock.calls[0][0].create.failingSince).toEqual(NOW);
  });

  // The point of the column: "failing since Tuesday" is a different emergency
  // from "failing since a minute ago", and resetting it every pass erases that.
  it("KEEPS the original failingSince while the outcome stays failing", async () => {
    const began = new Date("2026-10-20T08:00:00Z");
    prisma.updateReconcileStatus.findUnique.mockResolvedValue({ outcome: "failing", failingSince: began });
    await recordReconcileStatus(report({ outcome: "failing" }), NOW);
    expect(prisma.updateReconcileStatus.upsert.mock.calls[0][0].update.failingSince).toEqual(began);
  });

  it("CLEARS failingSince on any other outcome, without reading the old row", async () => {
    await recordReconcileStatus(report({ outcome: "deployed" }), NOW);
    expect(prisma.updateReconcileStatus.findUnique).not.toHaveBeenCalled();
    expect(prisma.updateReconcileStatus.upsert.mock.calls[0][0].update.failingSince).toBeNull();
  });

  // The daemon catches this; it can only do so if it sees it.
  it("throws on a DB failure", async () => {
    prisma.updateReconcileStatus.upsert.mockRejectedValue(new Error("db down"));
    await expect(recordReconcileStatus(report(), NOW)).rejects.toThrow("db down");
  });
});

describe("getReconcileStatus", () => {
  it("is null when the installer has never reported", async () => {
    prisma.updateReconcileStatus.findUnique.mockResolvedValue(null);
    expect(await getReconcileStatus()).toBeNull();
  });

  it("serialises dates to ISO strings", async () => {
    prisma.updateReconcileStatus.findUnique.mockResolvedValue({
      ...report({ outcome: "failing" }),
      checkedAt: NOW,
      failingSince: new Date("2026-10-20T08:00:00Z"),
    });
    const s = await getReconcileStatus();
    expect(s?.checkedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(s?.failingSince).toBe("2026-10-20T08:00:00.000Z");
  });
});

describe("describeReconcileHealth", () => {
  it("no report: muted, and points at Foreman / FOREMAN_INSTANCE", () => {
    const h = describeReconcileHealth(null, true, NOW);
    expect(h.tone).toBe("muted");
    expect(h.headline).toBe("The automatic installer hasn't reported in yet");
    expect(h.detail).toMatch(/Foreman may not be running/);
    expect(h.detail).toMatch(/FOREMAN_INSTANCE/);
  });

  it("a report older than RECONCILE_STALE_MS: error, gone quiet, with the last check time", () => {
    const checkedAt = new Date(NOW.getTime() - RECONCILE_STALE_MS - 60_000).toISOString();
    const h = describeReconcileHealth(dto({ checkedAt }), true, NOW);
    expect(h.tone).toBe("error");
    expect(h.headline).toBe("The automatic installer has gone quiet");
    expect(h.detail).toMatch(/Oct 22, 2026/);
    expect(h.detail).toMatch(/11 minutes ago/);
  });

  // Stale beats a reassuring outcome: an "up-to-date" written hours ago says
  // nothing about now.
  it("staleness wins over an OK outcome", () => {
    const checkedAt = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    expect(describeReconcileHealth(dto({ outcome: "up-to-date", checkedAt }), true, NOW).tone).toBe("error");
  });

  it("a report exactly at the threshold is still fresh", () => {
    const checkedAt = new Date(NOW.getTime() - RECONCILE_STALE_MS).toISOString();
    expect(describeReconcileHealth(dto({ checkedAt }), true, NOW).tone).toBe("ok");
  });

  it("failing: error, with the daemon's message and since when", () => {
    const h = describeReconcileHealth(
      dto({ outcome: "failing", message: "pull access denied", failingSince: "2026-10-22T09:00:00.000Z" }),
      true,
      NOW,
    );
    expect(h.tone).toBe("error");
    expect(h.headline).toMatch(/Installing 2\.431\.1 is failing/);
    expect(h.detail).toMatch(/pull access denied/);
    expect(h.detail).toMatch(/since Oct 22, 2026, 9:00 AM UTC \(3 hours ago\)/);
  });

  it("waiting-manual: warn, naming the version", () => {
    const h = describeReconcileHealth(dto({ outcome: "waiting-manual", message: "Manual mode." }), false, NOW);
    expect(h.tone).toBe("warn");
    expect(h.headline).toMatch(/2\.431\.1 is ready and waiting for you/);
    expect(h.detail).toBe("Manual mode.");
  });

  it("waiting-manual while the switch now says Automatic: says it will catch up", () => {
    const h = describeReconcileHealth(dto({ outcome: "waiting-manual", message: "Manual mode." }), true, NOW);
    expect(h.detail).toMatch(/next check/);
  });

  // Every release passes through this while its image builds; it must not read
  // as a problem, and it must still go stale like any other report.
  it("pending: muted, the version is on its way and installs once built", () => {
    const h = describeReconcileHealth(dto({ outcome: "pending", runningVersion: "2.427.0" }), true, NOW);
    expect(h.tone).toBe("muted");
    expect(h.headline).toBe("A newer version (2.431.1) is on its way");
    expect(h.detail).toBe("It installs automatically once its image is built.");
  });

  it("pending in Manual mode does not promise an automatic install", () => {
    const h = describeReconcileHealth(dto({ outcome: "pending" }), false, NOW);
    expect(h.detail).not.toMatch(/automatically/);
  });

  it("a stale pending report is still 'gone quiet'", () => {
    const checkedAt = new Date(NOW.getTime() - RECONCILE_STALE_MS - 1).toISOString();
    expect(describeReconcileHealth(dto({ outcome: "pending", checkedAt }), true, NOW).tone).toBe("error");
  });

  it("deployed: ok", () => {
    const h = describeReconcileHealth(dto({ outcome: "deployed", message: "Installed." }), true, NOW);
    expect(h.tone).toBe("ok");
    expect(h.headline).toMatch(/Installed 2\.431\.1/);
  });

  it("up-to-date: ok", () => {
    const h = describeReconcileHealth(dto({ outcome: "up-to-date" }), true, NOW);
    expect(h.tone).toBe("ok");
    expect(h.headline).toMatch(/newest release/);
  });

  it("an outcome this page does not know yet: warn, not ok", () => {
    const h = describeReconcileHealth(dto({ outcome: "paused" as never }), true, NOW);
    expect(h.headline).toMatch(/unexpected/);
    expect(h.tone).toBe("warn");
  });

  it("never uses internal jargon in what it shows the operator", () => {
    const all = [
      describeReconcileHealth(null, true, NOW),
      describeReconcileHealth(dto({ checkedAt: "2026-10-01T00:00:00Z" }), true, NOW),
      describeReconcileHealth(dto({ outcome: "failing", message: "x", failingSince: NOW.toISOString() }), true, NOW),
    ];
    for (const h of all) expect(`${h.headline} ${h.detail}`).not.toMatch(/reconcil/i);
  });
});
