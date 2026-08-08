// @vitest-environment node
//
// The licence rule is pure and tested next door. That is necessary and not
// sufficient — this codebase's recurring defect is a correct rule with one call
// site, so this asserts the WIRING: that `isPluginEnabled`, which every plugin
// guard forwards to, actually consults it.
//
// Also pins the property that made it safe to ship this ahead of any business
// model: a plugin that does not declare `requiresEntitlement` is untouched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { signingInput, ANY } from "@/lib/licensing/entitlement";

const findUnique = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: { orgPluginState: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));
// The generated registry is empty in the public core; stub the side-effect
// import so this file does not depend on whether a plugin happens to be composed.
vi.mock("@/lib/plugins/registry/server", () => ({}));

const manifests = new Map<string, { slug: string; requiresEntitlement?: boolean }>();
vi.mock("@/lib/plugins/registry", async (orig) => {
  const actual = await orig<typeof import("@/lib/plugins/registry")>();
  return {
    ...actual,
    PluginRegistry: { ...actual.PluginRegistry, get: (s: string) => manifests.get(s) },
    PluginServerRegistry: { ...actual.PluginServerRegistry, get: () => undefined },
  };
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "pem" }).toString();

function mint(plugins: string[], orgId = "org-1"): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, lid: "l", orgId, instance: ANY, plugins, iat: now - 60, exp: now + 3600 }),
  ).toString("base64url");
  const sig = sign(null, signingInput(payload), privateKey).toString("base64url");
  return `cosmos-lic.v1.${payload}.${sig}`;
}

let isPluginEnabled: (o: string, s: string) => Promise<boolean>;
let resetLicenseCache: () => void;

beforeEach(async () => {
  vi.resetModules();
  manifests.clear();
  findUnique.mockReset();
  // Every org has switched the plugin ON; the only variable under test is the licence.
  findUnique.mockResolvedValue({ enabled: true });
  delete process.env.COSMOS_LICENSE;
  process.env.COSMOS_LICENSE_PUBLIC_KEY = PUB;

  ({ isPluginEnabled } = await import("./enablement"));
  ({ resetLicenseCache } = await import("@/lib/licensing/license"));
  resetLicenseCache();
});

afterEach(() => {
  delete process.env.COSMOS_LICENSE;
  delete process.env.COSMOS_LICENSE_PUBLIC_KEY;
});

describe("a plugin that does NOT require entitlement", () => {
  it("is unaffected by licensing — no licence, still enabled", () => {
    manifests.set("free-thing", { slug: "free-thing" });
    return expect(isPluginEnabled("org-1", "free-thing")).resolves.toBe(true);
  });

  it("is unaffected even when a licence exists that omits it", async () => {
    manifests.set("free-thing", { slug: "free-thing" });
    process.env.COSMOS_LICENSE = mint(["something-else"]);
    resetLicenseCache();
    await expect(isPluginEnabled("org-1", "free-thing")).resolves.toBe(true);
  });

  it("is unaffected when the plugin is not in the registry at all", async () => {
    // The public core ships an EMPTY registry. If an unknown slug fell through
    // to "needs a licence", enabling anything there would break.
    await expect(isPluginEnabled("org-1", "unregistered")).resolves.toBe(true);
  });
});

describe("a plugin that DOES require entitlement", () => {
  beforeEach(() => manifests.set("paid-thing", { slug: "paid-thing", requiresEntitlement: true }));

  it("is refused with no licence, even though the org switched it on", async () => {
    // The hole this closes: an operator with database access could set
    // enabled = true and get a paid plugin. The row is no longer sufficient.
    await expect(isPluginEnabled("org-1", "paid-thing")).resolves.toBe(false);
  });

  it("is allowed with a licence that names it", async () => {
    process.env.COSMOS_LICENSE = mint(["paid-thing"]);
    resetLicenseCache();
    await expect(isPluginEnabled("org-1", "paid-thing")).resolves.toBe(true);
  });

  it("is refused with a licence issued for another ORG", async () => {
    process.env.COSMOS_LICENSE = mint(["paid-thing"], "org-2");
    resetLicenseCache();
    await expect(isPluginEnabled("org-1", "paid-thing")).resolves.toBe(false);
  });

  it("is refused with a licence that covers a different plugin", async () => {
    process.env.COSMOS_LICENSE = mint(["other-paid-thing"]);
    resetLicenseCache();
    await expect(isPluginEnabled("org-1", "paid-thing")).resolves.toBe(false);
  });

  it("is still refused when the org row says disabled", async () => {
    // Both gates must pass. A licence is permission to enable, never enablement.
    findUnique.mockResolvedValue({ enabled: false });
    process.env.COSMOS_LICENSE = mint(["paid-thing"]);
    resetLicenseCache();
    await expect(isPluginEnabled("org-1", "paid-thing")).resolves.toBe(false);
  });
});
