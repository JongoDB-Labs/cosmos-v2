// @vitest-environment node
//
// API-key auth foundation: minting + bearer verification. Mock ONLY the I/O
// boundaries (prisma + loadEffectivePermissions); leave the hashing, token
// format, and scope-intersection logic running for real so the tests lock the
// security-relevant behavior:
//   - the stored hash is NEVER the plaintext secret,
//   - a verified key acts AS the minting user (userId === createdById),
//   - effective permissions are the user's perms INTERSECTED with the scope mask
//     (a read-scope key can't write even if the user is an OWNER with all bits).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";

// --- I/O boundary mocks ------------------------------------------------------
const { prisma, loadEffectivePermissions } = vi.hoisted(() => ({
  prisma: {
    apiKey: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  loadEffectivePermissions: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));

import { mintApiKey, scopeMask, verifyApiKey } from "../api-key";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "44444444-4444-4444-4444-444444444444";
const KEY_ID = "55555555-5555-5555-5555-555555555555";

// All-bits effective permissions, as an OWNER would carry.
const ALL_BITS = Object.values(Permission).reduce((acc, b) => acc | b, 0n);

function effFor(permissions: bigint) {
  return {
    orgRole: OrgRole.OWNER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

function bearer(token: string): Request {
  return new Request("http://localhost/api/v1/orgs/o/items", {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.apiKey.update.mockResolvedValue({});
});

describe("mintApiKey", () => {
  it("returns a cosmos_<prefix>_<secret> token and stores a hash (not the secret)", async () => {
    let captured: Record<string, unknown> | undefined;
    prisma.apiKey.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      captured = args.data;
      return {
        id: KEY_ID,
        name: args.data.name,
        prefix: args.data.prefix,
        scopes: args.data.scopes,
        expiresAt: args.data.expiresAt,
        createdAt: new Date(),
      };
    });

    const { token } = await mintApiKey({
      orgId: ORG_ID,
      name: "ci",
      scopes: ["read"],
      createdById: USER_ID,
    });

    expect(token).toMatch(/^cosmos_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);

    // Derive the plaintext secret from the captured prefix rather than string-
    // splitting the token: base64url prefixes may themselves contain "_", so a
    // naive lastIndexOf("_") would mis-slice. token === `cosmos_<prefix>_<secret>`.
    expect(captured).toBeDefined();
    const secret = token.slice(`cosmos_${captured!.prefix as string}_`.length);
    expect(captured!.prefix).toBeTruthy();
    expect(typeof captured!.prefix).toBe("string");
    expect((captured!.prefix as string).length).toBeGreaterThan(0);
    // The stored hash must NOT be the secret, and must equal its sha256.
    expect(captured!.keyHash).not.toBe(secret);
    expect(captured!.keyHash).toBe(sha256(secret));
    expect(captured!.createdById).toBe(USER_ID);
    expect(captured!.expiresAt).toBeNull();
    // The prefix MUST be hex (no `_`/`-`) so the token splits unambiguously — a
    // base64url prefix/secret made the parse ambiguous (see the regression test).
    expect(captured!.prefix).toMatch(/^[0-9a-f]+$/);
  });
});

describe("scopeMask", () => {
  it("read scope does NOT include ITEM_CREATE", () => {
    expect(scopeMask(["read"]) & Permission.ITEM_CREATE).toBe(0n);
    // sanity: it DOES include a read bit.
    expect(scopeMask(["read"]) & Permission.ITEM_READ).toBe(Permission.ITEM_READ);
  });

  it("items:write scope DOES include ITEM_CREATE", () => {
    expect(scopeMask(["items:write"]) & Permission.ITEM_CREATE).toBe(Permission.ITEM_CREATE);
  });

  it("unknown scopes contribute nothing", () => {
    expect(scopeMask(["bogus"])).toBe(0n);
  });
});

describe("verifyApiKey", () => {
  // Build a token + matching DB row for a given prefix/secret/scopes.
  function setupKey(opts: {
    prefix?: string;
    secret?: string;
    scopes?: string[];
    expiresAt?: Date | null;
    createdById?: string | null;
  }) {
    const prefix = opts.prefix ?? "abcdef";
    const secret = opts.secret ?? "s3cr3t-token-value";
    const token = `cosmos_${prefix}_${secret}`;
    prisma.apiKey.findUnique.mockResolvedValue({
      id: KEY_ID,
      keyHash: sha256(secret),
      scopes: opts.scopes ?? ["read"],
      expiresAt: opts.expiresAt ?? null,
      createdById: "createdById" in opts ? opts.createdById : USER_ID,
    });
    return { token, prefix, secret };
  }

  it("valid token → AuthContext acting as createdById with masked permissions", async () => {
    const scopes = ["items:write"];
    const { token } = setupKey({ scopes });
    loadEffectivePermissions.mockResolvedValue(effFor(ALL_BITS));

    const ctx = await verifyApiKey(bearer(token), ORG_ID);

    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe(USER_ID);
    expect(ctx!.orgId).toBe(ORG_ID);
    expect(ctx!.orgRole).toBe(OrgRole.OWNER);
    expect(ctx!.permissions).toBe(ALL_BITS & scopeMask(scopes));
    expect(ctx!.basePermissions).toBe(ALL_BITS & scopeMask(scopes));
    // lastUsed is bumped (best-effort).
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: KEY_ID },
      data: { lastUsed: expect.any(Date) },
    });
  });

  it("secret containing _ and - verifies (split at the hex prefix, not the last _)", async () => {
    // Regression: a greedy `(...)_(...)` split mis-read tokens whose base64url
    // secret held an underscore (~3 of 4 real keys), extracting a wrong prefix +
    // wrong secret → hash mismatch → 401. A hex prefix makes the split exact.
    const secret = "aa_bb-cc_dd-EE_99"; // base64url-style: contains _ and -
    const { token } = setupKey({ prefix: "0a1b2c3d", secret, scopes: ["read"] });
    loadEffectivePermissions.mockResolvedValue(effFor(ALL_BITS));

    const ctx = await verifyApiKey(bearer(token), ORG_ID);

    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe(USER_ID);
    // The prefix passed to the DB lookup must be exactly the hex prefix.
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId_prefix: { orgId: ORG_ID, prefix: "0a1b2c3d" } } }),
    );
  });

  it("masking proof: OWNER all-bits + read scope → no ITEM_CREATE bit", async () => {
    const { token } = setupKey({ scopes: ["read"] });
    loadEffectivePermissions.mockResolvedValue(effFor(ALL_BITS));

    const ctx = await verifyApiKey(bearer(token), ORG_ID);

    expect(ctx).not.toBeNull();
    expect(ctx!.permissions & Permission.ITEM_CREATE).toBe(0n);
    expect(ctx!.permissions & Permission.ITEM_READ).toBe(Permission.ITEM_READ);
  });

  it("wrong secret (hash mismatch) → null", async () => {
    setupKey({ secret: "the-real-secret" });
    loadEffectivePermissions.mockResolvedValue(effFor(ALL_BITS));

    const ctx = await verifyApiKey(bearer("cosmos_abcdef_a-different-secret"), ORG_ID);

    expect(ctx).toBeNull();
    expect(loadEffectivePermissions).not.toHaveBeenCalled();
  });

  it("expired key → null", async () => {
    const { token } = setupKey({ expiresAt: new Date(Date.now() - 1000) });
    loadEffectivePermissions.mockResolvedValue(effFor(ALL_BITS));

    const ctx = await verifyApiKey(bearer(token), ORG_ID);

    expect(ctx).toBeNull();
    expect(loadEffectivePermissions).not.toHaveBeenCalled();
  });

  it("unknown prefix (findUnique → null) → null", async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null);

    const ctx = await verifyApiKey(bearer("cosmos_nope_whatever"), ORG_ID);

    expect(ctx).toBeNull();
    expect(loadEffectivePermissions).not.toHaveBeenCalled();
  });

  it("null createdById (minting user removed) → null", async () => {
    const { token } = setupKey({ createdById: null });
    loadEffectivePermissions.mockResolvedValue(effFor(ALL_BITS));

    const ctx = await verifyApiKey(bearer(token), ORG_ID);

    expect(ctx).toBeNull();
    expect(loadEffectivePermissions).not.toHaveBeenCalled();
  });

  it("user no longer a member (loadEffectivePermissions → null) → null", async () => {
    const { token } = setupKey({});
    loadEffectivePermissions.mockResolvedValue(null);

    const ctx = await verifyApiKey(bearer(token), ORG_ID);

    expect(ctx).toBeNull();
  });

  it("malformed / non-bearer header → null without a DB call", async () => {
    const req = new Request("http://localhost/x", {
      headers: { authorization: "Basic abc" },
    });

    const ctx = await verifyApiKey(req, ORG_ID);

    expect(ctx).toBeNull();
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });
});
