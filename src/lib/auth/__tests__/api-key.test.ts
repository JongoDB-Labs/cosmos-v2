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
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { EffectivePermissions } from "@/lib/rbac/effective-permissions";

// --- I/O boundary mocks ------------------------------------------------------
const { prisma, loadEffectivePermissions } = vi.hoisted(() => ({
  prisma: {
    apiKey: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    // The org's settings row: the IP allowlist, off (ip-allowlist.db.test.ts
    // covers it on), and the "Members can create their own API keys" switch,
    // which apiKeyAuthContext reads for itself unless a caller passes it in.
    orgSecuritySettings: { findUnique: vi.fn(async (): Promise<{ memberApiKeysEnabled: boolean } | null> => null) },
    ipAllowlist: { findMany: vi.fn(async () => []) },
    // The org's IdP connection: whether it requires single sign-on (no row: it doesn't).
    idpConnection: { findUnique: vi.fn() },
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

// Typed, so a field added to the real result can't go missing from this stand-in.
function effFor(permissions: bigint): EffectivePermissions {
  return {
    orgRole: OrgRole.OWNER,
    permissions,
    basePermissions: permissions,
    unrestrictedBasePermissions: permissions,
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
  prisma.orgSecuritySettings.findUnique.mockResolvedValue(null); // no row: the switch's default, on
  prisma.idpConnection.findUnique.mockResolvedValue(null);
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
    projectIds?: string[];
    expiresAt?: Date | null;
    createdById?: string | null;
    createdAt?: Date;
    idpConnId?: string | null;
  }) {
    const prefix = opts.prefix ?? "abcdef";
    const secret = opts.secret ?? "s3cr3t-token-value";
    const token = `cosmos_${prefix}_${secret}`;
    prisma.apiKey.findUnique.mockResolvedValue({
      id: KEY_ID,
      keyHash: sha256(secret),
      scopes: opts.scopes ?? ["read"],
      // Shaped like the verifier's SELECT. Empty = org-wide, which is what
      // every key minted before project scoping existed carries.
      projectIds: opts.projectIds ?? [],
      expiresAt: opts.expiresAt ?? null,
      createdById: "createdById" in opts ? opts.createdById : USER_ID,
      createdAt: opts.createdAt ?? new Date(),
      idpConnId: opts.idpConnId ?? null,
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
    // The ceiling on current access is narrowed by the scopes too.
    expect(ctx!.unrestrictedBasePermissions).toBe(ALL_BITS & scopeMask(scopes));
    // The creator's own bits ride along, unmasked, for keyMay (and only keyMay).
    expect(ctx!.ownerPermissions).toBe(ALL_BITS);
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

  it("a project-scoped key carries its ceiling onto the AuthContext", async () => {
    const { token } = setupKey({ projectIds: ["p1", "p2"] });
    loadEffectivePermissions.mockResolvedValue(effFor(ALL_BITS));
    const ctx = await verifyApiKey(bearer(token), ORG_ID);
    expect(ctx?.projectScope).toEqual(["p1", "p2"]);
  });

  it("an org-wide key carries NO ceiling — undefined, never []", async () => {
    // `[]` as a ceiling denies everything, so mapping empty to undefined is
    // what keeps every key minted before project scoping existed working.
    const { token } = setupKey({ projectIds: [] });
    loadEffectivePermissions.mockResolvedValue(effFor(ALL_BITS));
    const ctx = await verifyApiKey(bearer(token), ORG_ID);
    expect(ctx?.projectScope).toBeUndefined();
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

  it("a creator who may no longer hold keys → null: a guest holds neither API_KEY bit", async () => {
    const { token } = setupKey({});
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.GUEST));
    expect(await verifyApiKey(bearer(token), ORG_ID)).toBeNull();
    // Positive control: the same key for a member works.
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.MEMBER));
    expect(await verifyApiKey(bearer(token), ORG_ID)).not.toBeNull();
  });

  it("a key older than 366 days → null for a creator who can't manage keys; an admin's verifies", async () => {
    const { token } = setupKey({ createdAt: new Date(Date.now() - 400 * 86_400_000), expiresAt: null });
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.MEMBER));
    expect(await verifyApiKey(bearer(token), ORG_ID)).toBeNull();
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.ADMIN));
    expect(await verifyApiKey(bearer(token), ORG_ID)).not.toBeNull();
  });

  it("with member keys turned off, a member's key → null and an admin's still verifies", async () => {
    prisma.orgSecuritySettings.findUnique.mockResolvedValue({ memberApiKeysEnabled: false });
    const { token } = setupKey({});
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.MEMBER));
    expect(await verifyApiKey(bearer(token), ORG_ID)).toBeNull();
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.ADMIN));
    expect(await verifyApiKey(bearer(token), ORG_ID)).not.toBeNull();
    expect(prisma.orgSecuritySettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: ORG_ID } }),
    );
  });

  it("where the org requires single sign-on, a member's key verifies only if made through its IdP; an admin's always does", async () => {
    const CONN = "66666666-6666-6666-6666-666666666666";
    prisma.idpConnection.findUnique.mockResolvedValue({ id: CONN, enabled: true, enforced: true, org: { tenantClass: "GOV" } });
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.MEMBER));
    setupKey({ idpConnId: null });
    expect(await verifyApiKey(bearer("cosmos_abcdef_s3cr3t-token-value"), ORG_ID)).toBeNull();
    setupKey({ idpConnId: "77777777-7777-7777-7777-777777777777" });
    expect(await verifyApiKey(bearer("cosmos_abcdef_s3cr3t-token-value"), ORG_ID)).toBeNull();
    const { token } = setupKey({ idpConnId: CONN });
    expect(await verifyApiKey(bearer(token), ORG_ID)).not.toBeNull();
    // An admin's key with no IdP recorded still verifies, as every key did.
    setupKey({ idpConnId: null });
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.ADMIN));
    expect(await verifyApiKey(bearer(token), ORG_ID)).not.toBeNull();
    // Control: not GOV, so nothing is required, and the member's key verifies.
    prisma.idpConnection.findUnique.mockResolvedValue({ id: CONN, enabled: true, enforced: true, org: { tenantClass: "COMMERCIAL" } });
    loadEffectivePermissions.mockResolvedValue(effFor(RolePermissions.MEMBER));
    expect(await verifyApiKey(bearer(token), ORG_ID)).not.toBeNull();
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
