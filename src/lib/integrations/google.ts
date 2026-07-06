import { google } from "googleapis";
import { prisma } from "@/lib/db/client";
import { getUserCredential, setCredential } from "@/lib/integrations/credentials";
import { resolveGoogleLoginCreds } from "@/lib/auth/google-oauth";

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
 * the user has no org yet, this is a no-op (returns false) — the token stays on
 * Google's side and is re-issued + sealed on the next OAuth grant once the user has
 * an org. Best-effort: never throw into the auth callback flow.
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
 * Build an OAuth2 client preconfigured with the signed-in user's stored refresh
 * token, read from the SEALED connector credential vault — now the SOLE source of
 * truth. The legacy plaintext `User.googleRefreshToken` column has been swept into
 * the vault (scripts/dsop/seal-google-tokens.mjs) and DROPPED (migration
 * 20260606120000_drop_google_refresh_token), so there is no plaintext fallback.
 *
 * The lookup is USER-SCOPED (getUserCredential): a personal Google grant is the
 * user's own and works in EVERY org they belong to, so we do NOT re-narrow by the
 * current org on read (strict org-scoping would break Google in a user's non-primary
 * orgs). `orgId` is accepted for call-site symmetry but no longer used here (the read
 * is user-scoped). Throws the "Google not connected" error when the user has no sealed
 * token (callers translate this into a graceful tool error).
 */
export async function getGoogleClientForUser(userId: string, _orgId?: string) {
  // The sealed store is the only source — user-scoped (valid across all the user's orgs).
  const bundle = await getUserCredential(GOOGLE_PROVIDER, userId);
  const refreshToken = bundle?.refreshToken ?? null;

  if (!refreshToken) {
    throw new Error("Google not connected (no refresh token on user record)");
  }

  // Client id/secret: sealed AuthProviderConfig store first (UI-managed), env
  // fallback (FR 8a162fe7). Same Google app as login, so one place to configure.
  const { clientId, clientSecret } = await resolveGoogleLoginCreds();
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
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
