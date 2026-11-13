// @vitest-environment node
//
// Asking an org for an account, and an admin deciding, against the REAL e2e DB.
// The DB is the point: the one-pending-per-address rule is a partial unique
// index, and "two admins approve at once" is a conditional update — neither can
// be proven with a mocked Prisma. Only the mail send is stubbed.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { AccountRequestMode, AccountRequestStatus, OrgRole } from "@prisma/client";

const sent: { kind: string; toEmail: string; tempPassword?: string | null }[] = [];
vi.mock("@/lib/integrations/invitation-email", () => ({
  sendInvitationEmail: vi.fn(async (p: { toEmail: string }) => {
    sent.push({ kind: "invitation", toEmail: p.toEmail });
  }),
  sendPasswordInviteEmail: vi.fn(async (p: { toEmail: string; tempPassword?: string | null }) => {
    sent.push({ kind: "password", toEmail: p.toEmail, tempPassword: p.tempPassword });
  }),
}));

import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import {
  submitAccountRequest,
  approveAccountRequest,
  denyAccountRequest,
  NotPending,
  DomainNowDisallowed,
} from "./account-requests";

const stamp = Date.now().toString(36);
const slug = `zzar-${stamp}`;
let orgId = "";
let adminId = "";

const addr = (n: string) => `zz-ar-${n}-${stamp}@allowed.test`;

async function setMode(mode: AccountRequestMode, domains: string[] = ["allowed.test"]) {
  await prisma.orgSecuritySettings.upsert({
    where: { orgId },
    create: { orgId, accountRequestMode: mode, allowedDomains: domains },
    update: { accountRequestMode: mode, allowedDomains: domains },
  });
}

async function approveAs(requestId: string, signInMethod: "oauth" | "email_password") {
  return approveAccountRequest({
    orgId,
    orgName: `AR ${stamp}`,
    orgSlug: slug,
    requestId,
    signInMethod,
    mfaRequired: false,
    actorUserId: adminId,
    actorOrgRole: OrgRole.OWNER,
    actorBasePermissions: RolePermissions.OWNER,
    actorDisplayName: "Admin",
    origin: "http://localhost",
  });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `AR ${stamp}`, slug } })).id;
  const admin = await prisma.user.create({
    data: { email: `zz-ar-admin-${stamp}@allowed.test`, displayName: "Admin" },
  });
  adminId = admin.id;
  await prisma.orgMember.create({
    data: { orgId, userId: adminId, role: "OWNER", permissions: "0" },
  });
});

beforeEach(() => {
  sent.length = 0;
});

describe("submitting a request respects the org's mode", () => {
  it("OFF writes nothing — the secure default, and what every org starts as", async () => {
    await setMode(AccountRequestMode.OFF);
    const r = await submitAccountRequest({ orgSlug: slug, email: addr("off") });
    expect(r.outcome).toBe("mode_off");
    expect(await prisma.accountRequest.count({ where: { orgId, email: addr("off") } })).toBe(0);
  });

  it("a MISSING settings row is OFF, not unrestricted", async () => {
    const bare = `zzarb-${stamp}`;
    const bareOrg = await prisma.organization.create({ data: { name: `bare ${stamp}`, slug: bare } });
    const r = await submitAccountRequest({ orgSlug: bare, email: addr("bare") });
    expect(r.outcome).toBe("mode_off");
    expect(await prisma.accountRequest.count({ where: { orgId: bareOrg.id } })).toBe(0);
  });

  it("ALLOWLIST takes an allowed domain and refuses anything else", async () => {
    await setMode(AccountRequestMode.ALLOWLIST, ["allowed.test"]);
    expect((await submitAccountRequest({ orgSlug: slug, email: addr("ok") })).outcome).toBe("queued");

    const bad = `zz-ar-bad-${stamp}@elsewhere.test`;
    expect((await submitAccountRequest({ orgSlug: slug, email: bad })).outcome).toBe(
      "domain_not_allowed",
    );
    expect(await prisma.accountRequest.count({ where: { orgId, email: bad } })).toBe(0);
  });

  it("OPEN takes any address", async () => {
    await setMode(AccountRequestMode.OPEN);
    const r = await submitAccountRequest({
      orgSlug: slug,
      email: `zz-ar-open-${stamp}@elsewhere.test`,
    });
    expect(r.outcome).toBe("queued");
  });

  it("an unknown org is indistinguishable from any other refusal", async () => {
    expect((await submitAccountRequest({ orgSlug: `nope-${stamp}`, email: addr("x") })).outcome).toBe(
      "no_such_org",
    );
  });

  it("refuses a malformed address itself, not just at the route", async () => {
    await setMode(AccountRequestMode.OPEN);
    // The allowlist reads the domain after the LAST "@", so an address that
    // never passes a validator must not reach it.
    for (const bad of ["nope", "a@allowed.test@elsewhere.test", "@allowed.test"]) {
      expect((await submitAccountRequest({ orgSlug: slug, email: bad })).outcome).toBe(
        "malformed_email",
      );
    }
  });

  it("someone who is already a member is told nothing and queued nowhere", async () => {
    await setMode(AccountRequestMode.OPEN);
    const r = await submitAccountRequest({
      orgSlug: slug,
      email: `zz-ar-admin-${stamp}@allowed.test`,
    });
    expect(r.outcome).toBe("already_member");
  });

  it("a second PENDING request for the same address does not create a second row", async () => {
    await setMode(AccountRequestMode.OPEN);
    const e = addr("dupe");
    expect((await submitAccountRequest({ orgSlug: slug, email: e })).outcome).toBe("queued");
    expect((await submitAccountRequest({ orgSlug: slug, email: e })).outcome).toBe("already_pending");
    // Enforced by the partial unique index, case-insensitively.
    expect((await submitAccountRequest({ orgSlug: slug, email: e.toUpperCase() })).outcome).toBe(
      "already_pending",
    );
    expect(await prisma.accountRequest.count({ where: { orgId, email: e } })).toBe(1);
  });

  it("after a DENIAL the address may ask again — the index is partial on purpose", async () => {
    await setMode(AccountRequestMode.OPEN);
    const e = addr("again");
    const first = await submitAccountRequest({ orgSlug: slug, email: e });
    await denyAccountRequest({ orgId, requestId: first.requestId!, actorUserId: adminId });

    const second = await submitAccountRequest({ orgSlug: slug, email: e });
    expect(second.outcome).toBe("queued");
    expect(await prisma.accountRequest.count({ where: { orgId, email: e } })).toBe(2);
  });
});

describe("deciding a request", () => {
  it("approving mints an invitation and records who decided", async () => {
    await setMode(AccountRequestMode.OPEN);
    const e = addr("approve");
    const { requestId } = await submitAccountRequest({ orgSlug: slug, email: e });

    const result = await approveAs(requestId!, "oauth");
    expect(result.emailSent).toBe(true);
    expect(sent).toEqual([{ kind: "invitation", toEmail: e }]);

    const row = await prisma.accountRequest.findUniqueOrThrow({ where: { id: requestId! } });
    expect(row.status).toBe(AccountRequestStatus.APPROVED);
    expect(row.decidedById).toBe(adminId);
    expect(row.decidedAt).not.toBeNull();
    expect(row.invitationId).not.toBeNull();

    const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: row.invitationId! } });
    expect(inv.email).toBe(e);
    expect(inv.orgId).toBe(orgId);
  });

  it("email_password on a NEW address provisions a temporary password", async () => {
    await setMode(AccountRequestMode.OPEN);
    const e = addr("temp");
    const { requestId } = await submitAccountRequest({ orgSlug: slug, email: e });

    await approveAs(requestId!, "email_password");
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("password");
    expect(sent[0].tempPassword).toBeTruthy();

    const user = await prisma.user.findFirstOrThrow({ where: { email: e } });
    expect(user.passwordHash).not.toBeNull();
    expect(user.mustChangePassword).toBe(true);
  });

  /**
   * The security property this whole path exists to preserve. Sessions are
   * user-global, so setting an admin-chosen credential on an account that
   * already exists would hand this org's admin that person's access
   * EVERYWHERE. Approval must fall back to an ordinary invitation.
   */
  it("email_password on an address that ALREADY has an account never sets a credential", async () => {
    await setMode(AccountRequestMode.OPEN);
    const e = addr("existing");
    const existing = await prisma.user.create({
      data: { email: e, displayName: "Existing", googleId: `zz-ar-gid-${stamp}` },
    });
    const { requestId } = await submitAccountRequest({ orgSlug: slug, email: e });

    await approveAs(requestId!, "email_password");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.passwordHash).toBeNull();
    expect(after.mustChangePassword).toBe(false);

    const row = await prisma.accountRequest.findUniqueOrThrow({ where: { id: requestId! } });
    const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: row.invitationId! } });
    // Coerced, so "signInMethod === email_password ⇒ a temp password exists" holds.
    expect(inv.signInMethod).toBe("oauth");
    expect(await prisma.user.count({ where: { email: e } })).toBe(1);
  });

  it("a second approval of the same request is refused, so two admins can't both mint", async () => {
    await setMode(AccountRequestMode.OPEN);
    const { requestId } = await submitAccountRequest({ orgSlug: slug, email: addr("race") });

    await approveAs(requestId!, "oauth");
    await expect(approveAs(requestId!, "oauth")).rejects.toBeInstanceOf(NotPending);
    expect(await prisma.invitation.count({ where: { orgId, email: addr("race") } })).toBe(1);
  });

  it("refuses approval when the allowlist was tightened after the request was taken", async () => {
    await setMode(AccountRequestMode.OPEN);
    const e = `zz-ar-tightened-${stamp}@elsewhere.test`;
    const { requestId } = await submitAccountRequest({ orgSlug: slug, email: e });

    // The queue entry is not a standing exemption from a later policy change.
    await setMode(AccountRequestMode.ALLOWLIST, ["allowed.test"]);
    await expect(approveAs(requestId!, "oauth")).rejects.toBeInstanceOf(DomainNowDisallowed);

    const row = await prisma.accountRequest.findUniqueOrThrow({ where: { id: requestId! } });
    expect(row.status).toBe(AccountRequestStatus.PENDING);
    expect(sent).toHaveLength(0);
  });

  it("refuses to approve an address off the org's allowed domains, even in OPEN mode", async () => {
    // The bypass: OPEN governs what may be SUBMITTED. The allowed-domain list
    // bounds who may JOIN, and reading the request MODE at decision time made
    // the restriction conditional on it -- so approval could mint an
    // invitation for an address the invitations endpoint would refuse.
    await setMode(AccountRequestMode.OPEN, ["allowed.test"]);
    const off = `zz-ar-offlist-${stamp}@elsewhere.test`;
    const { requestId } = await submitAccountRequest({ orgSlug: slug, email: off });

    await expect(approveAs(requestId!, "oauth")).rejects.toThrow(/allowed domains/i);
    expect(await prisma.invitation.count({ where: { orgId, email: off } })).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("ALLOWLIST with NO domains refuses every submission instead of accepting every one", async () => {
    // An empty list means "unrestricted" everywhere else, so this combination
    // would accept anyone while reading as locked down. The settings route
    // refuses to create the state; the service refuses to honour it.
    await setMode(AccountRequestMode.ALLOWLIST, []);
    const r = await submitAccountRequest({
      orgSlug: slug,
      email: `zz-ar-emptylist-${stamp}@allowed.test`,
    });
    expect(r.outcome).toBe("domain_not_allowed");
  });

  it("denying keeps the row, so the decision stays attributable", async () => {
    await setMode(AccountRequestMode.OPEN);
    const { requestId } = await submitAccountRequest({ orgSlug: slug, email: addr("deny") });

    await denyAccountRequest({ orgId, requestId: requestId!, actorUserId: adminId });

    const row = await prisma.accountRequest.findUniqueOrThrow({ where: { id: requestId! } });
    expect(row.status).toBe(AccountRequestStatus.DENIED);
    expect(row.decidedById).toBe(adminId);
    expect(sent).toHaveLength(0);
  });

  it("denying an already-decided request is refused", async () => {
    await setMode(AccountRequestMode.OPEN);
    const { requestId } = await submitAccountRequest({ orgSlug: slug, email: addr("deny2") });
    await denyAccountRequest({ orgId, requestId: requestId!, actorUserId: adminId });
    await expect(
      denyAccountRequest({ orgId, requestId: requestId!, actorUserId: adminId }),
    ).rejects.toBeInstanceOf(NotPending);
  });

  it("a request belonging to ANOTHER org cannot be decided from this one", async () => {
    await setMode(AccountRequestMode.OPEN);
    const otherSlug = `zzaro-${stamp}`;
    const other = await prisma.organization.create({
      data: { name: `other ${stamp}`, slug: otherSlug },
    });
    await prisma.orgSecuritySettings.create({
      data: { orgId: other.id, accountRequestMode: AccountRequestMode.OPEN },
    });
    const { requestId } = await submitAccountRequest({
      orgSlug: otherSlug,
      email: addr("cross"),
    });

    // Same request id, wrong org: scoped by orgId, so it is simply not pending here.
    await expect(approveAs(requestId!, "oauth")).rejects.toBeInstanceOf(NotPending);
    await expect(
      denyAccountRequest({ orgId, requestId: requestId!, actorUserId: adminId }),
    ).rejects.toBeInstanceOf(NotPending);

    const row = await prisma.accountRequest.findUniqueOrThrow({ where: { id: requestId! } });
    expect(row.status).toBe(AccountRequestStatus.PENDING);
  });
});
