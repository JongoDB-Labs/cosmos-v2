// @vitest-environment node
//
// provisionEntitlements wiring (Phase 3): the runtime DEFAULT_ENABLED_* env must
// override the profile default at provision time. We mock the DB client + getBrand
// so this is a pure behavioral test of the env→create-row path.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PRODUCT_PROFILES } from "@/lib/product/profiles";

const { prisma, getBrand } = vi.hoisted(() => ({
  prisma: { orgEntitlements: { create: vi.fn() } },
  getBrand: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/brand", () => ({ getBrand }));

import { provisionEntitlements } from "./index";

const ORG = "org-1";
const originalMods = process.env.DEFAULT_ENABLED_MODULES;
const originalSecs = process.env.DEFAULT_ENABLED_SECTORS;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DEFAULT_ENABLED_MODULES;
  delete process.env.DEFAULT_ENABLED_SECTORS;
  prisma.orgEntitlements.create.mockResolvedValue({ orgId: ORG });
  getBrand.mockReturnValue(PRODUCT_PROFILES.cosmos); // null / null defaults (all on)
});
afterEach(() => {
  if (originalMods === undefined) delete process.env.DEFAULT_ENABLED_MODULES;
  else process.env.DEFAULT_ENABLED_MODULES = originalMods;
  if (originalSecs === undefined) delete process.env.DEFAULT_ENABLED_SECTORS;
  else process.env.DEFAULT_ENABLED_SECTORS = originalSecs;
});

describe("provisionEntitlements — runtime env override", () => {
  it("writes an AEC sector allowlist when DEFAULT_ENABLED_SECTORS=aec on a cosmos profile", async () => {
    process.env.DEFAULT_ENABLED_SECTORS = "aec";
    await provisionEntitlements(ORG);
    expect(prisma.orgEntitlements.create).toHaveBeenCalledTimes(1);
    expect(prisma.orgEntitlements.create.mock.calls[0][0]).toEqual({
      data: {
        orgId: ORG,
        moduleAllowlistEnabled: false,
        enabledModules: [],
        sectorAllowlistEnabled: true,
        enabledSectors: ["aec"],
      },
    });
  });

  it("stays row-free (no create) when the env is unset and the profile is all-on (cosmos)", async () => {
    await provisionEntitlements(ORG);
    expect(prisma.orgEntitlements.create).not.toHaveBeenCalled();
  });
});
