// Swappable transactional email sender.
//
// Invitation emails (and any future app-originated transactional mail) should
// go through sendAppEmail() so they arrive from a verified, branded domain
// instead of an individual user's personal mailbox — sending invites out of
// the inviter's own Gmail is what was landing them in recipients' spam.
// Resend is the only backend wired up today; swapping providers means
// changing this file alone, not every call site.
//
// CONFIG RESOLUTION PRECEDENCE (highest first):
//   1. PER-ORG — when an `orgId` is supplied and that org has a usable
//      OrgEmailSettings row (enabled, sealed key opens, fromAddress set), send
//      with the org's own vault-sealed Resend key + From (see org-email-config.ts).
//   2. ENV — else fall back to the deployment-wide RESEND_API_KEY / EMAIL_FROM.
//   3. (caller's own fallback) — with neither, isTransactionalEmailConfigured()
//      reports false and sendAppEmail() throws, so a caller can fall back to its
//      own delivery path (see invitation-email.ts's Gmail fallback). A caller that
//      skips the guard fails loudly instead of silently dropping mail.

import { getOrgEmailConfig } from "./org-email-config";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Is the Resend transactional-email path configured for this send? True when a
 * usable PER-ORG config exists (when `orgId` is given) OR the deployment-wide env
 * (`RESEND_API_KEY` + `EMAIL_FROM`) is set. Both are read at CALL TIME (never
 * memoized) so tests and deploys see current state. The From (per-org or
 * `EMAIL_FROM`) must be a fully-formed From header on a Resend-verified domain,
 * e.g. `"Cosmos <invites@yourdomain.com>"`.
 */
export async function isTransactionalEmailConfigured(
  orgId?: string,
): Promise<boolean> {
  if (orgId && (await getOrgEmailConfig(orgId))) return true;
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

/**
 * Send one transactional email via Resend (global `fetch` — no SDK dependency).
 * Uses the PER-ORG sealed key + From when `orgId` resolves a usable config, else
 * the env `RESEND_API_KEY` / `EMAIL_FROM`. Throws when neither is configured, or
 * when Resend rejects the request, so callers that want a fallback (e.g. the
 * inviter's own Gmail) should guard with isTransactionalEmailConfigured() first
 * and catch around the call. The org's key is unsealed here, in-process, only at
 * send time and only to build the outbound Authorization header — never logged.
 */
export async function sendAppEmail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  orgId?: string;
}): Promise<void> {
  let apiKey: string | undefined;
  let from: string | undefined;

  if (params.orgId) {
    const orgConfig = await getOrgEmailConfig(params.orgId);
    if (orgConfig) {
      apiKey = orgConfig.apiKey;
      from = orgConfig.from;
    }
  }

  if (!apiKey || !from) {
    apiKey = process.env.RESEND_API_KEY;
    from = process.env.EMAIL_FROM;
  }

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
