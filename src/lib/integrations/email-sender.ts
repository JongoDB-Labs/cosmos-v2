// Swappable transactional email sender.
//
// Invitation emails (and any future app-originated transactional mail) should
// go through sendAppEmail() so they arrive from a verified, branded domain
// instead of an individual user's personal mailbox — sending invites out of
// the inviter's own Gmail is what was landing them in recipients' spam.
// Resend is the only backend wired up today; swapping providers means
// changing this file alone, not every call site.
//
// Configuration is OPTIONAL: isTransactionalEmailConfigured() reports false
// when RESEND_API_KEY / EMAIL_FROM aren't set, so callers can fall back to
// their own delivery path (see invitation-email.ts's Gmail fallback).
// sendAppEmail() itself also throws when unconfigured, so a caller that skips
// the isTransactionalEmailConfigured() guard fails loudly instead of silently
// dropping mail.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Is the Resend transactional-email path configured? Read at CALL TIME (never
 * memoized) so tests and deploys see the current env. `EMAIL_FROM` must be a
 * fully-formed From header on a domain verified with Resend, e.g.
 * `"Cosmos <invites@yourdomain.com>"`.
 */
export function isTransactionalEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

/**
 * Send one transactional email via Resend from the verified, branded
 * `EMAIL_FROM` address (global `fetch` — no SDK dependency). Throws when
 * RESEND_API_KEY/EMAIL_FROM aren't set, or when Resend rejects the request, so
 * callers that want a fallback (e.g. the inviter's own Gmail) should guard
 * with isTransactionalEmailConfigured() first and catch around the call.
 */
export async function sendAppEmail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error("transactional email not configured");
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      ...(params.replyTo ? { reply_to: params.replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`Resend send failed with HTTP ${res.status}: ${bodyText}`);
  }
}
