import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { sealSecret, openSecret } from "@/lib/crypto/vault";

/**
 * Per-ORG Claude-subscription OAuth (PKCE) — the cosmos-v2 port of everest's
 * per-user Supabase flow, re-homed onto Prisma + the per-org OrgAiSettings row.
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

/* -------------------------------------------------------------------------- */
/*  Constants — EXACTLY as the everest reference                               */
/* -------------------------------------------------------------------------- */

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_ROLES_URL =
  "https://api.anthropic.com/api/oauth/claude_cli/roles";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE = "user:inference user:profile";

/** Refresh window: re-auth when the token is within this of expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/* -------------------------------------------------------------------------- */
/*  PKCE helpers (node:crypto, base64url) — mirrors the reference              */
/* -------------------------------------------------------------------------- */

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

/* -------------------------------------------------------------------------- */
/*  Sealed-token JSON helpers                                                  */
/* -------------------------------------------------------------------------- */

/** The shape stored in the OrgAiSettings.oauth* Json columns. */
type SealedJson = { sealed: string };

function toSealedJson(plaintext: string): SealedJson {
  return { sealed: sealSecret(plaintext) };
}

/** Read a { sealed } Json value back to plaintext, or null when absent/invalid. */
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

/* -------------------------------------------------------------------------- */
/*  Roles → account email                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Derive the connected account's email from the Claude CLI roles endpoint.
 * Non-critical: any failure yields null (the connection still works).
 */
async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const rolesRes = await fetch(CLAUDE_ROLES_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!rolesRes.ok) return null;
    const roles = (await rolesRes.json()) as { organization_name?: string };
    const orgName = roles.organization_name || "";
    const emailMatch = orgName.match(/^(.+?)(?:'s Organization)?$/);
    if (emailMatch && emailMatch[1].includes("@")) {
      return emailMatch[1];
    }
  } catch {
    /* non-critical */
  }
  return null;
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

  return {
    url: `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`,
    verifier,
    state,
  };
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
  // Extract code from input — supports:
  //   1. Full URL: https://.../callback?code=...&state=...
  //   2. Platform callback format: code#state
  //   3. Raw code string
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

  if (!code) {
    return { success: false, error: "No authorization code found." };
  }

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
        "[claude-subscription] Exchange failed:",
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

    // Connecting a subscription ACTIVATES it as the org's model provider — the
    // multi-provider resolver (ai-credentials) keys off `provider`, so without
    // this the freshly-connected token would never be used.
    await prisma.orgAiSettings.upsert({
      where: { orgId },
      create: {
        orgId,
        provider: "claude-oauth",
        oauthAccessToken: toSealedJson(accessToken),
        oauthRefreshToken: refreshToken
          ? toSealedJson(refreshToken)
          : undefined,
        oauthExpiresAt,
        updatedById,
      },
      update: {
        provider: "claude-oauth",
        oauthAccessToken: toSealedJson(accessToken),
        oauthRefreshToken: refreshToken
          ? toSealedJson(refreshToken)
          : undefined,
        oauthExpiresAt,
        updatedById,
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
  const settings = await prisma.orgAiSettings.findUnique({
    where: { orgId },
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

  await prisma.orgAiSettings.update({
    where: { orgId },
    data: {
      oauthAccessToken: toSealedJson(newAccessToken),
      oauthRefreshToken: toSealedJson(newRefreshToken),
      oauthExpiresAt: new Date(Date.now() + expiresIn * 1000),
    },
  });

  return newAccessToken;
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
  const settings = await prisma.orgAiSettings.findUnique({
    where: { orgId },
    select: { oauthAccessToken: true, oauthExpiresAt: true },
  });

  if (!settings || settings.oauthAccessToken == null) return null;

  // Refresh when within the skew window (or already expired). Tokens with no
  // recorded expiry (e.g. long-lived session tokens) skip the refresh path.
  const expiresAtMs = settings.oauthExpiresAt
    ? settings.oauthExpiresAt.getTime()
    : 0;
  if (expiresAtMs > 0 && Date.now() > expiresAtMs - REFRESH_SKEW_MS) {
    const refreshed = await refreshOrgClaudeToken(orgId);
    if (refreshed) return refreshed;
  }

  return fromSealedJson(settings.oauthAccessToken);
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
