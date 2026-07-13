// @vitest-environment node
//
// Invitation creation — the email/password variant added alongside the existing
// OAuth flow. Runs against the REAL e2e DB (seeded `test-org`): getAuthContext /
// getCurrentUser are mocked (no session cookies in a route-handler test) and the
// Gmail sender is stubbed, but every Prisma write (credential provisioning,
// invitation row, allowlist) runs for real. Proves:
//   - an email_password invite provisions a LOCAL credential (scrypt-hashed temp
//     password), sets mustChangePassword + the per-user MFA floor, records the
//     method on the invitation, and returns the temp password ONCE;
//   - the existing OAuth invite is unchanged: no credential, no temp password.
// All fixtures are torn down in afterAll.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext, getCurrentUser } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext, getCurrentUser }));
// Stub the Gmail senders so the route doesn't attempt a real network send.
vi.mock("@/lib/integrations/invitation-email", () => ({
  sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/db/client";
import { verifyPassword } from "@/lib/auth/password";
import { POST } from "./route";

const PW_EMAIL = "zz-invite-pw@example.com";
const OAUTH_EMAIL = "zz-invite-oauth@example.com";
const INVITER_EMAIL = "zz-invite-inviter@example.com";

let orgId: string;
let inviterId: string;

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/invitations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function cleanup() {
  await prisma.invitation.deleteMany({ where: { email: { in: [PW_EMAIL, OAUTH_EMAIL] } } });
  await prisma.allowedEmail.deleteMany({ where: { email: { in: [PW_EMAIL, OAUTH_EMAIL] } } });
  await prisma.session.deleteMany({
    where: { user: { email: { in: [PW_EMAIL, OAUTH_EMAIL, INVITER_EMAIL] } } },
  });
  await prisma.user.deleteMany({ where: { email: { in: [PW_EMAIL, OAUTH_EMAIL, INVITER_EMAIL] } } });
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;
  await cleanup();

  const inviter = await prisma.user.create({
    data: { email: INVITER_EMAIL, displayName: "Inviter" },
    select: { id: true },
  });
  inviterId = inviter.id;

  const ctx: AuthContext = {
    userId: inviterId,
    orgId,
    orgRole: OrgRole.OWNER,
    permissions: Permission.ORG_MANAGE_MEMBERS | Permission.ORG_READ,
    basePermissions: Permission.ORG_MANAGE_MEMBERS | Permission.ORG_READ,
    abacRules: [],
  };
  getAuthContext.mockResolvedValue(ctx);
  getCurrentUser.mockResolvedValue({ id: inviterId, displayName: "Inviter", email: INVITER_EMAIL });
});

afterAll(cleanup);

describe("POST /invitations — email_password", () => {
  it("provisions a hashed temp credential with force-rotate + MFA flags", async () => {
    const res = await POST(post({
      email: PW_EMAIL,
      role: "MEMBER",
      signInMethod: "email_password",
      mfaRequired: true,
    }), { params: Promise.resolve({ orgId }) });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      tempPassword: string | null;
      invitation: { signInMethod: string; mfaRequired: boolean };
    };
    expect(body.tempPassword).toBeTruthy();
    expect(body.invitation.signInMethod).toBe("email_password");
    expect(body.invitation.mfaRequired).toBe(true);

    const user = await prisma.user.findFirstOrThrow({ where: { email: PW_EMAIL } });
    expect(user.passwordHash).toBeTruthy();
    // Stored hash verifies the returned temp password but is not the plaintext.
    expect(verifyPassword(body.tempPassword as string, user.passwordHash as string)).toBe(true);
    expect(user.passwordHash).not.toContain(body.tempPassword as string);
    expect(user.mustChangePassword).toBe(true);
    expect(user.mfaRequired).toBe(true);

    const invite = await prisma.invitation.findFirstOrThrow({ where: { email: PW_EMAIL } });
    expect(invite.signInMethod).toBe("email_password");
    expect(invite.mfaRequired).toBe(true);
  });
});

describe("POST /invitations — oauth (unchanged)", () => {
  it("creates no local credential and returns no temp password", async () => {
    const res = await POST(post({ email: OAUTH_EMAIL, role: "MEMBER" }), {
      params: Promise.resolve({ orgId }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      tempPassword: string | null;
      invitation: { signInMethod: string };
    };
    expect(body.tempPassword).toBeNull();
    expect(body.invitation.signInMethod).toBe("oauth");

    // The OAuth path must NOT provision a user (JIT happens at the OAuth callback).
    const user = await prisma.user.findFirst({ where: { email: OAUTH_EMAIL } });
    expect(user).toBeNull();
  });
});
