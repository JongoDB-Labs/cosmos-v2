// @vitest-environment node
//
// Every lookup that finds a person, an account or an invitation by address
// matches that exact address, ignoring case only. Each case has two halves: a
// different address finds nothing, and the exact address typed in another case
// still finds its row. Several of the addresses contain an underscore, so the
// positive controls also show the exact match working for those.
//
// Real database, real routes and functions. The only stand-ins are outgoing
// mail and the request cookie store.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { OrgRole, type IdpConnection } from "@prisma/client";

process.env.SSO_VAULT_KEY ??= Buffer.alloc(32, 23).toString("base64");

const sentResets: string[] = [];
vi.mock("@/lib/integrations/invitation-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/invitation-email")>()),
  sendPasswordResetEmail: vi.fn(async (p: { toEmail: string }) => {
    sentResets.push(p.toEmail);
  }),
  sendInvitationEmail: vi.fn(async () => undefined),
  sendPasswordInviteEmail: vi.fn(async () => undefined),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
  headers: async () => new Headers(),
}));

import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { escapeLike } from "@/lib/query/like";
import { POST as passwordLogin } from "@/app/api/auth/password/login/route";
import { POST as requestReset } from "@/app/api/auth/password/reset/request/route";
import { completeSsoLogin, type SsoClaims } from "./sso";
import { revokeProvisionedAccount } from "./revoke-invitation";
import { submitAccountRequest } from "./account-requests";
import { isEmailAllowlisted } from "./first-party-identity";
import { resolveSenderOrg } from "./sender-org";
import { provisionEmailPasswordInvite } from "./invite-credentials";
import { deleteUserAccount } from "@/lib/internal/delete-user";
import { ALREADY_A_MEMBER, createOrgInvitation } from "./create-invitation";
import { resolveFirstPartyUser } from "./first-party-identity";
import { RolePermissions } from "@/lib/rbac/permissions";

const stamp = Math.random().toString(36).slice(2, 8);
const DOM = `exact-${stamp}.test`;
const ISS = `https://idp-exact-${stamp}.example.com`;
/** An account's address, and a different address one character away from it. */
const pair = (tag: string) => ({ real: `${tag}.${stamp}@${DOM}`, near: `${tag}_${stamp}@${DOM}` });
const PASSWORD = `exact address ${stamp} passphrase`;

const userIds: string[] = [];
const orgIds: string[] = [];
let org: { id: string; slug: string };
let conn: IdpConnection;

async function mkUser(email: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { email, displayName: email.split("@")[0], ...extra } });
  userIds.push(u.id);
  return u.id;
}
const withPassword = { passwordHash: hashPassword(PASSWORD), passwordSetAt: new Date() };
const invite = (email: string) =>
  prisma.invitation.create({ data: { orgId: org.id, email, expiresAt: new Date(Date.now() + 86_400_000) } });
const claims = (subject: string, email: string): SsoClaims =>
  ({ subject, email, emailVerified: true, groups: [], acr: null, amr: [], issuer: ISS }) as SsoClaims;

let ipSeq = 0;
const post = (url: string, body: unknown) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.91.${Math.floor(Math.random() * 250)}.${++ipSeq}` },
    body: JSON.stringify(body),
  });
const login = (email: string, password = PASSWORD) =>
  passwordLogin(post("http://localhost/api/auth/password/login", { email, password }));
const reset = (email: string) => requestReset(post("http://localhost/api/auth/password/reset/request", { email }));

beforeAll(async () => {
  const o = await prisma.organization.create({
    data: { name: `Exact ${stamp}`, slug: `exact-${stamp}` },
    select: { id: true, slug: true },
  });
  org = o;
  orgIds.push(o.id);
  await prisma.orgSecuritySettings.create({
    data: { orgId: o.id, allowedDomains: [DOM], accountRequestMode: "OPEN" },
  });
  conn = await prisma.idpConnection.create({
    data: { orgId: o.id, issuerUrl: ISS, clientId: "c", clientSecretEnc: "x", enabled: true },
  });
});

afterAll(async () => {
  const strays = await prisma.user.findMany({ where: { email: { contains: stamp } }, select: { id: true } });
  const ids = [...new Set([...userIds, ...strays.map((u) => u.id)])];
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.federatedIdentity.deleteMany({ where: { userId: { in: ids } } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { OR: [{ orgId: { in: orgIds } }, { userId: { in: ids } }] } });
  await prisma.invitation.deleteMany({ where: { OR: [{ orgId: { in: orgIds } }, { email: { contains: stamp } }] } });
  await prisma.accountRequest.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.allowedEmail.deleteMany({ where: { email: { contains: stamp } } });
  await prisma.idpConnection.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
});

describe("an escaped insensitive equals is an exact, case-blind comparison", () => {
  it("finds an address that contains an underscore, typed in another case", async () => {
    const email = `snake_${stamp}@${DOM}`;
    const id = await mkUser(email);
    const hit = await prisma.user.findFirst({
      where: { email: { equals: escapeLike(email.toUpperCase()), mode: "insensitive" } },
      select: { id: true },
    });
    expect(hit?.id).toBe(id);
  });
});

describe("password sign-in", () => {
  it("signs in with the exact address only", async () => {
    const { real, near } = pair("login");
    await mkUser(real, withPassword);
    expect((await login(near)).status).toBe(401);
  });

  it("signs in with the exact address in another case (positive control)", async () => {
    const { real } = pair("login2");
    await mkUser(real, withPassword);
    expect((await login(real.toUpperCase())).status).toBe(200);
    const snake = `login_snake.${stamp}@${DOM}`;
    await mkUser(snake, withPassword);
    expect((await login(snake.toUpperCase())).status).toBe(200);
  });

  it("counts every case of one address against the same per-account limit", async () => {
    const { real } = pair("brake");
    await mkUser(real, withPassword);
    const spellings = [real, real.toUpperCase(), `Brake.${stamp}@${DOM}`, `bRAKE.${stamp}@${DOM}`, `BRAKE.${stamp}@${DOM}`];
    for (const s of spellings) expect((await login(s, "wrong password")).status).toBe(401);
    const sixth = await login(real);
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).error).toMatch(/this account/);
  });
});

describe("password reset request", () => {
  afterEach(() => vi.restoreAllMocks());
  /** The operator line's outcome word for one request. */
  const outcomeOf = async (email: string) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect((await reset(email)).status).toBe(200);
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[password-reset]"));
    return line?.split(" ")[1];
  };

  it("mails only the exact address", async () => {
    const { real, near } = pair("reset");
    await mkUser(real, withPassword);
    sentResets.length = 0;
    expect(await outcomeOf(near)).toBe("no_such_email");
    expect(sentResets).toEqual([]);
  });

  it("mails the exact address typed in another case (positive control)", async () => {
    const { real } = pair("reset2");
    await mkUser(real, withPassword);
    sentResets.length = 0;
    expect(await outcomeOf(real.toUpperCase())).toBe("sent");
    expect(sentResets).toEqual([real]);
  });
});

describe("single sign-on", () => {
  it("links a member's account only from their exact address", async () => {
    const { real, near } = pair("sso");
    const uid = await mkUser(real);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: uid, role: OrgRole.MEMBER } });
    const r = await completeSsoLogin(org.slug, conn, claims(`near-${stamp}`, near), {});
    expect(r.ok && r.userId).not.toBe(uid);
    expect(await prisma.federatedIdentity.count({ where: { userId: uid } })).toBe(0);
  });

  it("links a member's account from their exact address in another case (positive control)", async () => {
    const { real } = pair("sso2");
    const uid = await mkUser(real);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: uid, role: OrgRole.MEMBER } });
    const r = await completeSsoLogin(org.slug, conn, claims(`real-${stamp}`, real.toUpperCase()), {});
    expect(r.ok && r.userId).toBe(uid);
  });

  it("an invitation links an account only when it names that exact address", async () => {
    // The org invited a different address from the account's own.
    const own = `inv_${stamp}@${DOM}`;
    const uid = await mkUser(own);
    await invite(`invx${stamp}@${DOM}`);
    const r = await completeSsoLogin(org.slug, conn, claims(`inv-${stamp}`, own), {});
    expect(r.ok).toBe(false);
    expect(await prisma.federatedIdentity.count({ where: { userId: uid } })).toBe(0);
  });

  it("an invitation to the exact address in another case links the account (positive control)", async () => {
    const own = `inv2_${stamp}@${DOM}`;
    const uid = await mkUser(own);
    await invite(own.toUpperCase());
    const r = await completeSsoLogin(org.slug, conn, claims(`inv2-${stamp}`, own), {});
    expect(r.ok && r.userId).toBe(uid);
  });

  it("accepts only invitations addressed to the exact address", async () => {
    const { real, near } = pair("accept");
    const inv = await invite(real);
    const r = await completeSsoLogin(org.slug, conn, claims(`accept-${stamp}`, near), {});
    expect(r.ok).toBe(true);
    expect(await prisma.invitation.count({ where: { id: inv.id } })).toBe(1);
  });

  it("accepts an invitation to the exact address typed in another case (positive control)", async () => {
    const { real } = pair("accept2");
    const inv = await invite(real);
    const r = await completeSsoLogin(org.slug, conn, claims(`accept2-${stamp}`, real.toUpperCase()), {});
    expect(r.ok).toBe(true);
    expect(await prisma.invitation.count({ where: { id: inv.id } })).toBe(0);
  });
});

describe("revoking an invitation", () => {
  const provisioned = { mustChangePassword: true, passwordHash: hashPassword(PASSWORD) };

  it("removes only the account at the exact address", async () => {
    const { real, near } = pair("revoke");
    const uid = await mkUser(real, provisioned);
    const r = await prisma.$transaction((tx) => revokeProvisionedAccount(tx, { email: near, invitationId: randomUUID() }));
    expect(r.deleted).toBe(false);
    expect(await prisma.user.count({ where: { id: uid } })).toBe(1);
  });

  it("removes the account at the exact address typed in another case (positive control)", async () => {
    const { real } = pair("revoke2");
    const uid = await mkUser(real, provisioned);
    const r = await prisma.$transaction((tx) =>
      revokeProvisionedAccount(tx, { email: real.toUpperCase(), invitationId: randomUUID() }),
    );
    expect(r).toEqual({ deleted: true, reason: "unused provisioned account removed" });
    expect(await prisma.user.count({ where: { id: uid } })).toBe(0);
  });

  it("is held back only by another invitation to the exact address", async () => {
    const own = `held_${stamp}@${DOM}`;
    const uid = await mkUser(own, provisioned);
    await invite(`heldx${stamp}@${DOM}`);
    const r = await prisma.$transaction((tx) => revokeProvisionedAccount(tx, { email: own, invitationId: randomUUID() }));
    expect(r.deleted).toBe(true);
    expect(await prisma.user.count({ where: { id: uid } })).toBe(0);
  });

  it("is held back by another invitation to the exact address in another case (positive control)", async () => {
    const own = `held2_${stamp}@${DOM}`;
    await mkUser(own, provisioned);
    await invite(own.toUpperCase());
    const r = await prisma.$transaction((tx) => revokeProvisionedAccount(tx, { email: own, invitationId: randomUUID() }));
    expect(r).toEqual({ deleted: false, reason: "another invitation is pending" });
  });
});

describe("account requests", () => {
  it("treats only the exact address as an existing member", async () => {
    const { real, near } = pair("req");
    const uid = await mkUser(real);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: uid, role: OrgRole.MEMBER } });
    expect((await submitAccountRequest({ orgSlug: org.slug, email: near })).outcome).toBe("queued");
  });

  it("treats the exact address in another case as an existing member (positive control)", async () => {
    const { real } = pair("req2");
    const uid = await mkUser(real);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: uid, role: OrgRole.MEMBER } });
    expect((await submitAccountRequest({ orgSlug: org.slug, email: real.toUpperCase() })).outcome).toBe("already_member");
  });
});

describe("other address lookups", () => {
  it("the sign-in allowlist admits only the exact address, in any case", async () => {
    const { real, near } = pair("allow");
    await prisma.allowedEmail.create({ data: { email: real } });
    expect(await isEmailAllowlisted(near)).toBe(false);
    expect(await isEmailAllowlisted(real.toUpperCase())).toBe(true);
  });

  it("the reset sender falls back only to an invitation for the exact address, in any case", async () => {
    const { real, near } = pair("sender");
    await invite(real);
    expect(await resolveSenderOrg({ email: near, memberships: [] })).toBeNull();
    expect((await resolveSenderOrg({ email: real.toUpperCase(), memberships: [] }))?.id).toBe(org.id);
  });

  it("an email-and-password invite refuses only an account at the exact address, in any case", async () => {
    const { real, near } = pair("prov");
    await mkUser(real);
    const created = await provisionEmailPasswordInvite({ email: near, mfaRequired: false });
    userIds.push(created.userId);
    expect(created.userId).toBeTruthy();
    await expect(provisionEmailPasswordInvite({ email: real.toUpperCase(), mfaRequired: false })).rejects.toThrow();
  });

  it("an invitation is refused only for a member at the exact address, in any case", async () => {
    const { real, near } = pair("ci");
    const uid = await mkUser(real);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: uid, role: OrgRole.MEMBER } });
    const actor = await mkUser(`ci-actor.${stamp}@${DOM}`);
    const send = (email: string) =>
      createOrgInvitation({
        orgId: org.id,
        orgName: `Exact ${stamp}`,
        orgSlug: org.slug,
        email,
        role: OrgRole.MEMBER,
        signInMethod: "oauth",
        mfaRequired: false,
        actorUserId: actor,
        actorOrgRole: OrgRole.OWNER,
        actorBasePermissions: RolePermissions[OrgRole.OWNER],
        actorDisplayName: "Actor",
        origin: "http://localhost",
      });
    await expect(send(near)).resolves.toMatchObject({ existingAccount: false });
    await expect(send(real.toUpperCase())).rejects.toThrow(ALREADY_A_MEMBER);
  });

  it("Google sign-in links an account only from its exact address, in any case", async () => {
    const { real, near } = pair("goog");
    const uid = await mkUser(real);
    await prisma.allowedEmail.createMany({ data: [{ email: real }, { email: near }] });
    const signIn = (subject: string, email: string) =>
      resolveFirstPartyUser({ identity: { provider: "google", subject }, verifiedEmails: [email], profile: { displayName: "G" } });
    const other = await signIn(`g-near-${stamp}`, near);
    expect(other.ok && other.user.id).not.toBe(uid);
    if (other.ok) userIds.push(other.user.id);
    const same = await signIn(`g-real-${stamp}`, real.toUpperCase());
    expect(same.ok && same.outcome).toBe("linked");
    expect(same.ok && same.user.id).toBe(uid);
  });

  it("deleting an account removes the allowlist entries and invitations of its exact address only", async () => {
    const own = `gone_${stamp}@${DOM}`;
    const other = `gonex${stamp}@${DOM}`;
    const uid = await mkUser(own);
    await prisma.allowedEmail.createMany({ data: [{ email: own.toUpperCase() }, { email: other }] });
    await invite(own.toUpperCase());
    await invite(other);
    const r = await deleteUserAccount({ userId: uid, email: own });
    expect([r.allowlistEntriesRemoved, r.invitationsRemoved]).toEqual([1, 1]);
    expect(await prisma.allowedEmail.count({ where: { email: other } })).toBe(1);
    expect(await prisma.invitation.count({ where: { email: other } })).toBe(1);
  });
});
