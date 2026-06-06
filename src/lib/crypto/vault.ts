import crypto from "node:crypto";

/**
 * Symmetric secret vault — the reusable secret-sealing primitive for cosmos.
 *
 * Seals plaintext secrets (OIDC client secrets first; connector creds next)
 * with AES-256-GCM under a single master key supplied via the
 * `SSO_VAULT_KEY` environment variable (a 32-byte key, base64-encoded;
 * injected as a Docker secret / env in prod). GCM gives us authenticated
 * encryption — any tamper of the ciphertext or tag fails the open.
 *
 * Sealed format (all components base64): `v1.<iv>.<tag>.<ciphertext>`
 *   - v1   version tag (lets us rotate the scheme later without ambiguity)
 *   - iv   12-byte random nonce (GCM standard)
 *   - tag  16-byte GCM authentication tag
 *   - ct   the encrypted secret
 *
 * The master key is read at call time (not module load) so tests and key
 * rotation see the current env without a process restart.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce: the recommended size for GCM
const KEY_BYTES = 32; // AES-256

/**
 * Load + validate the master key. Throws a clear, actionable error when the
 * key is missing or the wrong length — fail loud, never silently downgrade.
 */
function masterKey(): Buffer {
  const raw = process.env.SSO_VAULT_KEY;
  if (!raw) {
    throw new Error(
      "SSO_VAULT_KEY is not set. The vault requires a 32-byte base64 master key " +
        "(generate one with: `openssl rand -base64 32`).",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("SSO_VAULT_KEY is not valid base64.");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SSO_VAULT_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
        "Generate one with: `openssl rand -base64 32`.",
    );
  }
  return key;
}

/** Seal a plaintext secret into a `v1.<iv>.<tag>.<ct>` envelope. */
export function sealSecret(plaintext: string): string {
  const key = masterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

/**
 * Open a sealed envelope back to plaintext. Throws when the envelope is
 * malformed, has an unknown version, or fails GCM authentication (tampered
 * ciphertext/tag, or wrong key).
 */
export function openSecret(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed sealed secret: expected v1.<iv>.<tag>.<ct>.");
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(`Unsupported sealed-secret format/version: ${version}.`);
  }
  const key = masterKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // decipher.final() throws if the GCM tag doesn't authenticate.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}
