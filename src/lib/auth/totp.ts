import {
  createHmac,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/**
 * RFC-6238 TOTP (SHA-1, 6 digits, 30s) + recovery codes, using only Node's
 * crypto — no otplib/speakeasy dependency. Authenticator apps (Google
 * Authenticator, Authy, 1Password, …) default to exactly SHA1/6/30, so the
 * enrollment URI omits nothing they need.
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD = 30;
const DIGITS = 6;

/** A fresh 160-bit base32 secret (the value sealed at rest + shown once on enroll). */
export function generateTotpSecret(): string {
  const buf = randomBytes(20);
  let bits = "";
  for (const byte of buf) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += B32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** Verify a token against the secret, allowing ±`window` 30s steps for clock skew. */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const t = (token ?? "").replace(/\D/g, "");
  if (t.length !== DIGITS) return false;
  const key = base32Decode(secret);
  if (key.length === 0) return false;
  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  const expectedFor = (c: number) => Buffer.from(hotp(key, c));
  const provided = Buffer.from(t);
  for (let w = -window; w <= window; w++) {
    const exp = expectedFor(counter + w);
    if (exp.length === provided.length && timingSafeEqual(exp, provided)) return true;
  }
  return false;
}

/** otpauth:// URI for the QR / manual entry. */
export function totpUri(secret: string, account: string, issuer = "COSMOS"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Single-use recovery codes (shown once on enroll, stored hashed). */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < 10; j++) raw += B32[randomInt(B32.length)];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256")
    .update((code ?? "").replace(/[\s-]/g, "").toUpperCase())
    .digest("hex");
}

/**
 * Check a recovery code against the stored hashes; on match returns the
 * remaining hashes (the matched one consumed). Single-use.
 */
export function consumeRecoveryCode(
  code: string,
  hashed: string[],
): { ok: boolean; remaining: string[] } {
  const h = hashRecoveryCode(code);
  const idx = hashed.findIndex((stored) => {
    const a = Buffer.from(stored);
    const b = Buffer.from(h);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (idx < 0) return { ok: false, remaining: hashed };
  return { ok: true, remaining: hashed.filter((_, i) => i !== idx) };
}
