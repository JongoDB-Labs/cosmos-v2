// @vitest-environment node
//
// Connector credential accessor — locks the seal-at-rest contract: setCredential
// seals the bundle into a v2 vault envelope (never the plaintext) and getCredential
// opens it back to the exact bundle. Uses a REAL vault key (real AES-256-GCM) with a
// mocked prisma so the round-trip is genuine, not stubbed.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    connectorCredential: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma }));

// A real 32-byte base64 key so the vault performs genuine AES-256-GCM (legacy
// single-key mode → ring { v1: <key> }). Set before importing the module under test.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.SSO_VAULT_KEY = TEST_KEY;
delete process.env.SSO_VAULT_KEYS;
delete process.env.SSO_VAULT_ACTIVE_KID;

import { getCredential, setCredential } from "./credentials";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000bb";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setCredential", () => {
  it("seals the bundle into a v2 vault envelope (NOT plaintext) and upserts on the unique key", async () => {
    prisma.connectorCredential.upsert.mockResolvedValue({});

    await setCredential(ORG, "google", USER, { refreshToken: "TESTTOK" });

    expect(prisma.connectorCredential.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.connectorCredential.upsert.mock.calls[0][0];

    // Upsert targets the (orgId, provider, userId) unique key.
    expect(arg.where).toEqual({
      orgId_provider_userId: { orgId: ORG, provider: "google", userId: USER },
    });

    // The stored secret is a sealed v2 envelope, NOT the plaintext token.
    const sealed = arg.create.secretEnc as string;
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(sealed).not.toContain("TESTTOK");
    expect(sealed).not.toContain("refreshToken");
    // Both create + update carry the same sealed value (upsert refresh-in-place).
    expect(arg.update.secretEnc).toBe(sealed);
  });

  it("persists meta unsealed (non-secret) and defaults it to {}", async () => {
    prisma.connectorCredential.upsert.mockResolvedValue({});

    await setCredential(ORG, "google", USER, { refreshToken: "x" }, { scopes: ["a"] });
    expect(prisma.connectorCredential.upsert.mock.calls[0][0].create.meta).toEqual({
      scopes: ["a"],
    });

    await setCredential(ORG, "google", USER, { refreshToken: "x" });
    expect(prisma.connectorCredential.upsert.mock.calls[1][0].create.meta).toEqual({});
  });
});

describe("getCredential", () => {
  it("returns null when no row exists", async () => {
    prisma.connectorCredential.findUnique.mockResolvedValue(null);
    const result = await getCredential(ORG, "google", USER);
    expect(result).toBeNull();
  });

  it("seal → store → open round-trips the exact bundle", async () => {
    // Capture what setCredential seals, then feed it back to getCredential.
    let sealed = "";
    prisma.connectorCredential.upsert.mockImplementation((arg) => {
      sealed = arg.create.secretEnc;
      return Promise.resolve({});
    });
    const bundle = { refreshToken: "TESTTOK", accessToken: "AT-123" };
    await setCredential(ORG, "google", USER, bundle);

    prisma.connectorCredential.findUnique.mockResolvedValue({ secretEnc: sealed });
    const opened = await getCredential(ORG, "google", USER);

    expect(opened).toEqual(bundle);
  });

  it("scopes the read to the exact (org, provider, user) key", async () => {
    prisma.connectorCredential.findUnique.mockResolvedValue(null);
    await getCredential(ORG, "google", USER);
    expect(prisma.connectorCredential.findUnique).toHaveBeenCalledWith({
      where: { orgId_provider_userId: { orgId: ORG, provider: "google", userId: USER } },
      select: { secretEnc: true },
    });
  });
});
