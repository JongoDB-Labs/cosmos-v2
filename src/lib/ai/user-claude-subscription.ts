import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { sealSecret, openSecret } from "@/lib/crypto/vault";

/**
 * Per-USER Claude-subscription OAuth (PKCE) — the personal-account sibling of
 * the per-org flow in {@link file://./claude-subscription.ts}. Same Claude
 * client/endpoints/PKCE; the only difference is the store: tokens live on the
 * per-user `UserAiSettings` row instead of the per-org `OrgAiSettings` row.
 *
 * The agent's credential resolver (ai-credentials) prefers the requesting
 * user's token over the org's, so a user who connects their own Claude
 * subscription has the agent run on THEIR account wherever they are; the org
 * credential is the fallback. Resolution still happens INSIDE the single
 * CUI-blind egress chokepoint — this adds a credential SOURCE, never a second
 * egress path. Tokens are SEALED with the vault before they touch the DB.
 */

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_ROLES_URL = "https://api.anthropic.com/api/oauth/claude_cli/roles";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE = "user:inference user:profile";

const REFRESH_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/* ---- PKCE helpers (mirrors the org flow) -------------------------------- */
import crypto from "node:crypto";

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

/* ---- Sealed-token JSON helpers ------------------------------------------ */
type SealedJson = { sealed: string };

function toSealedJson(plaintext: string): SealedJson {
  return { sealed: sealSecret(plaintext) };
}
function fromSealedJson(value: unknown): string | null {
  if (
    value &&
    typeof value === "object" &&
    "sealed" in value &&
    typeof (value as { sealed: unknown }).sealed === "string"
  ) {
    try {
      return openSecret((value as SealedJson).sealed);
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const rolesRes = await fetch(CLAUDE_ROLES_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!rolesRes.ok) return null;
    const roles = (await rolesRes.json()) as { organization_name?: string };
    const orgName = roles.organization_name || "";
    const emailMatch = orgName.match(/^(.+?)(?:'s Organization)?$/);
    if (emailMatch && emailMatch[1].includes("@")) return emailMatch[1];
  } catch {
    /* non-critical */
  }
  return null;
}

/* ---- 1. Initiate -------------------------------------------------------- */

/** Generate verifier + challenge + state and build the Claude authorize URL.
 *  Identical to the org flow — the route owns the short-lived PKCE cookie. */
export function initiateUserClaudeOAuth(): {
  url: string;
  verifier: string;
  state: string;
} {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: CLAUDE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { url: `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`, verifier, state };
}

/* ---- 2. Exchange -------------------------------------------------------- */

/** Exchange the auth code for tokens and seal them onto the user's row. */
export async function exchangeUserClaudeCode(
  userId: string,
  codeOrUrl: string,
  verifier: string,
  expectedState: string,
): Promise<{ success: boolean; email?: string; error?: string }> {
  const rawInput = codeOrUrl.trim();
  let code = rawInput;
  let stateFromInput: string | null = null;

  if (rawInput.startsWith("http")) {
    try {
      const url = new URL(rawInput);
      code = url.searchParams.get("code") || "";
      stateFromInput = url.searchParams.get("state");
    } catch {
      return { success: false, error: "Invalid URL format." };
    }
  } else if (rawInput.includes("#")) {
    const hashIdx = rawInput.indexOf("#");
    code = rawInput.slice(0, hashIdx);
    stateFromInput = rawInput.slice(hashIdx + 1);
  }

  if (!code) return { success: false, error: "No authorization code found." };
  if (stateFromInput && stateFromInput !== expectedState) {
    return { success: false, error: "State mismatch. Please start again." };
  }

  try {
    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLAUDE_CLIENT_ID,
        code_verifier: verifier,
        state: expectedState,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(
        "[user-claude-subscription] Exchange failed:",
        res.status,
        errText.slice(0, 200),
      );
      return {
        success: false,
        error: `Exchange failed (${res.status}): ${errText.slice(0, 150)}`,
      };
    }

    const tokens = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiresIn = tokens.expires_in || 3600;

    if (!accessToken) {
      return { success: false, error: "No access token in response." };
    }

    const email = await fetchAccountEmail(accessToken);
    const oauthExpiresAt = new Date(Date.now() + expiresIn * 1000);

    await prisma.userAiSettings.upsert({
      where: { userId },
      create: {
        userId,
        provider: "claude-oauth",
        oauthAccessToken: toSealedJson(accessToken),
        oauthRefreshToken: refreshToken ? toSealedJson(refreshToken) : undefined,
        oauthExpiresAt,
      },
      update: {
        provider: "claude-oauth",
        oauthAccessToken: toSealedJson(accessToken),
        oauthRefreshToken: refreshToken ? toSealedJson(refreshToken) : undefined,
        oauthExpiresAt,
      },
    });

    return { success: true, email: email || undefined };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Token exchange failed",
    };
  }
}

/* ---- 3. Refresh --------------------------------------------------------- */

async function refreshUserClaudeToken(userId: string): Promise<string | null> {
  const settings = await prisma.userAiSettings.findUnique({
    where: { userId },
    select: { oauthRefreshToken: true },
  });
  const refreshToken = fromSealedJson(settings?.oauthRefreshToken);
  if (!refreshToken) return null;

  let res: Response;
  try {
    res = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const tokens = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!tokens) return null;

  const newAccessToken = tokens.access_token;
  const newRefreshToken = tokens.refresh_token || refreshToken;
  const expiresIn = tokens.expires_in || 3600;
  if (!newAccessToken) return null;

  await prisma.userAiSettings.update({
    where: { userId },
    data: {
      oauthAccessToken: toSealedJson(newAccessToken),
      oauthRefreshToken: toSealedJson(newRefreshToken),
      oauthExpiresAt: new Date(Date.now() + expiresIn * 1000),
    },
  });

  return newAccessToken;
}

/* ---- 4. Get usable token (auto-refresh) — THE EGRESS ENTRY POINT -------- */

/** Return a usable Claude OAuth bearer token for the USER, auto-refreshing
 *  within 5 min of expiry. null when the user has no connection / can't refresh. */
export async function getUserClaudeToken(userId: string): Promise<string | null> {
  const settings = await prisma.userAiSettings.findUnique({
    where: { userId },
    select: { oauthAccessToken: true, oauthExpiresAt: true },
  });
  if (!settings || settings.oauthAccessToken == null) return null;

  const expiresAtMs = settings.oauthExpiresAt
    ? settings.oauthExpiresAt.getTime()
    : 0;
  if (expiresAtMs > 0 && Date.now() > expiresAtMs - REFRESH_SKEW_MS) {
    const refreshed = await refreshUserClaudeToken(userId);
    if (refreshed) return refreshed;
  }
  return fromSealedJson(settings.oauthAccessToken);
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
