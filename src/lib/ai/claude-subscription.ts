import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import {
  initiateClaudeOAuthCore,
  exchangeClaudeCodeCore,
  getClaudeTokenCore,
  refreshClaudeTokenCore,
  fetchAccountEmail,
  CLAUDE_SCOPE_INFERENCE,
  type TokenStore,
} from "@/lib/ai/claude-oauth-core";

/**
 * Per-ORG Claude-subscription OAuth (PKCE) — the cosmos-v2 port of everest's
 * per-user Supabase flow, re-homed onto Prisma + the per-org OrgAiSettings row.
 *
 * All the PKCE/token-endpoint mechanics live in the store-and-scope-parameterized
 * {@link file://./claude-oauth-core.ts}; this module is just the adapter that
 * binds it to `OrgAiSettings` (keyed by `orgId`, `CLAUDE_SCOPE_INFERENCE`).
 *
 * The OAuth tokens (access + refresh) are SEALED with the cosmos vault
 * (AES-256-GCM keyring) before they ever touch the DB. They live in the Json
 * columns OrgAiSettings.{oauthAccessToken,oauthRefreshToken} as { sealed: <str> };
 * oauthExpiresAt is a real DateTime so the egress layer can decide when to refresh.
 *
 * The egress chokepoint calls {@link getOrgClaudeToken} to obtain a usable bearer
 * token (auto-refreshing when within 5 minutes of expiry). Nothing here touches
 * cookies — the API route owns the short-lived PKCE cookie (verifier + state).
 */

/**
 * Build a {@link TokenStore} bound to a single org's `OrgAiSettings` row.
 *
 * `updatedById`, when supplied, is stamped (along with `provider`) on write —
 * this matches the ORIGINAL exchange-flow behavior. Refresh-triggered writes
 * (from {@link getOrgClaudeToken} / {@link refreshOrgClaudeToken}) omit it,
 * exactly as the pre-refactor code never touched `provider`/`updatedById` on a
 * refresh — only on an explicit (user-initiated) exchange.
 */
function makeOrgTokenStore(orgId: string, updatedById?: string): TokenStore {
  return {
    async read() {
      const settings = await prisma.orgAiSettings.findUnique({
        where: { orgId },
        select: {
          oauthAccessToken: true,
          oauthRefreshToken: true,
          oauthExpiresAt: true,
        },
      });
      if (!settings) return null;
      return {
        access: settings.oauthAccessToken,
        refresh: settings.oauthRefreshToken,
        expiresAt: settings.oauthExpiresAt,
      };
    },
    async write({ access, refresh, expiresAt }) {
      // NOT typed as Prisma.OrgAiSettingsUpdateInput: that type's fields admit
      // FieldUpdateOperationsInput variants (e.g. `provider?: string |
      // StringFieldUpdateOperationsInput`) that don't reconcile with the plain
      // CreateInput shape below when spread — a bare inferred object type keeps
      // both the `create` and `update` branches happy.
      const data = {
        oauthAccessToken: { sealed: access },
        oauthExpiresAt: expiresAt,
        ...(refresh != null ? { oauthRefreshToken: { sealed: refresh } } : {}),
        ...(updatedById !== undefined
          ? { provider: "claude-oauth", updatedById }
          : {}),
      };

      // Connecting a subscription ACTIVATES it as the org's model provider — the
      // multi-provider resolver (ai-credentials) keys off `provider`, so without
      // this the freshly-connected token would never be used.
      await prisma.orgAiSettings.upsert({
        where: { orgId },
        create: { orgId, provider: "claude-oauth", ...data },
        update: data,
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  1. Initiate OAuth — generate PKCE + authorize URL                          */
/* -------------------------------------------------------------------------- */

/**
 * Generate verifier + challenge + state and build the Claude authorize URL.
 * The CALLER persists { verifier, state } (sealed) in the PKCE cookie — this
 * lib never touches cookies.
 */
export function initiateClaudeOAuth(): {
  url: string;
  verifier: string;
  state: string;
} {
  return initiateClaudeOAuthCore(CLAUDE_SCOPE_INFERENCE);
}

/* -------------------------------------------------------------------------- */
/*  2. Exchange code for tokens                                                */
/* -------------------------------------------------------------------------- */

/**
 * Exchange the authorization code (raw `code`, `code#state`, or a full callback
 * URL) for tokens, verify state, derive the account email, then seal + upsert
 * the tokens onto the org's OrgAiSettings row.
 */
export async function exchangeClaudeCode(
  orgId: string,
  codeOrUrl: string,
  verifier: string,
  expectedState: string,
  updatedById: string,
): Promise<{ success: boolean; email?: string; error?: string }> {
  return exchangeClaudeCodeCore(
    codeOrUrl,
    verifier,
    expectedState,
    makeOrgTokenStore(orgId, updatedById),
  );
}

/* -------------------------------------------------------------------------- */
/*  3. Refresh OAuth token                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Unseal the org's refresh token, exchange it for a fresh access token, re-seal,
 * and persist. Returns the new access token, or null when there is no refresh
 * token or the refresh fails.
 */
export async function refreshOrgClaudeToken(
  orgId: string,
): Promise<string | null> {
  return refreshClaudeTokenCore(makeOrgTokenStore(orgId));
}

/* -------------------------------------------------------------------------- */
/*  4. Get usable access token (auto-refresh) — THE EGRESS ENTRY POINT         */
/* -------------------------------------------------------------------------- */

/**
 * Return a usable Claude OAuth bearer token for the org, auto-refreshing when
 * within 5 minutes of expiry. Returns null when the org has no connection or
 * the token can't be unsealed/refreshed. THIS is what the egress layer calls.
 */
export async function getOrgClaudeToken(orgId: string): Promise<string | null> {
  return getClaudeTokenCore(makeOrgTokenStore(orgId));
}

/* -------------------------------------------------------------------------- */
/*  5. Status                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Connection status for the org's Claude subscription. The email is not stored
 * separately; it's re-derived from the roles endpoint when a live token exists.
 */
export async function getClaudeSubscriptionStatus(orgId: string): Promise<{
  connected: boolean;
  email?: string | null;
  expiresAt?: string | null;
}> {
  const settings = await prisma.orgAiSettings.findUnique({
    where: { orgId },
    select: { oauthAccessToken: true, oauthExpiresAt: true },
  });

  if (!settings || settings.oauthAccessToken == null) {
    return { connected: false };
  }

  let email: string | null = null;
  const accessToken = await getOrgClaudeToken(orgId);
  if (accessToken) {
    email = await fetchAccountEmail(accessToken);
  }

  return {
    connected: true,
    email,
    expiresAt: settings.oauthExpiresAt
      ? settings.oauthExpiresAt.toISOString()
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  6. Disconnect                                                              */
/* -------------------------------------------------------------------------- */

/** Null out the OAuth fields on the org's OrgAiSettings row. */
export async function disconnectOrgClaude(
  orgId: string,
  updatedById: string,
): Promise<void> {
  await prisma.orgAiSettings.updateMany({
    where: { orgId },
    data: {
      oauthAccessToken: Prisma.DbNull,
      oauthRefreshToken: Prisma.DbNull,
      oauthExpiresAt: null,
      updatedById,
    },
  });
}
