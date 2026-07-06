// NB: this module is imported by the edge-sensitive proxy (for SESSION_COOKIE),
// so it must stay dependency-light — no google-auth-library / prisma here. The
// Google login OAuth client now lives in ./google-oauth (server-only), resolving
// its credentials from the sealed AuthProviderConfig store (FR 8a162fe7).

export const SESSION_MAX_AGE_SECONDS = Number(
  process.env.SESSION_MAX_AGE_SECONDS ?? 604800,
);

export const SESSION_COOKIE = "session";
export const OAUTH_STATE_COOKIE = "oauth_state";
