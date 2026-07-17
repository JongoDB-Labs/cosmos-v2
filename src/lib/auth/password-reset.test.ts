// @vitest-environment node
import { describe, it, expect } from "vitest";

// Vault key for sealing/opening the reset token (read at call time).
process.env.SSO_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");

import {
  createPasswordResetToken,
  parsePasswordResetToken,
  resetFingerprint,
  fingerprintMatches,
} from "./password-reset";

const USER = {
  id: "11111111-1111-1111-1111-111111111111",
  passwordHash: "scrypt$16384$8$1$aa$bb",
  passwordSetAt: new Date("2026-01-01T00:00:00Z"),
};

describe("password-reset token", () => {
  it("round-trips the userId and fingerprint of a valid, unexpired token", () => {
    const token = createPasswordResetToken(USER);
    const decoded = parsePasswordResetToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.uid).toBe(USER.id);
    expect(fingerprintMatches(decoded!.fp, resetFingerprint(USER))).toBe(true);
  });

  it("rejects an expired token", () => {
    const token = createPasswordResetToken(USER, { ttlMs: 1000, now: 1000 });
    // now is well past exp (2000)
    expect(parsePasswordResetToken(token, { now: 10_000 })).toBeNull();
  });

  it("rejects a tampered token", () => {
    const token = createPasswordResetToken(USER);
    // Flip a character in the middle so the mutation lands on significant
    // ciphertext/tag bytes (GCM auth must then fail on open).
    const i = Math.floor(token.length / 2);
    const ch = token[i] === "A" ? "B" : "A";
    const flipped = token.slice(0, i) + ch + token.slice(i + 1);
    expect(flipped).not.toBe(token);
    expect(parsePasswordResetToken(flipped)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parsePasswordResetToken("not-a-token")).toBeNull();
    expect(parsePasswordResetToken("")).toBeNull();
  });

  it("changes the fingerprint when the password (or its set-at) changes — enforcing single-use", () => {
    const before = resetFingerprint(USER);
    const afterNewHash = resetFingerprint({
      ...USER,
      passwordHash: "scrypt$16384$8$1$cc$dd",
    });
    const afterNewSetAt = resetFingerprint({
      ...USER,
      passwordSetAt: new Date("2026-02-02T00:00:00Z"),
    });
    expect(afterNewHash).not.toBe(before);
    expect(afterNewSetAt).not.toBe(before);

    // A token minted before the change no longer matches the new state.
    const token = createPasswordResetToken(USER);
    const decoded = parsePasswordResetToken(token)!;
    expect(fingerprintMatches(decoded.fp, afterNewHash)).toBe(false);
  });
});
