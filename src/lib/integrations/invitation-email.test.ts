// @vitest-environment node
//
// Sender selection for invitation emails: Resend (branded, verified-domain
// From) when configured, else the pre-existing inviter's-own-Gmail path,
// UNCHANGED. Mocks the three seams — the DB (inviter email lookup), the
// Gmail client, and the Resend-backed email-sender — so no real network or
// DB call happens; the gating logic in dispatchInviteEmail() is what's under
// test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findUnique } } }));

const { getGmailClient, gmailSend } = vi.hoisted(() => ({
  getGmailClient: vi.fn(),
  gmailSend: vi.fn(),
}));
vi.mock("@/lib/integrations/google", () => ({ getGmailClient }));

const { sendAppEmail, isTransactionalEmailConfigured } = vi.hoisted(() => ({
  sendAppEmail: vi.fn(),
  isTransactionalEmailConfigured: vi.fn(),
}));
vi.mock("@/lib/integrations/email-sender", () => ({
  sendAppEmail,
  isTransactionalEmailConfigured,
}));

import { sendInvitationEmail, sendPasswordInviteEmail } from "./invitation-email";

const BASE_OAUTH = {
  fromUserId: "user-1",
  orgId: "org-1",
  toEmail: "invitee@example.com",
  orgName: "Acme",
  inviterName: "Jo Inviter",
  acceptUrl: "https://app.example.com/login?invite=tok123",
};

const BASE_PASSWORD = {
  fromUserId: "user-1",
  orgId: "org-1",
  toEmail: "invitee@example.com",
  orgName: "Acme",
  inviterName: "Jo Inviter",
  loginUrl: "https://app.example.com/login?org=acme",
  tempPassword: "TempPass123!",
  mfaRequired: false,
};

beforeEach(() => {
  findUnique.mockReset();
  getGmailClient.mockReset();
  gmailSend.mockReset();
  sendAppEmail.mockReset();
  isTransactionalEmailConfigured.mockReset();

  getGmailClient.mockResolvedValue({ users: { messages: { send: gmailSend } } });
  gmailSend.mockResolvedValue({ data: { id: "gmail-msg-1" } });
  sendAppEmail.mockResolvedValue(undefined);
});

describe("sendInvitationEmail — sender selection", () => {
  it("sends via Resend (sendAppEmail) when transactional email is configured, with replyTo best-effort from the inviter", async () => {
    isTransactionalEmailConfigured.mockReturnValue(true);
    findUnique.mockResolvedValue({ email: "inviter@example.com" });

    await sendInvitationEmail(BASE_OAUTH);

    expect(sendAppEmail).toHaveBeenCalledTimes(1);
    const call = sendAppEmail.mock.calls[0][0];
    expect(call.to).toBe("invitee@example.com");
    expect(call.replyTo).toBe("inviter@example.com");
    expect(call.subject).toContain("Acme");
    expect(call.text).toContain(BASE_OAUTH.acceptUrl);
    expect(call.html).toContain(BASE_OAUTH.acceptUrl);

    // The inviter lookup is scoped by fromUserId.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { email: true },
    });

    // Gmail must not be touched on the Resend path.
    expect(getGmailClient).not.toHaveBeenCalled();
  });

  it("falls back to the inviter's Gmail, unchanged, when transactional email is not configured", async () => {
    isTransactionalEmailConfigured.mockReturnValue(false);

    await sendInvitationEmail(BASE_OAUTH);

    expect(getGmailClient).toHaveBeenCalledWith("user-1", "org-1");
    expect(gmailSend).toHaveBeenCalledTimes(1);

    // Resend must not be touched on the Gmail path, and the (unnecessary)
    // inviter-email DB lookup is skipped entirely — it exists only to serve
    // the Resend reply-to header.
    expect(sendAppEmail).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("omits replyTo (rather than failing the send) when the inviter lookup returns nothing", async () => {
    isTransactionalEmailConfigured.mockReturnValue(true);
    findUnique.mockResolvedValue(null);

    await sendInvitationEmail(BASE_OAUTH);

    expect(sendAppEmail).toHaveBeenCalledTimes(1);
    expect(sendAppEmail.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("omits replyTo (rather than failing the send) when the inviter lookup throws", async () => {
    isTransactionalEmailConfigured.mockReturnValue(true);
    findUnique.mockRejectedValue(new Error("db unavailable"));

    await expect(sendInvitationEmail(BASE_OAUTH)).resolves.toBeUndefined();

    expect(sendAppEmail).toHaveBeenCalledTimes(1);
    expect(sendAppEmail.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("propagates a Resend send failure to the caller (no silent swallow)", async () => {
    isTransactionalEmailConfigured.mockReturnValue(true);
    findUnique.mockResolvedValue({ email: "inviter@example.com" });
    sendAppEmail.mockRejectedValue(new Error("Resend send failed with HTTP 422: bad from"));

    await expect(sendInvitationEmail(BASE_OAUTH)).rejects.toThrow(/422/);
  });
});

describe("sendPasswordInviteEmail — sender selection", () => {
  it("sends via Resend (sendAppEmail) when transactional email is configured, with replyTo best-effort from the inviter", async () => {
    isTransactionalEmailConfigured.mockReturnValue(true);
    findUnique.mockResolvedValue({ email: "inviter@example.com" });

    await sendPasswordInviteEmail(BASE_PASSWORD);

    expect(sendAppEmail).toHaveBeenCalledTimes(1);
    const call = sendAppEmail.mock.calls[0][0];
    expect(call.to).toBe("invitee@example.com");
    expect(call.replyTo).toBe("inviter@example.com");
    expect(call.subject).toContain("Acme");
    expect(call.text).toContain("TempPass123!");
    expect(call.html).toContain("TempPass123!");

    expect(getGmailClient).not.toHaveBeenCalled();
  });

  it("falls back to the inviter's Gmail, unchanged, when transactional email is not configured", async () => {
    isTransactionalEmailConfigured.mockReturnValue(false);

    await sendPasswordInviteEmail(BASE_PASSWORD);

    expect(getGmailClient).toHaveBeenCalledWith("user-1", "org-1");
    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(sendAppEmail).not.toHaveBeenCalled();
  });

  it("carries the null-tempPassword body unchanged on the Resend path (existing-user credential copy)", async () => {
    isTransactionalEmailConfigured.mockReturnValue(true);
    findUnique.mockResolvedValue({ email: "inviter@example.com" });

    await sendPasswordInviteEmail({ ...BASE_PASSWORD, tempPassword: null });

    const call = sendAppEmail.mock.calls[0][0];
    expect(call.text).toContain("Sign in with the password you already use");
    expect(call.text).not.toContain("Temporary password");
  });
});
