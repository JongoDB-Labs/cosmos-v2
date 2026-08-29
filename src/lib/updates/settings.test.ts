// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { updateSettings: { findUnique: vi.fn(), upsert: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  getUpdateSettings, setUpdateSettings, describeAutoUpdate,
  DEFAULT_AUTO_UPDATE, UPDATE_SETTINGS_SCOPE,
} from "./settings";

beforeEach(() => vi.clearAllMocks());

describe("getUpdateSettings", () => {
  // The whole point of the default. Everywhere else an unreadable setting
  // resolves to doing LESS; here doing less means an instance silently stuck on
  // an old release, which is the outage this switch was built after.
  it("defaults to AUTOMATIC when no row exists", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(null);
    expect(await getUpdateSettings()).toEqual({ autoUpdate: true, updatedAt: null });
    expect(DEFAULT_AUTO_UPDATE).toBe(true);
  });

  it("returns a stored MANUAL choice — a deliberate write must stick", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue({
      autoUpdate: false,
      updatedAt: new Date("2026-08-29T00:00:00Z"),
    });
    const s = await getUpdateSettings();
    expect(s.autoUpdate).toBe(false);
    expect(s.updatedAt).toBe("2026-08-29T00:00:00.000Z");
  });

  it("reads the singleton by its scope key", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(null);
    await getUpdateSettings();
    expect(prisma.updateSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: UPDATE_SETTINGS_SCOPE } }),
    );
  });

  // A throw must reach the caller: the DAEMON treats an unreadable setting as
  // "keep updating", and it can only do that if it sees the failure.
  it("propagates a DB failure rather than inventing a value", async () => {
    prisma.updateSettings.findUnique.mockRejectedValue(new Error("db down"));
    await expect(getUpdateSettings()).rejects.toThrow("db down");
  });
});

describe("setUpdateSettings", () => {
  it("UPSERTS on the unique scope so a race cannot create a second row", async () => {
    prisma.updateSettings.upsert.mockResolvedValue({
      autoUpdate: false, updatedAt: new Date("2026-08-29T00:00:00Z"),
    });
    await setUpdateSettings(false, "user-1");
    const arg = prisma.updateSettings.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ scope: UPDATE_SETTINGS_SCOPE });
    expect(arg.create).toMatchObject({ scope: UPDATE_SETTINGS_SCOPE, autoUpdate: false });
    expect(arg.update).toMatchObject({ autoUpdate: false });
  });

  it("records who changed it", async () => {
    prisma.updateSettings.upsert.mockResolvedValue({ autoUpdate: true, updatedAt: new Date() });
    await setUpdateSettings(true, "user-42");
    expect(prisma.updateSettings.upsert.mock.calls[0][0].update).toMatchObject({
      updatedById: "user-42",
    });
  });
});

describe("describeAutoUpdate", () => {
  it("says what actually happens in each mode", () => {
    expect(describeAutoUpdate(true)).toMatch(/installs itself/i);
    expect(describeAutoUpdate(false)).toMatch(/waits for you/i);
  });
});
