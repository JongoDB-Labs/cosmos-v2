import { google } from "googleapis";
import { prisma } from "@/lib/db/client";
import { getUserCredential, setCredential } from "@/lib/integrations/credentials";

const GOOGLE_PROVIDER = "google";

/**
 * Resolve the org a user's Google credential is scoped under.
 *
 * Google login is NOT org-scoped (it lands on `/`, which routes to the user's org
 * or an org picker), but ConnectorCredential is keyed by (org, provider, user). We
 * scope the per-user Google token to the user's PRIMARY org — the earliest-joined
 * membership (deterministic, stable, the user's "home" org). Returns null when the
 * user has no membership yet (a brand-new self-serve signup pre-onboarding); the
 * caller then defers sealing until first authenticated use (which has an org).
 */
async function resolvePrimaryOrgId(userId: string): Promise<string | null> {
  const member = await prisma.orgMember.findFirst({
    where: { userId },
    orderBy: { joinedAt: "asc" },
    select: { orgId: true },
  });
  return member?.orgId ?? null;
}

/**
 * Persist a freshly-issued Google refresh token into the SEALED connector
 * credential store (never the plaintext `User.googleRefreshToken` column).
 *
 * Called from the OAuth callback. Scopes the token to the user's primary org. If
 * the user has no org yet, this is a no-op (returns false) — the token is still on
 * Google's side and will be sealed on first authenticated tool use via the
 * self-heal path. Best-effort: never throw into the auth callback flow.
 */
export async function storeGoogleRefreshToken(
  userId: string,
  refreshToken: string,
): Promise<boolean> {
  const orgId = await resolvePrimaryOrgId(userId);
  if (!orgId) return false;
  await setCredential(orgId, GOOGLE_PROVIDER, userId, { refreshToken });
  return true;
}

/**
 * Best-effort self-heal: seal a legacy plaintext refresh token into the connector
 * credential vault AND null the plaintext column, so existing tokens drain to
 * sealed-at-rest on first use. Non-fatal — a failure here must never break the
 * Google call that just succeeded in reading the plaintext token.
 */
async function selfHealLegacyToken(
  userId: string,
  orgId: string,
  refreshToken: string,
): Promise<void> {
  try {
    await setCredential(orgId, GOOGLE_PROVIDER, userId, { refreshToken });
    // Only null the plaintext column AFTER the sealed copy is durably stored.
    await prisma.user.update({
      where: { id: userId },
      data: { googleRefreshToken: null },
    });
  } catch (err) {
    // Self-heal is opportunistic; log without the token and carry on. The next
    // call retries the heal (the plaintext column is still readable).
    console.warn(
      "[google] self-heal of legacy refresh token failed (will retry next call)",
      { userId, orgId },
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Build an OAuth2 client preconfigured with the signed-in user's stored refresh
 * token. The token is read from the SEALED connector credential vault first; if
 * absent, it FALLS BACK to the legacy plaintext `User.googleRefreshToken` and, on
 * a successful fallback, opportunistically seals it + nulls the plaintext column
 * (self-heal — no plaintext left at rest after first use).
 *
 * The sealed lookup is USER-SCOPED (getUserCredential): a personal Google grant is
 * the user's own and works in EVERY org they belong to, so we do NOT re-narrow by the
 * current org on read (strict org-scoping would break Google in a user's non-primary
 * orgs — a regression vs the prior user-level token). `orgId` is now only used to pick
 * the storage org when self-healing a legacy plaintext token (falls back to the user's
 * primary org). Throws the existing "Google not connected" error when neither source
 * has a token (callers translate this into a graceful tool error).
 */
export async function getGoogleClientForUser(userId: string, orgId?: string) {
  let refreshToken: string | null = null;

  // 1. Sealed store first (the source of truth post-migration) — user-scoped: the
  //    user's Google grant is valid across all their orgs, regardless of orgId.
  const bundle = await getUserCredential(GOOGLE_PROVIDER, userId);
  refreshToken = bundle?.refreshToken ?? null;

  // 2. Fall back to the legacy plaintext column; self-heal on a hit.
  if (!refreshToken) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { googleRefreshToken: true },
    });
    const legacy = user?.googleRefreshToken ?? null;
    if (legacy) {
      refreshToken = legacy;
      // We can only seal under an org. When orgId wasn't supplied, resolve the
      // user's primary org so the drain still happens (no plaintext left behind).
      const healOrgId = orgId ?? (await resolvePrimaryOrgId(userId));
      if (healOrgId) {
        await selfHealLegacyToken(userId, healOrgId, legacy);
      }
    }
  }

  if (!refreshToken) {
    throw new Error("Google not connected (no refresh token on user record)");
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

export async function getCalendarClient(userId: string, orgId?: string) {
  const auth = await getGoogleClientForUser(userId, orgId);
  return google.calendar({ version: "v3", auth });
}

export async function getDriveClient(userId: string, orgId?: string) {
  const auth = await getGoogleClientForUser(userId, orgId);
  return google.drive({ version: "v3", auth });
}

export async function getGmailClient(userId: string, orgId?: string) {
  const auth = await getGoogleClientForUser(userId, orgId);
  return google.gmail({ version: "v1", auth });
}

export async function getDocsClient(userId: string, orgId?: string) {
  const auth = await getGoogleClientForUser(userId, orgId);
  return google.docs({ version: "v1", auth });
}

export async function getPeopleClient(userId: string, orgId?: string) {
  const auth = await getGoogleClientForUser(userId, orgId);
  return google.people({ version: "v1", auth });
}

export async function getMeetClient(userId: string, orgId?: string) {
  const auth = await getGoogleClientForUser(userId, orgId);
  return google.meet({ version: "v2", auth });
}
