import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import {
  initiateClaudeOAuthCore,
  exchangeClaudeCodeCore,
  getClaudeTokenCore,
  fetchAccountEmail,
  CLAUDE_SCOPE_INFERENCE,
  type TokenStore,
} from "@/lib/ai/claude-oauth-core";

/**
 * Per-USER Claude-subscription OAuth (PKCE) — the personal-account sibling of
 * the per-org flow in {@link file://./claude-subscription.ts}. Same Claude
 * client/endpoints/PKCE (both delegate to the shared
 * {@link file://./claude-oauth-core.ts}); the only difference is the store:
 * tokens live on the per-user `UserAiSettings` row instead of the per-org
 * `OrgAiSettings` row.
 *
 * The agent's credential resolver (ai-credentials) prefers the requesting
 * user's token over the org's, so a user who connects their own Claude
 * subscription has the agent run on THEIR account wherever they are; the org
 * credential is the fallback. Resolution still happens INSIDE the single
 * CUI-blind egress chokepoint — this adds a credential SOURCE, never a second
 * egress path. Tokens are SEALED with the vault before they touch the DB.
 */

/**
 * Build a {@link TokenStore} bound to a single user's `UserAiSettings` row.
 *
 * `activate`, when true, stamps `provider: "claude-oauth"` on the UPDATE branch
 * too — matching the ORIGINAL exchange-flow behavior (connecting explicitly
 * (re-)activates Claude OAuth as the provider). Refresh-triggered writes (from
 * {@link getUserClaudeToken}) pass `activate: false`, exactly as the pre-refactor
 * private `refreshUserClaudeToken` never touched `provider` on refresh — only
 * the exchange flow did. (`create` always sets it — required either way, and
 * matches the schema's own `@default("claude-oauth")`.)
 */
function makeUserTokenStore(userId: string, activate = false): TokenStore {
  return {
    async read() {
      const settings = await prisma.userAiSettings.findUnique({
        where: { userId },
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
      // NOT typed as Prisma.UserAiSettingsUpdateInput: the CHECKED update
      // variant's `user` relation field collides with the CreateInput union
      // when spread into `create` below — a bare inferred object type keeps
      // both branches happy.
      const data = {
        oauthAccessToken: { sealed: access },
        oauthExpiresAt: expiresAt,
        ...(refresh != null ? { oauthRefreshToken: { sealed: refresh } } : {}),
        ...(activate ? { provider: "claude-oauth" } : {}),
      };
      await prisma.userAiSettings.upsert({
        where: { userId },
        create: { userId, provider: "claude-oauth", ...data },
        update: data,
      });
    },
  };
}

/* ---- 1. Initiate -------------------------------------------------------- */

/** Generate verifier + challenge + state and build the Claude authorize URL.
 *  Identical to the org flow — the route owns the short-lived PKCE cookie. */
export function initiateUserClaudeOAuth(): {
  url: string;
  verifier: string;
  state: string;
} {
  return initiateClaudeOAuthCore(CLAUDE_SCOPE_INFERENCE);
}

/* ---- 2. Exchange -------------------------------------------------------- */

/** Exchange the auth code for tokens and seal them onto the user's row. */
export async function exchangeUserClaudeCode(
  userId: string,
  codeOrUrl: string,
  verifier: string,
  expectedState: string,
): Promise<{ success: boolean; email?: string; error?: string }> {
  return exchangeClaudeCodeCore(
    codeOrUrl,
    verifier,
    expectedState,
    makeUserTokenStore(userId, /* activate */ true),
  );
}

/* ---- 3+4. Get usable token (auto-refresh) — THE EGRESS ENTRY POINT ------ */

/** Return a usable Claude OAuth bearer token for the USER, auto-refreshing
 *  within 5 min of expiry. null when the user has no connection / can't refresh. */
export async function getUserClaudeToken(userId: string): Promise<string | null> {
  return getClaudeTokenCore(makeUserTokenStore(userId));
}

/* ---- 5. Status ---------------------------------------------------------- */

export async function getUserClaudeSubscriptionStatus(userId: string): Promise<{
  connected: boolean;
  email?: string | null;
  expiresAt?: string | null;
}> {
  const settings = await prisma.userAiSettings.findUnique({
    where: { userId },
    select: { oauthAccessToken: true, oauthExpiresAt: true },
  });
  if (!settings || settings.oauthAccessToken == null) return { connected: false };

  let email: string | null = null;
  const accessToken = await getUserClaudeToken(userId);
  if (accessToken) email = await fetchAccountEmail(accessToken);

  return {
    connected: true,
    email,
    expiresAt: settings.oauthExpiresAt
      ? settings.oauthExpiresAt.toISOString()
      : null,
  };
}

/* ---- 6. Disconnect ------------------------------------------------------ */

/** Null out the OAuth fields on the user's row (keeps the row for re-connect). */
export async function disconnectUserClaude(userId: string): Promise<void> {
  await prisma.userAiSettings.updateMany({
    where: { userId },
    data: {
      oauthAccessToken: Prisma.DbNull,
      oauthRefreshToken: Prisma.DbNull,
      oauthExpiresAt: null,
    },
  });
}
