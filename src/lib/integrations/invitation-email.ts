import { getGmailClient } from "./google";
import { getBrand } from "@/lib/brand";

/**
 * Send an invitation email via the inviter's Gmail mailbox using
 * gmail.send scope. Throws on any failure so the caller can decide
 * whether to surface a partial-success (invite created, email failed)
 * to the admin so they can copy the link out-of-band.
 */
export async function sendInvitationEmail(params: {
  fromUserId: string;
  orgId: string;
  toEmail: string;
  orgName: string;
  inviterName: string;
  acceptUrl: string;
}): Promise<void> {
  const gmail = await getGmailClient(params.fromUserId, params.orgId);

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

  const boundary = `cosmos-${Date.now()}`;
  const message =
    [
      `To: ${params.toEmail}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      textBody,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "",
      htmlBody,
      `--${boundary}--`,
    ].join("\r\n");

  // gmail.users.messages.send wants URL-safe base64 of the raw RFC822 message.
  const raw = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
