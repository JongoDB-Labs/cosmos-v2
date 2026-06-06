// @vitest-environment node
//
// Connector credential accessor — locks the seal-at-rest contract: the write paths
// seal the bundle into a v2 vault envelope (never the plaintext) and the read paths
// open it back to the exact bundle. Uses a REAL vault key (real AES-256-GCM) with a
// mocked prisma so the round-trip is genuine, not stubbed.
//
// The store enforces uniqueness via PARTIAL unique indexes (one per-user row per
// (org,provider,user); one org-level NULL-userId row per (org,provider)), which
// Prisma can't model — so the write paths findFirst-then-update-or-create rather
// than upsert on a generated compound key. These tests assert that contract AND
// that an org-level row and a per-user row for the same (org,provider) don't collide.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    connectorCredential: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
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

import {
  getCredential,
  getUserCredential,
  getOrgCredential,
  setCredential,
  setOrgCredential,
  deleteOrgCredential,
} from "./credentials";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000bb";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setCredential (per-user)", () => {
  it("seals the bundle into a v2 vault envelope (NOT plaintext) and creates when none exists", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    prisma.connectorCredential.create.mockResolvedValue({});

    await setCredential(ORG, "google", USER, { refreshToken: "TESTTOK" });

    // No existing row → create (not update).
    expect(prisma.connectorCredential.create).toHaveBeenCalledTimes(1);
    expect(prisma.connectorCredential.update).not.toHaveBeenCalled();
    const arg = prisma.connectorCredential.create.mock.calls[0][0];

    // The create targets the (orgId, provider, userId) identity.
    expect(arg.data.orgId).toBe(ORG);
    expect(arg.data.provider).toBe("google");
    expect(arg.data.userId).toBe(USER);

    // The stored secret is a sealed v2 envelope, NOT the plaintext token.
    const sealed = arg.data.secretEnc as string;
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(sealed).not.toContain("TESTTOK");
    expect(sealed).not.toContain("refreshToken");
  });

  it("updates the existing row in place (refresh-on-reconnect) when one is found", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue({ id: "row-1" });
    prisma.connectorCredential.update.mockResolvedValue({});

    await setCredential(ORG, "google", USER, { refreshToken: "NEW" });

    expect(prisma.connectorCredential.create).not.toHaveBeenCalled();
    expect(prisma.connectorCredential.update).toHaveBeenCalledTimes(1);
    const arg = prisma.connectorCredential.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "row-1" });
    expect((arg.data.secretEnc as string).startsWith("v2.")).toBe(true);
  });

  it("persists meta unsealed (non-secret) and defaults it to {}", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    prisma.connectorCredential.create.mockResolvedValue({});

    await setCredential(ORG, "google", USER, { refreshToken: "x" }, { scopes: ["a"] });
    expect(prisma.connectorCredential.create.mock.calls[0][0].data.meta).toEqual({
      scopes: ["a"],
    });

    await setCredential(ORG, "google", USER, { refreshToken: "x" });
    expect(prisma.connectorCredential.create.mock.calls[1][0].data.meta).toEqual({});
  });
});

describe("getCredential (per-user)", () => {
  it("returns null when no row exists", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    const result = await getCredential(ORG, "google", USER);
    expect(result).toBeNull();
  });

  it("seal → store → open round-trips the exact bundle", async () => {
    // Capture what setCredential seals, then feed it back to getCredential.
    let sealed = "";
    prisma.connectorCredential.findFirst.mockResolvedValueOnce(null); // setCredential lookup
    prisma.connectorCredential.create.mockImplementation((arg) => {
      sealed = arg.data.secretEnc;
      return Promise.resolve({});
    });
    const bundle = { refreshToken: "TESTTOK", accessToken: "AT-123" };
    await setCredential(ORG, "google", USER, bundle);

    prisma.connectorCredential.findFirst.mockResolvedValueOnce({ secretEnc: sealed }); // getCredential lookup
    const opened = await getCredential(ORG, "google", USER);

    expect(opened).toEqual(bundle);
  });

  it("scopes the read to the exact (org, provider, user) key", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    await getCredential(ORG, "google", USER);
    expect(prisma.connectorCredential.findFirst).toHaveBeenCalledWith({
      where: { orgId: ORG, provider: "google", userId: USER },
      select: { secretEnc: true },
    });
  });
});

describe("getUserCredential (user-scoped, org-independent)", () => {
  it("looks up by (provider, userId) only — NOT narrowed by org — newest first", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    await getUserCredential("google", USER);
    expect(prisma.connectorCredential.findFirst).toHaveBeenCalledWith({
      where: { provider: "google", userId: USER },
      orderBy: { updatedAt: "desc" },
      select: { secretEnc: true },
    });
  });

  it("returns null when the user has no credential for the provider", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    expect(await getUserCredential("google", USER)).toBeNull();
  });

  it("opens the user's sealed bundle regardless of which org row stored it", async () => {
    // The row was sealed under the user's primary org; the user-scoped lookup opens it
    // for use in ANY org (a personal Google grant is valid across all the user's orgs).
    let sealed = "";
    prisma.connectorCredential.findFirst.mockResolvedValueOnce(null); // setCredential lookup
    prisma.connectorCredential.create.mockImplementation((arg) => {
      sealed = arg.data.secretEnc;
      return Promise.resolve({});
    });
    await setCredential(ORG, "google", USER, { refreshToken: "USERTOK" });

    prisma.connectorCredential.findFirst.mockResolvedValueOnce({ secretEnc: sealed });
    expect(await getUserCredential("google", USER)).toEqual({ refreshToken: "USERTOK" });
  });
});

describe("setOrgCredential / getOrgCredential (org-level, userId NULL)", () => {
  it("creates a NULL-userId row sealing the bundle (NOT plaintext) when none exists", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    prisma.connectorCredential.create.mockResolvedValue({});

    await setOrgCredential(ORG, "github", { token: "GHTESTTOK" });

    expect(prisma.connectorCredential.create).toHaveBeenCalledTimes(1);
    const arg = prisma.connectorCredential.create.mock.calls[0][0];
    expect(arg.data.orgId).toBe(ORG);
    expect(arg.data.provider).toBe("github");
    expect(arg.data.userId).toBeNull(); // org-level
    const sealed = arg.data.secretEnc as string;
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(sealed).not.toContain("GHTESTTOK");
    expect(sealed).not.toContain("token");
  });

  it("the org-level lookup filters on userId: null (strict org scope)", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    await getOrgCredential(ORG, "github");
    expect(prisma.connectorCredential.findFirst).toHaveBeenCalledWith({
      where: { orgId: ORG, provider: "github", userId: null },
      select: { secretEnc: true },
    });
  });

  it("seal → store → open round-trips the exact org-level bundle", async () => {
    let sealed = "";
    prisma.connectorCredential.findFirst.mockResolvedValueOnce(null); // setOrgCredential lookup
    prisma.connectorCredential.create.mockImplementation((arg) => {
      sealed = arg.data.secretEnc;
      return Promise.resolve({});
    });
    const bundle = { token: "GHTESTTOK" };
    await setOrgCredential(ORG, "github", bundle, { defaultOwner: "o" });

    prisma.connectorCredential.findFirst.mockResolvedValueOnce({ secretEnc: sealed });
    expect(await getOrgCredential(ORG, "github")).toEqual(bundle);
  });

  it("updates the existing org-level row in place when one is found", async () => {
    prisma.connectorCredential.findFirst.mockResolvedValue({ id: "org-row" });
    prisma.connectorCredential.update.mockResolvedValue({});
    await setOrgCredential(ORG, "github", { token: "ROTATED" });
    expect(prisma.connectorCredential.create).not.toHaveBeenCalled();
    expect(prisma.connectorCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "org-row" } }),
    );
  });

  it("an org-level row and a per-user row for the SAME (org,provider) DON'T collide", async () => {
    // Both writes go to fresh rows: setOrgCredential's findFirst (userId:null) and
    // setCredential's findFirst (userId:USER) each see no existing match because the
    // partial indexes treat the two row shapes as disjoint. Two creates, no update,
    // no shared identity → coexist.
    prisma.connectorCredential.findFirst.mockResolvedValue(null);
    prisma.connectorCredential.create.mockResolvedValue({});

    await setOrgCredential(ORG, "github", { token: "ORGTOK" });
    await setCredential(ORG, "github", USER, { token: "USERTOK" });

    expect(prisma.connectorCredential.create).toHaveBeenCalledTimes(2);
    expect(prisma.connectorCredential.update).not.toHaveBeenCalled();

    const orgCreate = prisma.connectorCredential.create.mock.calls[0][0].data;
    const userCreate = prisma.connectorCredential.create.mock.calls[1][0].data;
    expect(orgCreate.userId).toBeNull();
    expect(userCreate.userId).toBe(USER);
    // Distinct lookups proved the two shapes are addressed disjointly.
    expect(prisma.connectorCredential.findFirst).toHaveBeenNthCalledWith(1, {
      where: { orgId: ORG, provider: "github", userId: null },
      select: { id: true },
    });
    expect(prisma.connectorCredential.findFirst).toHaveBeenNthCalledWith(2, {
      where: { orgId: ORG, provider: "github", userId: USER },
      select: { id: true },
    });
  });
});

describe("deleteOrgCredential", () => {
  it("deletes only the NULL-userId row for (org, provider)", async () => {
    prisma.connectorCredential.deleteMany.mockResolvedValue({ count: 1 });
    await deleteOrgCredential(ORG, "github");
    expect(prisma.connectorCredential.deleteMany).toHaveBeenCalledWith({
      where: { orgId: ORG, provider: "github", userId: null },
    });
  });
});
