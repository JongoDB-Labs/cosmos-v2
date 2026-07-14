import { getGmailClient } from "./google";
import { getBrand } from "@/lib/brand";
import { prisma } from "@/lib/db/client";
import { isTransactionalEmailConfigured, sendAppEmail } from "./email-sender";

/**
 * Low-level: send one multipart/alternative message via the inviter's Gmail
 * mailbox (gmail.send scope). Throws on any failure so the caller can surface a
 * partial-success (invite created, email failed) and let the admin copy the
 * link / credential out-of-band. Shared by both invite variants below.
 */
async function sendViaGmail(params: {
  fromUserId: string;
  orgId: string;
  toEmail: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}): Promise<void> {
  const gmail = await getGmailClient(params.fromUserId, params.orgId);

  const boundary = `cosmos-${Date.now()}`;
  const message = [
    `To: ${params.toEmail}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    params.textBody,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    params.htmlBody,
    `--${boundary}--`,
  ].join("\r\n");

  // gmail.users.messages.send wants URL-safe base64 of the raw RFC822 message.
  const raw = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

/**
 * Best-effort inviter email for the Resend `reply_to` header, so a reply to
 * the branded invite still reaches the person who sent it. The invite params
 * only carry `fromUserId` (no email field), so this looks it up directly; a
 * lookup failure — or a since-deleted user — just omits reply_to rather than
 * blocking the send.
 */
async function lookupInviterEmail(fromUserId: string): Promise<string | undefined> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: fromUserId },
      select: { email: true },
    });
    return user?.email ?? undefined;
  } catch {
    // Best-effort only — replyTo is a nicety, never worth failing the send over.
    return undefined;
  }
}

/**
 * Shared dispatch point for both invite variants below: send from the
 * branded, verified-domain Resend sender when configured (RESEND_API_KEY +
 * EMAIL_FROM) instead of the inviter's personal Gmail mailbox — the personal
 * send is what was landing invites in recipients' spam. Falls back to the
 * existing Gmail path, UNCHANGED, when Resend isn't configured.
 */
async function dispatchInviteEmail(params: {
  fromUserId: string;
  orgId: string;
  toEmail: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}): Promise<void> {
  if (isTransactionalEmailConfigured()) {
    await sendAppEmail({
      to: params.toEmail,
      subject: params.subject,
      text: params.textBody,
      html: params.htmlBody,
      replyTo: await lookupInviterEmail(params.fromUserId),
    });
    return;
  }
  await sendViaGmail(params);
}

/**
 * OAuth invite email (Google / Microsoft / SSO). Unchanged behavior: the invitee
 * accepts by signing in with their existing provider account.
 */
export async function sendInvitationEmail(params: {
  fromUserId: string;
  orgId: string;
  toEmail: string;
  orgName: string;
  inviterName: string;
  acceptUrl: string;
}): Promise<void> {
  const brand = getBrand().name;
  const subject = `You've been invited to ${params.orgName} on ${brand}`;
  const textBody = [
    `${params.inviterName} has invited you to join ${params.orgName} on ${brand}.`,
    "",
    `Sign in with your Google account to accept:`,
    params.acceptUrl,
    "",
    "If you didn't expect this invitation, you can ignore this email.",
  ].join("\n");

  const htmlBody = `
    <p>${escapeHtml(params.inviterName)} has invited you to join
       <strong>${escapeHtml(params.orgName)}</strong> on ${brand}.</p>
    <p><a href="${params.acceptUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">Accept invitation</a></p>
    <p>Or open this link:<br><code>${escapeHtml(params.acceptUrl)}</code></p>
    <p style="color:#666;font-size:12px;">If you didn't expect this invitation, you can ignore this email.</p>
  `;

  await dispatchInviteEmail({ ...params, subject, textBody, htmlBody });
}

/**
 * Email/password invite email. Carries the one-time temporary password (when the
 * account was freshly provisioned) and tells the invitee they must set a new
 * password at first sign-in — and enroll two-factor if the invite required it.
 *
 * `tempPassword` is null when the invitee already had a password of their own; in
 * that case we tell them to use it rather than shipping a credential they didn't
 * set.
 */
export async function sendPasswordInviteEmail(params: {
  fromUserId: string;
  orgId: string;
  toEmail: string;
  orgName: string;
  inviterName: string;
  loginUrl: string;
  tempPassword: string | null;
  mfaRequired: boolean;
}): Promise<void> {
  const brand = getBrand().name;
  const subject = `Your ${params.orgName} account on ${brand}`;
  const mfaLine = params.mfaRequired
    ? "You'll also be asked to set up an authenticator app (two-factor) before you finish."
    : "";

  const credText = params.tempPassword
    ? [
        `Email:             ${params.toEmail}`,
        `Temporary password: ${params.tempPassword}`,
        "",
        "For your security you'll be required to choose a new password the first",
        "time you sign in.",
      ].join("\n")
    : [
        `Email: ${params.toEmail}`,
        "",
        "Sign in with the password you already use for this account.",
      ].join("\n");

  const textBody = [
    `${params.inviterName} has invited you to join ${params.orgName} on ${brand}.`,
    "",
    "Sign in with your email and password here:",
    params.loginUrl,
    "",
    credText,
    mfaLine ? `\n${mfaLine}` : "",
    "",
    "If you didn't expect this invitation, you can ignore this email.",
  ].join("\n");

  const credHtml = params.tempPassword
    ? `<p>Sign in with these credentials:</p>
       <table style="border-collapse:collapse;font-size:14px;">
         <tr><td style="padding:2px 8px;color:#666;">Email</td><td style="padding:2px 8px;"><code>${escapeHtml(params.toEmail)}</code></td></tr>
         <tr><td style="padding:2px 8px;color:#666;">Temporary&nbsp;password</td><td style="padding:2px 8px;"><code>${escapeHtml(params.tempPassword)}</code></td></tr>
       </table>
       <p style="color:#666;font-size:12px;">For your security you'll be required to choose a new password the first time you sign in.</p>`
    : `<p>Sign in with the email <code>${escapeHtml(params.toEmail)}</code> and the password you already use for this account.</p>`;

  const htmlBody = `
    <p>${escapeHtml(params.inviterName)} has invited you to join
       <strong>${escapeHtml(params.orgName)}</strong> on ${brand}.</p>
    <p><a href="${params.loginUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">Sign in</a></p>
    ${credHtml}
    ${mfaLine ? `<p style="font-size:13px;">${escapeHtml(mfaLine)}</p>` : ""}
    <p style="color:#666;font-size:12px;">If you didn't expect this invitation, you can ignore this email.</p>
  `;

  await dispatchInviteEmail({ ...params, subject, textBody, htmlBody });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
