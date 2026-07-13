import crypto from "node:crypto";
import { sealSecret, openSecret } from "@/lib/crypto/vault";

/**
 * Shared Claude OAuth PKCE core — the store-and-scope-parameterized engine
 * behind {@link file://./claude-subscription.ts} (per-org, `OrgAiSettings`) and
 * {@link file://./user-claude-subscription.ts} (per-user, `UserAiSettings`).
 * Extracted so a THIRD caller (Foreman's own dedicated Claude connection) can
 * reuse the exact same PKCE/token-endpoint logic with a broader scope and a
 * different backing store, without re-duplicating any of it a third time.
 *
 * This module knows NOTHING about prisma or which DB row backs a connection —
 * callers hand it a {@link TokenStore} (read the current sealed row / write a
 * freshly sealed one) and it does the OAuth mechanics: PKCE generation, the
 * authorize URL, the code↔token exchange, refresh, and the auto-refreshing
 * "get me a usable bearer token" entry point.
 *
 * Tokens are SEALED with the cosmos vault (AES-256-GCM keyring) before they are
 * ever handed to a store — {@link TokenStore.write}'s `access`/`refresh` fields
 * are already-sealed ciphertext strings, and {@link TokenStore.read}'s fields
 * are the raw (`{ sealed: <str> }`-shaped) Json values as persisted, which this
 * module unseals. Nothing here touches cookies — the caller (API route) owns
 * the short-lived PKCE cookie (verifier + state).
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

/** The narrow scope claude-subscription.ts / user-claude-subscription.ts use today. */
export const CLAUDE_SCOPE_INFERENCE = "user:inference user:profile";
/** Broader scope (adds Claude Code session access) for the Foreman connection. */
export const CLAUDE_SCOPE_CODE =
  "user:inference user:profile user:sessions:claude_code";

/** Refresh window: re-auth when the token is within this of expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/* -------------------------------------------------------------------------- */
/*  Store + config contracts                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The persistence seam a caller binds to its own backing row (OrgAiSettings,
 * UserAiSettings, ForemanAiSettings, ...). `read()` returns the raw Json column
 * values (whatever shape they were persisted in — this module unseals them via
 * {@link fromSealedJson}) plus the expiry DateTime, or `null` when there's no
 * row/connection yet. `write()` receives ALREADY-SEALED ciphertext strings (the
 * caller's adapter is responsible for shaping them into its own column format,
 * e.g. wrapping as `{ sealed: <str> }` to match the existing on-disk shape).
 */
export interface TokenStore {
  read(): Promise<{
    access: unknown;
    refresh: unknown;
    expiresAt: Date | null;
  } | null>;
  write(sealed: {
    access: string;
    refresh: string | null;
    expiresAt: Date;
  }): Promise<void>;
}

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

/** The `{ sealed }` shape callers persist into their Json columns. */
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
 * Non-critical: any failure yields null (the connection still works). Shared
 * by the org/user status endpoints (and available to a future Foreman one).
 */
export async function fetchAccountEmail(
  accessToken: string,
): Promise<string | null> {
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
 * Generate verifier + challenge + state and build the Claude authorize URL for
 * the given `scope`. The CALLER persists { verifier, state } (sealed) in the
 * PKCE cookie — this module never touches cookies.
 */
export function initiateClaudeOAuthCore(scope: string): {
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
    scope,
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
 * URL) for tokens, verify state, derive the account email, then seal + persist
 * the tokens onto the caller's store.
 */
export async function exchangeClaudeCodeCore(
  codeOrUrl: string,
  verifier: string,
  expectedState: string,
  store: TokenStore,
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
        "[claude-oauth-core] Exchange failed:",
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
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await store.write({
      access: toSealedJson(accessToken).sealed,
      refresh: refreshToken ? toSealedJson(refreshToken).sealed : null,
      expiresAt,
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
 * Unseal the store's refresh token, exchange it for a fresh access token,
 * re-seal, and persist. Returns the new access token, or null when there is no
 * refresh token or the refresh fails.
 */
export async function refreshClaudeTokenCore(
  store: TokenStore,
): Promise<string | null> {
  const row = await store.read();
  const refreshToken = fromSealedJson(row?.refresh);
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

  await store.write({
    access: toSealedJson(newAccessToken).sealed,
    refresh: toSealedJson(newRefreshToken).sealed,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  });

  return newAccessToken;
}

/* -------------------------------------------------------------------------- */
/*  4. Get usable access token (auto-refresh) — THE EGRESS ENTRY POINT         */
/* -------------------------------------------------------------------------- */

/**
 * Return a usable Claude OAuth bearer token from the store, auto-refreshing
 * when within 5 minutes of expiry. Returns null when there's no connection or
 * the token can't be unsealed/refreshed. THIS is what the egress layer calls
 * (indirectly, via each caller's own get-token wrapper).
 */
export async function getClaudeTokenCore(
  store: TokenStore,
): Promise<string | null> {
  const row = await store.read();
  if (!row || row.access == null) return null;

  // Refresh when within the skew window (or already expired). Tokens with no
  // recorded expiry (e.g. long-lived session tokens) skip the refresh path.
  const expiresAtMs = row.expiresAt ? row.expiresAt.getTime() : 0;
  if (expiresAtMs > 0 && Date.now() > expiresAtMs - REFRESH_SKEW_MS) {
    const refreshed = await refreshClaudeTokenCore(store);
    if (refreshed) return refreshed;
  }

  return fromSealedJson(row.access);
}

/**
 * Like {@link getClaudeTokenCore}, but returns the FULL credential triple —
 * unsealed access + refresh tokens and the expiry as epoch MILLISECONDS —
 * auto-refreshing within the skew window. This is what the Agent SDK's native
 * auth needs to write a `.credentials.json` (`claudeAiOauth`): the access token
 * alone isn't enough, the runtime refreshes on its own from the refresh token +
 * expiry. Returns null when there's no connection or the access token can't be
 * unsealed. After a refresh it re-reads the store so the returned refresh token
 * and expiry are the freshly-persisted ones, not the pre-refresh row's.
 */
export async function getClaudeCredsCore(
  store: TokenStore,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number } | null> {
  let row = await store.read();
  if (!row || row.access == null) return null;

  const expiresAtMs = row.expiresAt ? row.expiresAt.getTime() : 0;
  if (expiresAtMs > 0 && Date.now() > expiresAtMs - REFRESH_SKEW_MS) {
    const refreshed = await refreshClaudeTokenCore(store);
    if (refreshed) row = (await store.read()) ?? row;
  }

  const accessToken = fromSealedJson(row.access);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: fromSealedJson(row.refresh),
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : 0,
  };
}
