import { createHash, timingSafeEqual } from "node:crypto";
import { sealSecret, openSecret } from "@/lib/crypto/vault";

/**
 * Self-service password-reset tokens for email/password accounts.
 *
 * The token is STATELESS — a vault-sealed (AES-256-GCM, authenticated) JSON
 * payload, no DB table. Two security properties fall out of a fingerprint of the
 * user's CURRENT credential state (passwordHash + passwordSetAt) baked into the
 * token:
 *   - SINGLE-USE: completing a reset rotates passwordHash, so the fingerprint no
 *     longer matches and the token (and any other outstanding reset token) is
 *     dead. There is nothing to "mark as used" — the credential change is the
 *     invalidation.
 *   - EXPIRY: a signed `exp` timestamp; a token past it is rejected.
 * Any tamper of the payload fails the GCM authentication tag on open.
 *
 * The sealed envelope is base64url-wrapped so it rides safely in a URL query.
 */

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

interface ResetPayload {
  v: 1;
  uid: string;
  fp: string;
  exp: number;
}

type CredentialState = {
  passwordHash: string | null;
  passwordSetAt: Date | null;
};

/**
 * A short, non-reversible fingerprint of the user's current credential state.
 * Changes the instant the password (or its set-at timestamp) changes — which is
 * what makes an issued reset token single-use.
 */
export function resetFingerprint(user: CredentialState): string {
  return createHash("sha256")
    .update(`${user.passwordHash ?? ""}|${user.passwordSetAt?.getTime() ?? 0}`)
    .digest("hex")
    .slice(0, 32);
}

/** Mint a signed, single-use, time-limited reset token for a user. */
export function createPasswordResetToken(
  user: { id: string } & CredentialState,
  opts?: { now?: number; ttlMs?: number },
): string {
  const now = opts?.now ?? Date.now();
  const payload: ResetPayload = {
    v: 1,
    uid: user.id,
    fp: resetFingerprint(user),
    exp: now + (opts?.ttlMs ?? RESET_TTL_MS),
  };
  return Buffer.from(sealSecret(JSON.stringify(payload))).toString("base64url");
}

/**
 * Decode + authenticate a token and check its expiry. Returns the userId and the
 * embedded fingerprint on success, or null when the token is malformed, tampered,
 * or expired. The caller MUST still confirm the fingerprint matches the user's
 * CURRENT credential state (via {@link resetFingerprint} + {@link fingerprintMatches})
 * to enforce single-use before acting on it.
 */
export function parsePasswordResetToken(
  token: string,
  opts?: { now?: number },
): { uid: string; fp: string } | null {
  const now = opts?.now ?? Date.now();
  let payload: ResetPayload;
  try {
    const sealed = Buffer.from(token, "base64url").toString("utf8");
    payload = JSON.parse(openSecret(sealed)) as ResetPayload;
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.uid !== "string" || typeof payload.fp !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  return { uid: payload.uid, fp: payload.fp };
}

/** Constant-time comparison of two credential-state fingerprints. */
export function fingerprintMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
