import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { sealSecret } from "@/lib/crypto/vault";
import {
  initiateClaudeOAuthCore,
  exchangeClaudeCodeCore,
  getClaudeTokenCore,
  getClaudeCredsCore,
  fetchAccountEmail,
  CLAUDE_SCOPE_CODE,
  type TokenStore,
} from "@/lib/ai/claude-oauth-core";

/**
 * Foreman's OWN per-org Claude subscription OAuth (PKCE) — distinct from the
 * org's general-purpose provider config in {@link file://./claude-subscription.ts}
 * (`OrgAiSettings`). This gives the autonomous-delivery daemon a dedicated
 * connection so its usage doesn't consume a human seat's token, and requests
 * the BROADER {@link CLAUDE_SCOPE_CODE} scope (adds Claude Code session
 * access) rather than the org/user modules' `CLAUDE_SCOPE_INFERENCE` — the
 * Agent SDK needs the claude_code session scope to run.
 *
 * All the PKCE/token-endpoint mechanics live in the store-and-scope-parameterized
 * {@link file://./claude-oauth-core.ts}; this module is just the adapter that
 * binds it to `ForemanAiSettings` (keyed by `orgId`, `CLAUDE_SCOPE_CODE`).
 *
 * The OAuth tokens (access + refresh) are SEALED with the cosmos vault
 * (AES-256-GCM keyring) before they ever touch the DB. They live in the Json
 * columns ForemanAiSettings.{oauthAccessToken,oauthRefreshToken} as
 * { sealed: <str> }; oauthExpiresAt is a real DateTime so the egress layer
 * can decide when to refresh. Nothing here touches cookies — the API route
 * owns the short-lived PKCE cookie (verifier + state).
 */

/**
 * Build a {@link TokenStore} bound to a single org's `ForemanAiSettings` row.
 *
 * `updatedById`, when supplied, is stamped (along with `provider`) on write —
 * matching {@link file://./claude-subscription.ts}'s `makeOrgTokenStore`
 * convention: the explicit (user-initiated) exchange stamps both; a
 * refresh-triggered write (from {@link getForemanClaudeToken}'s auto-refresh)
 * omits `updatedById` and leaves any existing stamp untouched.
 */
function makeForemanTokenStore(orgId: string, updatedById?: string): TokenStore {
  return {
    async read() {
      const settings = await prisma.foremanAiSettings.findUnique({
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
      // NOT typed as Prisma.ForemanAiSettingsUpdateInput: as with the org/user
      // adapters, that type's FieldUpdateOperationsInput variants don't
      // reconcile with the plain CreateInput shape when spread into both
      // upsert() branches — a bare inferred object type keeps both happy.
      const data = {
        oauthAccessToken: { sealed: access },
        oauthExpiresAt: expiresAt,
        ...(refresh != null ? { oauthRefreshToken: { sealed: refresh } } : {}),
        ...(updatedById !== undefined
          ? { provider: "claude-oauth", updatedById }
          : {}),
      };

      await prisma.foremanAiSettings.upsert({
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
 * Generate verifier + challenge + state and build the Claude authorize URL,
 * requesting the broader `CLAUDE_SCOPE_CODE` scope. The CALLER persists
 * { verifier, state } (sealed) in the PKCE cookie — this lib never touches
 * cookies.
 */
export function initiateForemanClaudeOAuth(): {
  url: string;
  verifier: string;
  state: string;
} {
  return initiateClaudeOAuthCore(CLAUDE_SCOPE_CODE);
}

/* -------------------------------------------------------------------------- */
/*  2. Exchange code for tokens                                                */
/* -------------------------------------------------------------------------- */

/**
 * Exchange the authorization code (raw `code`, `code#state`, or a full callback
 * URL) for tokens, verify state, derive the account email, then seal + upsert
 * the tokens onto the org's ForemanAiSettings row.
 */
export async function exchangeForemanClaudeCode(
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
    makeForemanTokenStore(orgId, updatedById),
  );
}

/* -------------------------------------------------------------------------- */
/*  3. Get usable access token (auto-refresh) — THE EGRESS ENTRY POINT         */
/* -------------------------------------------------------------------------- */

/**
 * Return a usable Claude OAuth bearer token for Foreman's own connection on
 * this org, auto-refreshing when within 5 minutes of expiry. Returns null when
 * the org has no connection or the token can't be unsealed/refreshed.
 */
export async function getForemanClaudeToken(orgId: string): Promise<string | null> {
  return getClaudeTokenCore(makeForemanTokenStore(orgId));
}

/**
 * The FULL credential triple (access + refresh + expiry-ms) for Foreman's own
 * connection on this org, auto-refreshing like {@link getForemanClaudeToken}.
 * Returns null when the org has no connection or the token can't be
 * unsealed/refreshed. This is what runAgent materializes into the Agent SDK's
 * `.credentials.json` (via {@link file://../foreman/foreman-creds.ts}) so the
 * agent authenticates as this org's subscription — the access token alone isn't
 * enough, the SDK refreshes from the refresh token + expiry on its own.
 */
export async function getForemanClaudeCreds(
  orgId: string,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number } | null> {
  return getClaudeCredsCore(makeForemanTokenStore(orgId));
}

/* -------------------------------------------------------------------------- */
/*  4. Status                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Connection status for Foreman's Claude subscription on this org. The email
 * is not stored separately; it's re-derived from the roles endpoint when a
 * live token exists.
 */
export async function getForemanClaudeStatus(orgId: string): Promise<{
  connected: boolean;
  email?: string | null;
  expiresAt?: string | null;
}> {
  const settings = await prisma.foremanAiSettings.findUnique({
    where: { orgId },
    select: { oauthAccessToken: true, oauthExpiresAt: true },
  });

  if (!settings || settings.oauthAccessToken == null) {
    return { connected: false };
  }

  let email: string | null = null;
  const accessToken = await getForemanClaudeToken(orgId);
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
/*  5. Disconnect                                                              */
/* -------------------------------------------------------------------------- */

/** Null out the OAuth fields on the org's ForemanAiSettings row. */
export async function disconnectForemanClaude(orgId: string): Promise<void> {
  await prisma.foremanAiSettings.updateMany({
    where: { orgId },
    data: {
      oauthAccessToken: Prisma.DbNull,
      oauthRefreshToken: Prisma.DbNull,
      oauthExpiresAt: null,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  6. Persist a mid-run rotated credential triple                            */
/* -------------------------------------------------------------------------- */

/**
 * Seal + persist a credential triple straight onto the org's ForemanAiSettings
 * row, bypassing the PKCE/refresh mechanics entirely. This is for the ONE
 * caller that already holds a live, unsealed triple it didn't get from
 * {@link getForemanClaudeToken}/{@link getForemanClaudeCreds}: runAgent's
 * `finally`, when the Agent SDK has rotated the access token mid-run by
 * refreshing on its own (writing straight to the materialized
 * `.credentials.json` — see {@link file://../foreman/foreman-creds.ts}) — that
 * fresh token would otherwise be discarded with the throwaway HOME, letting
 * the DB's refresh token go stale over time. Reuses {@link makeForemanTokenStore}
 * so the on-disk shape (sealed Json, `{ sealed: <str> }`) and the write
 * semantics (an unstamped `updatedById` — this is a refresh, not a
 * user-initiated exchange) exactly match every other write path here.
 */
export async function persistForemanClaudeCreds(
  orgId: string,
  creds: { accessToken: string; refreshToken: string | null; expiresAt: number },
): Promise<void> {
  await makeForemanTokenStore(orgId).write({
    access: sealSecret(creds.accessToken),
    refresh: creds.refreshToken != null ? sealSecret(creds.refreshToken) : null,
    expiresAt: new Date(creds.expiresAt),
  });
}
