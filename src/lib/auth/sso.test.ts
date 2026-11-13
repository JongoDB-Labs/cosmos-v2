// @vitest-environment node
//
// completeSsoLogin — the security core of the in-app OIDC RP. These tests lock
// the three load-bearing invariants:
//   (c) NEVER hijack a user by email — match on (idpConnId, subject) only.
//   (d) NEVER mint OWNER from a claim — claim-derived roles cap at ADMIN.
//   (e) GOV + requiredAcr unmet → reject, no session.
//
// I/O boundaries (prisma, logAudit, autoJoinGeneral) are mocked; the entire
// identity-match / role-cap / AAL-floor decision logic runs unmocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrgRole } from "@prisma/client";
import type { IdpConnection } from "@prisma/client";

const { prisma, logAudit, autoJoinGeneral } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    orgSecuritySettings: { findUnique: vi.fn() },
    federatedIdentity: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    orgMember: { upsert: vi.fn(), findUnique: vi.fn() },
    invitation: { findMany: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
    session: { create: vi.fn() },
    sessionRecord: { create: vi.fn() },
  },
  logAudit: vi.fn(),
  autoJoinGeneral: vi.fn(),
}));

// Both names resolve to the same mock: `prismaUnfiltered` is the same client
// without the removed-member filter, and these tests assert sso.ts's own calls.
vi.mock("@/lib/db/client", () => ({ prisma, prismaUnfiltered: prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/chat/seed-general", () => ({ autoJoinGeneral }));

import { completeSsoLogin, type SsoClaims } from "./sso";

const ORG_ID = "00000000-0000-0000-0000-0000000000aa";
const CONN_ID = "00000000-0000-0000-0000-0000000000bb";

function conn(overrides: Partial<IdpConnection> = {}): IdpConnection {
  return {
    id: CONN_ID,
    orgId: ORG_ID,
    protocol: "OIDC",
    issuerUrl: "https://idp.example.com",
    clientId: "client",
    clientSecretEnc: "v1.x.y.z",
    scopes: ["openid", "email", "profile"],
    attributeMapping: {},
    roleMapping: {},
    jitProvisioning: true,
    defaultRole: OrgRole.MEMBER,
    requiredAcr: null,
    enabled: true,
    enforced: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as IdpConnection;
}

function claims(overrides: Partial<SsoClaims> = {}): SsoClaims {
  return {
    subject: "idp-sub-123",
    email: "alice@agency.gov",
    emailVerified: true,
    groups: [],
    acr: null,
    amr: [],
    ...overrides,
  };
}

function org(tenantClass: "GOV" | "COMMERCIAL" = "COMMERCIAL") {
  return { id: ORG_ID, slug: "agency", tenantClass };
}

beforeEach(() => {
  vi.clearAllMocks();
  // sensible defaults; individual tests override
  prisma.organization.findUnique.mockResolvedValue(org());
  // The org lists the claimed address's domain, so its IdP is trusted for it.
  prisma.orgSecuritySettings.findUnique.mockResolvedValue({ allowedDomains: ["agency.gov"] });
  prisma.federatedIdentity.findUnique.mockResolvedValue(null);
  prisma.federatedIdentity.findFirst.mockResolvedValue(null); // default: candidate not already federated
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "new-user-id", ...args.data }),
  );
  prisma.user.update.mockImplementation(
    (args: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ id: args.where.id, ...args.data }),
  );
  prisma.federatedIdentity.create.mockImplementation(
    (args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "fed-id", ...args.data }),
  );
  prisma.orgMember.upsert.mockImplementation(
    (args: { create: Record<string, unknown> }) =>
      Promise.resolve({ id: "member-id", ...args.create }),
  );
  prisma.orgMember.findUnique.mockResolvedValue(null);
  prisma.invitation.findFirst.mockResolvedValue(null); // no pending invitation for the address
  prisma.invitation.findMany.mockResolvedValue([]);
  prisma.session.create.mockImplementation(
    (args: { data: Record<string, unknown> }) => Promise.resolve(args.data),
  );
  prisma.sessionRecord.create.mockResolvedValue({});
});

describe("completeSsoLogin", () => {
  it("(a) existing FederatedIdentity → links to that user, creates no new user", async () => {
    prisma.federatedIdentity.findUnique.mockResolvedValue({
      id: "fed-existing",
      userId: "existing-user",
      idpConnId: CONN_ID,
      subject: "idp-sub-123",
    });

    const res = await completeSsoLogin("agency", conn(), claims(), {});

    expect(res.ok).toBe(true);
    expect(res.ok && res.userId).toBe("existing-user");
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.federatedIdentity.create).not.toHaveBeenCalled();
    expect(prisma.session.create).toHaveBeenCalledOnce();
  });

  it("(b) first login JITs User + FederatedIdentity + OrgMember", async () => {
    const res = await completeSsoLogin("agency", conn(), claims({ issuer: "https://idp.example.com" }), {});

    expect(res.ok).toBe(true);
    // The binding is written in the same create as the account (atomic), and the
    // account is marked as made by an IdP.
    expect(prisma.user.create).toHaveBeenCalledOnce();
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ssoProvisioned: true,
          federatedIdentities: {
            create: { idpConnId: CONN_ID, subject: "idp-sub-123", issuer: "https://idp.example.com" },
          },
        }),
      }),
    );
    expect(prisma.orgMember.upsert).toHaveBeenCalledOnce();
  });

  it("(b2) an org that lists no domains is trusted for no address: the new account gets a placeholder", async () => {
    for (const settings of [null, { allowedDomains: [] }, { allowedDomains: ["other.example"] }]) {
      prisma.user.create.mockClear();
      prisma.orgSecuritySettings.findUnique.mockResolvedValue(settings);
      const res = await completeSsoLogin("agency", conn(), claims(), {});
      expect(res.ok).toBe(true);
      const data = prisma.user.create.mock.calls[0][0].data;
      expect(data.email).toMatch(/^sso-[0-9a-f]+@sso\.local$/);
      expect(data.email).not.toContain("alice");
    }
  });

  it("(c) TAKEOVER GUARD: a NEW subject sharing an email with existing users does NOT hijack — never email-only", async () => {
    // No federated identity for this (conn, subject) yet…
    prisma.federatedIdentity.findUnique.mockResolvedValue(null);
    // …but TWO local users already share the claimed email (email is NOT unique).
    prisma.user.findMany.mockResolvedValue([
      { id: "victim-1", email: "alice@agency.gov" },
      { id: "victim-2", email: "alice@agency.gov" },
    ]);

    const res = await completeSsoLogin("agency", conn(), claims(), {});

    // Must NOT link to either ambiguous email-match user, and must not mint a
    // third account under the same address either.
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("account_exists");
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.federatedIdentity.create).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it("(c2) email-LINK is allowed only for exactly ONE verified-email match who is already a member", async () => {
    prisma.federatedIdentity.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([
      { id: "the-only-match", email: "alice@agency.gov" },
    ]);
    prisma.orgMember.findUnique.mockResolvedValue({ id: "member-row", role: OrgRole.MEMBER });

    const res = await completeSsoLogin("agency", conn(), claims(), {});

    expect(res.ok).toBe(true);
    expect(res.ok && res.userId).toBe("the-only-match");
    expect(prisma.orgMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId_userId: { orgId: ORG_ID, userId: "the-only-match" } } }),
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.federatedIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "the-only-match" }),
      }),
    );
  });

  it("(c2a) a verified-email match the org has INVITED (not yet a member) links", async () => {
    prisma.federatedIdentity.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([{ id: "invitee", email: "alice@agency.gov" }]);
    prisma.invitation.findFirst.mockResolvedValue({ id: "inv-1" });

    const res = await completeSsoLogin("agency", conn(), claims(), {});

    expect(res.ok && res.userId).toBe("invitee");
    // Only this org's own, unexpired invitation for the address counts.
    const where = prisma.invitation.findFirst.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG_ID);
    expect(where.email).toEqual({ equals: "alice@agency.gov", mode: "insensitive" });
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("(c2b) a verified-email match who is NOT a member of the org is never linked", async () => {
    prisma.federatedIdentity.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([{ id: "outsider", email: "alice@agency.gov" }]);
    prisma.orgMember.findUnique.mockResolvedValue(null);

    const res = await completeSsoLogin("agency", conn(), claims(), {});

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("account_exists");
    expect(prisma.federatedIdentity.create).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("(c4) C1 GUARD: never email-link a user ALREADY federated to this conn (sub rotation = takeover)", async () => {
    prisma.federatedIdentity.findUnique.mockResolvedValue(null); // brand-new subject
    prisma.user.findMany.mockResolvedValue([
      { id: "already-fed-user", email: "alice@agency.gov" }, // exactly one verified-email match
    ]);
    prisma.orgMember.findUnique.mockResolvedValue({ id: "member-row", role: OrgRole.MEMBER });
    // …but that user is ALREADY federated to THIS conn under a DIFFERENT subject:
    prisma.federatedIdentity.findFirst.mockResolvedValue({ id: "existing-fed" });

    const res = await completeSsoLogin(
      "agency",
      conn(),
      claims({ subject: "idp-sub-EVIL" }),
      {},
    );

    // Must NOT link to the already-federated user, and must not mint a duplicate.
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("account_exists");
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.federatedIdentity.create).not.toHaveBeenCalled();
  });

  it("(c3) unverified email never links, and never duplicates the holder", async () => {
    prisma.federatedIdentity.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([
      { id: "would-be-match", email: "alice@agency.gov" },
    ]);

    const res = await completeSsoLogin(
      "agency",
      conn(),
      claims({ emailVerified: false }),
      {},
    );

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("email_untrusted");
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.federatedIdentity.create).not.toHaveBeenCalled();
  });

  it("(d) ROLE CAP: a group claiming OWNER is capped to ADMIN; a group→ADMIN maps through", async () => {
    const c = conn({
      roleMapping: { admins: "ADMIN", superusers: "OWNER" },
    });
    // group maps to OWNER in roleMapping but MUST be capped to ADMIN
    const res = await completeSsoLogin(
      "agency",
      c,
      claims({ groups: ["superusers"] }),
      {},
    );

    expect(res.ok).toBe(true);
    expect(prisma.orgMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ role: OrgRole.ADMIN }),
        update: expect.objectContaining({ role: OrgRole.ADMIN }),
      }),
    );
  });

  it("(d2) group→ADMIN maps through to ADMIN", async () => {
    const c = conn({ roleMapping: { admins: "ADMIN" } });
    await completeSsoLogin("agency", c, claims({ groups: ["admins"] }), {});
    expect(prisma.orgMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ role: OrgRole.ADMIN }),
      }),
    );
  });

  it("(d3) no group match falls back to conn.defaultRole (also capped)", async () => {
    const c = conn({ defaultRole: OrgRole.VIEWER, roleMapping: {} });
    await completeSsoLogin("agency", c, claims({ groups: ["nobody"] }), {});
    expect(prisma.orgMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ role: OrgRole.VIEWER }),
      }),
    );
  });

  it("(e) GOV + requiredAcr unmet → rejected, no session, no provisioning", async () => {
    prisma.organization.findUnique.mockResolvedValue(org("GOV"));
    const c = conn({ requiredAcr: "phr" }); // phishing-resistant required

    const res = await completeSsoLogin(
      "agency",
      c,
      claims({ acr: "urn:loa:1", amr: ["pwd"] }), // does NOT satisfy phr
      {},
    );

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("aal_floor_unmet");
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.federatedIdentity.create).not.toHaveBeenCalled();
  });

  it("(e2) GOV + requiredAcr SATISFIED by acr → allowed, mfaSatisfied=true", async () => {
    prisma.organization.findUnique.mockResolvedValue(org("GOV"));
    const c = conn({ requiredAcr: "phr" });

    const res = await completeSsoLogin(
      "agency",
      c,
      claims({ acr: "phr", amr: ["hwk"] }),
      {},
    );

    expect(res.ok).toBe(true);
    expect(prisma.session.create).toHaveBeenCalledOnce();
    const sessionArg = prisma.session.create.mock.calls[0][0].data;
    expect(sessionArg.mfaSatisfied).toBe(true);
  });

  it("(e3) GOV with NO requiredAcr set → AAL floor not enforced (allowed)", async () => {
    prisma.organization.findUnique.mockResolvedValue(org("GOV"));
    const c = conn({ requiredAcr: null });
    const res = await completeSsoLogin("agency", c, claims(), {});
    expect(res.ok).toBe(true);
  });

  it("(e4) COMMERCIAL ignores requiredAcr (no gov floor)", async () => {
    prisma.organization.findUnique.mockResolvedValue(org("COMMERCIAL"));
    const c = conn({ requiredAcr: "phr" });
    const res = await completeSsoLogin(
      "agency",
      c,
      claims({ acr: "urn:loa:1" }),
      {},
    );
    expect(res.ok).toBe(true);
  });

  it("(f) session row carries authMethod / amr / mfaSatisfied + an audit row is written", async () => {
    const res = await completeSsoLogin(
      "agency",
      conn(),
      claims({ amr: ["pwd", "otp"] }),
      {},
    );

    expect(res.ok).toBe(true);
    const sessionArg = prisma.session.create.mock.calls[0][0].data;
    expect(sessionArg.authMethod).toBe("oidc");
    expect(sessionArg.idpConnId).toBe(CONN_ID);
    expect(sessionArg.amr).toEqual(["pwd", "otp"]);
    expect(typeof sessionArg.id).toBe("string");
    expect(sessionArg.id.length).toBeGreaterThanOrEqual(32);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.sso.login",
        orgId: ORG_ID,
        metadata: expect.objectContaining({ idpConnId: CONN_ID }),
      }),
    );
  });

  it("rejects when JIT is disabled and no existing federated identity", async () => {
    const c = conn({ jitProvisioning: false });
    const res = await completeSsoLogin("agency", c, claims(), {});
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("jit_disabled");
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it("rejects when the org slug does not resolve", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    const res = await completeSsoLogin("ghost", conn(), claims(), {});
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("org_not_found");
  });

  it("rejects when the subject claim is missing", async () => {
    const res = await completeSsoLogin(
      "agency",
      conn(),
      claims({ subject: "" }),
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("missing_subject");
  });
});
