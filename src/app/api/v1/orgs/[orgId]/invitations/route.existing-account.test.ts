// @vitest-environment node
//
// Feature A — seamless re-add of an existing account. A DB-free companion to
// route.test.ts (which needs the e2e DB): every Prisma call + collaborator is
// mocked so this runs anywhere. Proves the branch logic of the invitations POST:
//   - an EXISTING (non-member) account is NEVER a dead end. Whatever sign-in
//     method the inviter chose, it creates a NORMAL pending invitation
//     (allowlist upsert + invitation.create coerced to signInMethod "oauth"),
//     returns { existingAccount: true }, and NEVER calls
//     provisionEmailPasswordInvite (no admin password on a pre-existing account);
//   - a BRAND-NEW email + email_password still provisions a credential.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext, getCurrentUser, prisma, logAudit, provisionEmailPasswordInvite, getPublicOrigin } =
  vi.hoisted(() => ({
    getAuthContext: vi.fn(),
    getCurrentUser: vi.fn(),
    logAudit: vi.fn(),
    provisionEmailPasswordInvite: vi.fn(),
    getPublicOrigin: vi.fn(() => "http://localhost"),
    prisma: {
      organization: { findUnique: vi.fn() },
      orgSecuritySettings: { findUnique: vi.fn() },
      user: { findFirst: vi.fn() },
      orgMember: { findUnique: vi.fn() },
      allowedEmail: { upsert: vi.fn() },
      invitation: { create: vi.fn() },
      $transaction: vi.fn(),
    },
  }));

vi.mock("@/lib/auth/session", () => ({ getAuthContext, getCurrentUser }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/auth/public-url", () => ({ getPublicOrigin }));
vi.mock("@/lib/integrations/invitation-email", () => ({
  sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordInviteEmail: vi.fn().mockResolvedValue(undefined),
}));
// Keep SIGN_IN_METHODS real (the route's zod schema enumerates it); only the
// provisioning function is spied so we can assert it is / isn't called.
vi.mock("@/lib/auth/invite-credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/invite-credentials")>();
  return { ...actual, provisionEmailPasswordInvite };
});

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const INVITER_ID = "22222222-2222-2222-2222-222222222222";

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/invitations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ orgId: ORG_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", name: "Acme" });
  prisma.orgSecuritySettings.findUnique.mockResolvedValue(null); // no domain restriction
  prisma.orgMember.findUnique.mockResolvedValue(null); // not already a member
  prisma.allowedEmail.upsert.mockResolvedValue({ email: "x", addedBy: INVITER_ID });
  // invitation.create echoes the data back (with a token) — used for both the tx
  // client and any direct call.
  prisma.invitation.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "inv-1",
    token: "tok-1",
    ...args.data,
  }));
  // $transaction runs the callback with a tx client exposing invitation.create.
  prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ invitation: { create: prisma.invitation.create } }),
  );
  provisionEmailPasswordInvite.mockResolvedValue({ userId: "new-user", tempPassword: "temp-Pass-123" });

  const ctx: AuthContext = {
    userId: INVITER_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.OWNER,
    permissions: Permission.ORG_MANAGE_MEMBERS | Permission.ORG_READ,
    basePermissions: Permission.ORG_MANAGE_MEMBERS | Permission.ORG_READ,
    abacRules: [],
  };
  getAuthContext.mockResolvedValue(ctx);
  getCurrentUser.mockResolvedValue({ id: INVITER_ID, displayName: "Inviter", email: "inviter@acme.com" });
});

describe("POST /invitations — existing account, email_password chosen", () => {
  it("creates a normal pending invite (no password) and reports existingAccount", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: "existing-user", email: "existing@acme.com" });

    const res = await POST(
      post({ email: "Existing@acme.com", role: "MEMBER", signInMethod: "email_password", mfaRequired: true }),
      { params },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { existingAccount: boolean; invitation: { signInMethod: string } };
    expect(body.existingAccount).toBe(true);
    // NEVER provision an admin credential onto a pre-existing account.
    expect(provisionEmailPasswordInvite).not.toHaveBeenCalled();
    // The invite is coerced to the OAuth-style flow.
    expect(body.invitation.signInMethod).toBe("oauth");
    expect(prisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signInMethod: "oauth" }) }),
    );
    // Allowlist upsert still runs so their next sign-in passes the gate.
    expect(prisma.allowedEmail.upsert).toHaveBeenCalled();
    // The plaintext temp password is never returned.
    expect(body).not.toHaveProperty("tempPassword");
  });
});

describe("POST /invitations — existing account, oauth chosen", () => {
  it("reports existingAccount and provisions nothing", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: "existing-user", email: "existing@acme.com" });

    const res = await POST(post({ email: "existing@acme.com", role: "MEMBER", signInMethod: "oauth" }), {
      params,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { existingAccount: boolean; invitation: { signInMethod: string } };
    expect(body.existingAccount).toBe(true);
    expect(provisionEmailPasswordInvite).not.toHaveBeenCalled();
    expect(body.invitation.signInMethod).toBe("oauth");
  });
});

describe("POST /invitations — brand-new email, email_password chosen", () => {
  it("provisions a credential and reports existingAccount:false", async () => {
    prisma.user.findFirst.mockResolvedValue(null); // brand-new email

    const res = await POST(
      post({ email: "new@acme.com", role: "MEMBER", signInMethod: "email_password", mfaRequired: false }),
      { params },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { existingAccount: boolean; invitation: { signInMethod: string } };
    expect(body.existingAccount).toBe(false);
    // A brand-new account DOES get the local credential provisioned.
    expect(provisionEmailPasswordInvite).toHaveBeenCalledTimes(1);
    expect(body.invitation.signInMethod).toBe("email_password");
    // Still never leaks the plaintext temp password in the response.
    expect(body).not.toHaveProperty("tempPassword");
  });
});
