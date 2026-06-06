import { sealSecret, openSecret, kidOf } from "@/lib/crypto/vault";

/**
 * In-place, self-healing COLUMN seal — the reusable secret-COLUMN primitive.
 *
 * Where {@link import("@/lib/crypto/vault")} is the raw envelope (seal/open a
 * string) and `credentials.ts` is the dedicated `connector_credentials` table,
 * THIS helper seals an arbitrary secret stored directly in a COLUMN, in place:
 * the column holds the `v2.<kid>.<iv>.<tag>.<ct>` envelope, we open it on read,
 * and a legacy PLAINTEXT value (pre-sealing rows) is read verbatim and can be
 * opportunistically re-sealed by the caller (self-heal / drain).
 *
 * It generalizes the v2.7.0 Google-token self-heal pattern so any column-shaped
 * secret — `webhooks.secret` (live HMAC key), `mcp_servers.env_enc` /
 * `headers_enc` (sealed JSON) — gets seal-at-rest with a transparent read.
 *
 * Gov posture (SC-28 / 800-171 3.13.16 protect-at-rest; IA-5; 3.5.10):
 *   - The sealed form is the SAME rotatable keyring envelope, so
 *     scripts/dsop/rotate-vault-key.mjs re-wraps these columns on a key rotation
 *     (add them to SEALED_COLUMNS).
 *   - `openField` is TRANSPARENT to the plaintext: for a given secret, the opened
 *     value is byte-identical whether the column held the plaintext (legacy) or a
 *     sealed envelope — so a downstream consumer (e.g. webhook HMAC) is unaffected.
 *   - We NEVER log the opened plaintext.
 */

/**
 * Is `stored` a vault envelope (sealed), vs a legacy plaintext value?
 *
 * Defensive structural check: it must START with a known version prefix AND have
 * the matching part count (`v2.` → 5 parts, `v1.` → 4 parts), then `kidOf` must
 * parse it (validates the kid charset for v2). A plaintext secret that merely
 * begins "v2." but isn't a real envelope (wrong part count / bad kid) is treated
 * as plaintext — `openField` returns it verbatim rather than throwing.
 */
export function isSealed(stored: string): boolean {
  if (typeof stored !== "string") return false;
  const parts = stored.split(".");
  const looksSealed =
    (parts[0] === "v2" && parts.length === 5) ||
    (parts[0] === "v1" && parts.length === 4);
  if (!looksSealed) return false;
  try {
    // kidOf re-validates the envelope shape + kid charset; if it parses, it's sealed.
    kidOf(stored);
    return true;
  } catch {
    return false;
  }
}

/** Seal a plaintext field value under the active keyring kid (the v2 envelope). */
export function sealField(plaintext: string): string {
  return sealSecret(plaintext);
}

/**
 * Open a stored field value back to plaintext.
 *   - If it's a vault envelope ({@link isSealed}) → {@link openSecret} it.
 *   - Else it's a LEGACY plaintext value (a row written before sealing) → return
 *     it verbatim. (Self-healing the legacy value back to sealed is the caller's
 *     job on read — use {@link openFieldWithHeal} for that.)
 *
 * Transparent to the plaintext: the returned value is identical whether the
 * column held the plaintext or its sealed envelope.
 */
export function openField(stored: string): string {
  return isSealed(stored) ? openSecret(stored) : stored;
}

/**
 * Open a stored field value AND, if it was legacy plaintext, opportunistically
 * re-seal it: calls `resealCb(sealField(plaintext))` so the caller can persist
 * the sealed form (drain the plaintext to sealed-at-rest). Best-effort — a
 * failure in `resealCb` is swallowed (the open already succeeded; the next read
 * retries the heal), so a heal failure never breaks the consumer that needs the
 * opened value (e.g. an in-flight webhook HMAC).
 *
 * Returns the opened plaintext (identical to {@link openField}). The reseal fires
 * ONLY when the stored value was legacy plaintext, never when it was already sealed.
 */
export async function openFieldWithHeal(
  stored: string,
  resealCb: (sealed: string) => void | Promise<void>,
): Promise<string> {
  if (isSealed(stored)) {
    return openSecret(stored);
  }
  // Legacy plaintext: return verbatim, and best-effort re-seal + persist.
  try {
    await resealCb(sealField(stored));
  } catch {
    // Heal is opportunistic; the plaintext column is still readable on the next
    // call. Never throw into the consumer. (We do NOT log — would leak the secret.)
  }
  return stored;
}
