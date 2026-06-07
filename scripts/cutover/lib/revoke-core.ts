// scripts/cutover/lib/revoke-core.ts
//
// PURE core for the provider-side Google OAuth token revoke (cutover finisher §9.3-5).
//
// The cutover is COPY-not-move: a migrated Google refresh token stays LIVE at Google after
// the flip (v1 keeps it as a rollback target during soak). Once the flip is permanent, the
// token must be revoked at the provider so a copied credential can't be used from the
// decommissioned v1. This module is the side-effect-free unit the CLI
// (revoke-google-tokens.mjs) wraps around a DB read + a vault open:
//
//   - revokeOneToken(refreshToken, fetchImpl) → POSTs the Google revoke endpoint and maps
//     the response to a stable result. IDEMPOTENT: a 200 is "revoked"; an already-revoked
//     token returns 400 invalid_token, which we treat as "already-revoked" (success). Any
//     other status is "failed" (retryable). The fetch is INJECTED so tests never hit real
//     Google.
//
// HARD invariant: the refresh token is NEVER returned, logged, or placed in any result/error
// field. The result carries only a status + http code + a non-secret error string.

/** The Google OAuth2 token-revocation endpoint. */
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** A minimal fetch-like contract — only what revokeOneToken needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string> },
) => Promise<{ status: number; text: () => Promise<string> }>;

/** The outcome of revoking one token. NEVER contains the token. */
export interface RevokeResult {
  /**
   * - "revoked"          — Google accepted the revoke (HTTP 200).
   * - "already-revoked"  — the token was already invalid (HTTP 400 invalid_token) ⇒ idempotent success.
   * - "failed"           — any other response (retryable; do NOT treat as done).
   */
  status: "revoked" | "already-revoked" | "failed";
  /** The HTTP status Google returned (or 0 if the request itself threw). */
  httpStatus: number;
  /** A NON-SECRET error/detail string for the "failed" (or informative) case. Never the token. */
  detail?: string;
}

/** True if the revoke result is a terminal success (revoked OR already-revoked). */
export function isRevokeSuccess(r: RevokeResult): boolean {
  return r.status === "revoked" || r.status === "already-revoked";
}

/**
 * Build the revoke URL for a token. The token is a query param per Google's API. We
 * `encodeURIComponent` it so it can't break out of the query. (The URL is used ONLY for the
 * request — it is never logged; callers log {@link GOOGLE_REVOKE_ENDPOINT} without the token.)
 */
export function buildRevokeUrl(refreshToken: string): string {
  return `${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`;
}

/**
 * Revoke ONE refresh token at Google via the injected fetch. Maps the response:
 *   - 200            ⇒ { status: "revoked" }
 *   - 400 + body mentions "invalid_token" (or any 400 — an already-revoked/expired token is the
 *     realistic 400 here) ⇒ { status: "already-revoked" }  (IDEMPOTENT success)
 *   - anything else  ⇒ { status: "failed", detail }
 *   - a thrown fetch ⇒ { status: "failed", httpStatus: 0, detail }
 *
 * NEVER logs or returns the token. `detail` carries only the (already non-secret) Google
 * error code / a network error message.
 */
export async function revokeOneToken(
  refreshToken: string,
  fetchImpl: FetchLike,
): Promise<RevokeResult> {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    return { status: "failed", httpStatus: 0, detail: "empty/absent refresh token in the sealed bundle" };
  }

  let res: { status: number; text: () => Promise<string> };
  try {
    res = await fetchImpl(buildRevokeUrl(refreshToken), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (e) {
    return { status: "failed", httpStatus: 0, detail: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 200) {
    return { status: "revoked", httpStatus: 200 };
  }

  // An already-revoked / expired token is Google's documented 400 invalid_token. Treat any
  // 400 as already-done (idempotent) — the token is not usable either way; surface the code.
  if (res.status === 400) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* body is best-effort; the 400 alone is enough to treat as already-revoked */
    }
    const code = body.includes("invalid_token") ? "invalid_token" : "http_400";
    return { status: "already-revoked", httpStatus: 400, detail: code };
  }

  let body = "";
  try {
    body = await res.text();
  } catch {
    /* best-effort */
  }
  // Truncate the detail defensively; it is Google's error JSON (no token), but keep it small.
  return { status: "failed", httpStatus: res.status, detail: body.slice(0, 200) || `http_${res.status}` };
}
