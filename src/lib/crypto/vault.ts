import crypto from "node:crypto";

/**
 * Symmetric secret vault — the reusable secret-sealing primitive for cosmos.
 *
 * Seals plaintext secrets (OIDC client secrets first; connector creds next)
 * with AES-256-GCM under a KEYRING of 32-byte master keys. GCM gives us
 * authenticated encryption — any tamper of the ciphertext or tag fails the open.
 *
 * ── Keyring (IA-5 / SC 3.13.10 — establish + manage cryptographic keys) ──
 * A single master key cannot be rotated without re-encrypting every sealed
 * secret first, so the vault holds MULTIPLE keys ("keyring"), each addressed by
 * a short, stable `kid` (key id). New secrets are sealed under the ACTIVE kid;
 * old secrets stay openable under their original kid until a re-wrap migrates
 * them to the active kid (see {@link rewrapSecret} + scripts/dsop/rotate-vault-key.mjs).
 * This gives a zero-downtime rotate-then-retire cycle: add new key → set active →
 * re-wrap all → drop old key.
 *
 * Env (read at call time, never at module load — tests + rotation see current env):
 *   - `SSO_VAULT_KEYS`       (optional) JSON `{"<kid>":"<base64 32-byte key>", ...}` — the full ring.
 *   - `SSO_VAULT_ACTIVE_KID` (optional) the kid NEW secrets seal under; MUST be in the ring.
 *   - `SSO_VAULT_KEY`        (legacy) a single 32-byte base64 key. BACKWARD COMPAT: when
 *                            `SSO_VAULT_KEYS` is unset but `SSO_VAULT_KEY` is set, the ring is
 *                            synthesized as `{ "v1": <SSO_VAULT_KEY> }` with active kid `v1`.
 *                            Existing single-key deployments keep working with ZERO config change,
 *                            and existing `v1.<iv>.<tag>.<ct>` blobs still open.
 *
 * ── Sealed formats (all components base64 except the literal version + kid) ──
 *   v2.<kid>.<iv>.<tag>.<ct>   (current) — 5 parts; <kid> selects the ring key.
 *   v1.<iv>.<tag>.<ct>         (legacy)  — 4 parts, no kid; opened with ring key `v1`.
 *     - iv   12-byte random nonce (GCM standard)
 *     - tag  16-byte GCM authentication tag
 *     - ct   the encrypted secret
 *
 * A KMS/HSM key source slots in behind this same interface later (a future `kms`
 * loader returns the ring) — the envelope + dispatch don't change. (DEFERRED.)
 */

const V1 = "v1";
const V2 = "v2";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce: the recommended size for GCM
const KEY_BYTES = 32; // AES-256
const LEGACY_KID = "v1"; // the legacy SSO_VAULT_KEY is registered under this kid
const KID_RE = /^[A-Za-z0-9_-]+$/; // kid charset — it goes in the envelope + JSON object keys

/** The resolved keyring: the full set of keys + which kid seals new secrets. */
interface Keyring {
  keys: Map<string, Buffer>;
  active: string;
}

/** Decode a base64 string to a Buffer that MUST be exactly 32 bytes, or throw loudly. */
function decodeKey(b64: string, label: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(b64, "base64");
  } catch {
    throw new Error(`${label} is not valid base64.`);
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${label} must decode to exactly 32 bytes (got ${key.length}). ` +
        "Generate one with: `openssl rand -base64 32`.",
    );
  }
  return key;
}

/**
 * Load + validate the keyring from env (at call time). Two modes:
 *   1. Keyring mode  — `SSO_VAULT_KEYS` (JSON) + `SSO_VAULT_ACTIVE_KID`.
 *   2. Legacy mode   — only `SSO_VAULT_KEY` → ring `{ v1: <key> }`, active `v1`.
 * Fails loud (never silently downgrades) when keys are missing, malformed, the
 * wrong length, or the active kid isn't present in the ring.
 */
function loadKeyring(): Keyring {
  const ringJson = process.env.SSO_VAULT_KEYS;

  // ── Keyring mode ──
  if (ringJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ringJson);
    } catch {
      throw new Error("SSO_VAULT_KEYS is not valid JSON (expected {\"<kid>\":\"<base64 32-byte key>\"}).");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error('SSO_VAULT_KEYS must be a JSON object: {"<kid>":"<base64 32-byte key>", ...}.');
    }
    const keys = new Map<string, Buffer>();
    for (const [kid, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!KID_RE.test(kid)) {
        throw new Error(`SSO_VAULT_KEYS has an invalid kid "${kid}" — allowed charset is [A-Za-z0-9_-].`);
      }
      if (typeof value !== "string") {
        throw new Error(`SSO_VAULT_KEYS["${kid}"] must be a base64 string.`);
      }
      keys.set(kid, decodeKey(value, `SSO_VAULT_KEYS["${kid}"]`));
    }
    if (keys.size === 0) {
      throw new Error("SSO_VAULT_KEYS is empty — the keyring needs at least one key.");
    }
    const active = process.env.SSO_VAULT_ACTIVE_KID;
    if (!active) {
      throw new Error(
        "SSO_VAULT_ACTIVE_KID is not set. When SSO_VAULT_KEYS is provided you must name the " +
          "active kid (the key new secrets seal under) — it must be one of the ring's kids.",
      );
    }
    if (!keys.has(active)) {
      throw new Error(
        `SSO_VAULT_ACTIVE_KID="${active}" is not present in SSO_VAULT_KEYS. ` +
          `Available kids: ${[...keys.keys()].join(", ")}.`,
      );
    }
    return { keys, active };
  }

  // ── Legacy (backward-compat) mode: synthesize ring { v1: SSO_VAULT_KEY } ──
  const raw = process.env.SSO_VAULT_KEY;
  if (!raw) {
    throw new Error(
      "No vault keys configured. Set SSO_VAULT_KEYS (JSON keyring) + SSO_VAULT_ACTIVE_KID, " +
        "or the legacy single SSO_VAULT_KEY (a 32-byte base64 key; generate with " +
        "`openssl rand -base64 32`).",
    );
  }
  const keys = new Map<string, Buffer>([[LEGACY_KID, decodeKey(raw, "SSO_VAULT_KEY")]]);
  return { keys, active: LEGACY_KID };
}

/** Look up a key in the ring by kid, or throw a clear "retired key" error. */
function keyForKid(ring: Keyring, kid: string): Buffer {
  const key = ring.keys.get(kid);
  if (!key) {
    throw new Error(
      `Vault key "${kid}" is not in the keyring — it may have been retired. ` +
        `Available kids: ${[...ring.keys.keys()].join(", ") || "(none)"}. ` +
        "Re-wrap secrets to the active kid before retiring an old key.",
    );
  }
  return key;
}

/** Seal a plaintext with a specific key under the v2 envelope. */
function sealWith(kid: string, key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    V2,
    kid,
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

/** Decrypt the (iv, tag, ct) triple under a given key, or throw on GCM auth failure. */
function openWith(key: Buffer, ivB64: string, tagB64: string, ctB64: string): string {
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // decipher.final() throws if the GCM tag doesn't authenticate.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Parse the kid a sealed value is bound to, without decrypting.
 *   - `v2.<kid>....`  → `<kid>`
 *   - `v1.<iv>....`   → `"v1"` (legacy blobs are conceptually sealed under kid v1)
 * Throws on a malformed or unknown-version envelope (same as openSecret).
 */
export function kidOf(sealed: string): string {
  const parts = sealed.split(".");
  if (parts[0] === V2) {
    if (parts.length !== 5) {
      throw new Error("Malformed sealed secret: expected v2.<kid>.<iv>.<tag>.<ct>.");
    }
    const kid = parts[1];
    if (!KID_RE.test(kid)) {
      throw new Error(`Malformed sealed secret: invalid kid "${kid}".`);
    }
    return kid;
  }
  if (parts[0] === V1) {
    if (parts.length !== 4) {
      throw new Error("Malformed sealed secret: expected v1.<iv>.<tag>.<ct>.");
    }
    return LEGACY_KID;
  }
  throw new Error(`Unsupported sealed-secret format/version: ${parts[0]}.`);
}

/** The kid that {@link sealSecret} currently seals new secrets under. */
export function activeKid(): string {
  return loadKeyring().active;
}

/** Seal a plaintext secret under the ACTIVE keyring kid (current `v2` envelope). */
export function sealSecret(plaintext: string): string {
  const ring = loadKeyring();
  return sealWith(ring.active, keyForKid(ring, ring.active), plaintext);
}

/**
 * Open a sealed envelope back to plaintext. Dispatches on version:
 *   - `v2` (5 parts): look up `<kid>` in the ring (throws "retired key" if absent).
 *   - `v1` (4 parts): open with ring key `v1` (the legacy SSO_VAULT_KEY in compat mode).
 * Throws when the envelope is malformed, has an unknown version, references a kid
 * not in the ring, or fails GCM authentication (tampered ct/tag, or wrong key).
 */
export function openSecret(sealed: string): string {
  const ring = loadKeyring();
  const parts = sealed.split(".");
  const version = parts[0];

  if (version === V2) {
    if (parts.length !== 5) {
      throw new Error("Malformed sealed secret: expected v2.<kid>.<iv>.<tag>.<ct>.");
    }
    const [, kid, ivB64, tagB64, ctB64] = parts;
    if (!KID_RE.test(kid)) {
      throw new Error(`Malformed sealed secret: invalid kid "${kid}".`);
    }
    return openWith(keyForKid(ring, kid), ivB64, tagB64, ctB64);
  }

  if (version === V1) {
    if (parts.length !== 4) {
      throw new Error("Malformed sealed secret: expected v1.<iv>.<tag>.<ct>.");
    }
    const [, ivB64, tagB64, ctB64] = parts;
    // Legacy blobs open under ring key "v1" (present in backward-compat mode, and
    // can be kept in an explicit keyring during the overlap window of a rotation).
    return openWith(keyForKid(ring, LEGACY_KID), ivB64, tagB64, ctB64);
  }

  throw new Error(`Unsupported sealed-secret format/version: ${version}.`);
}

/**
 * Re-wrap a sealed secret under the ACTIVE kid. Opens it (under whatever kid it's
 * currently sealed with — which must be present in the ring) then re-seals under
 * the active kid. Idempotent: when the value is already on the active kid,
 * returns it unchanged with `changed=false` (no needless re-encryption, and the
 * rotate script then skips the UPDATE).
 *
 * Used by scripts/dsop/rotate-vault-key.mjs to migrate every sealed column to the
 * active key after a key rotation, so the old key can then be retired.
 */
export function rewrapSecret(sealed: string): { sealed: string; changed: boolean } {
  const ring = loadKeyring();
  const currentKid = kidOf(sealed); // "v1" for legacy blobs
  if (currentKid === ring.active) {
    return { sealed, changed: false };
  }
  const plaintext = openSecret(sealed);
  return { sealed: sealWith(ring.active, keyForKid(ring, ring.active), plaintext), changed: true };
}
