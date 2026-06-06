// @vitest-environment node
//
// Vault round-trip + tamper-detection tests. The vault is the reusable
// secret-sealing primitive (SSO client secrets first; connectors next).
// It MUST: round-trip exactly, reject a tampered ciphertext/tag (GCM auth),
// reject the wrong key, and fail loudly when SSO_VAULT_KEY is absent/invalid.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");

// The vault reads process.env.SSO_VAULT_KEY at call time, so we just set the
// env per test. A single import is fine because masterKey() re-reads the env
// on every call — no module-level key caching to defeat.
async function loadVault() {
  vi.resetModules();
  return import("./vault");
}

const ORIGINAL = process.env.SSO_VAULT_KEY;

beforeEach(() => {
  process.env.SSO_VAULT_KEY = KEY_A;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL;
});

describe("vault sealSecret/openSecret", () => {
  it("round-trips a secret exactly", async () => {
    const { sealSecret, openSecret } = await loadVault();
    const plaintext = "super-secret-oidc-client-secret-üñîçødé-🔐";
    const sealed = sealSecret(plaintext);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(plaintext);
    expect(openSecret(sealed)).toBe(plaintext);
  });

  it("produces a distinct ciphertext each time (random IV)", async () => {
    const { sealSecret, openSecret } = await loadVault();
    const a = sealSecret("same");
    const b = sealSecret("same");
    expect(a).not.toBe(b);
    expect(openSecret(a)).toBe("same");
    expect(openSecret(b)).toBe("same");
  });

  it("throws on a tampered auth tag", async () => {
    const { sealSecret, openSecret } = await loadVault();
    const sealed = sealSecret("tamper-me");
    const [v, iv, tag, ct] = sealed.split(".");
    // Flip a byte in the tag → GCM auth must fail.
    const tagBuf = Buffer.from(tag, "base64");
    tagBuf[0] ^= 0xff;
    const tampered = [v, iv, tagBuf.toString("base64"), ct].join(".");
    expect(() => openSecret(tampered)).toThrow();
  });

  it("throws on a tampered ciphertext", async () => {
    const { sealSecret, openSecret } = await loadVault();
    const sealed = sealSecret("tamper-the-ct");
    const [v, iv, tag, ct] = sealed.split(".");
    const ctBuf = Buffer.from(ct, "base64");
    ctBuf[0] ^= 0xff;
    const tampered = [v, iv, tag, ctBuf.toString("base64")].join(".");
    expect(() => openSecret(tampered)).toThrow();
  });

  it("throws when opened under the wrong key", async () => {
    const { sealSecret } = await loadVault();
    const sealed = sealSecret("cross-key");
    // Re-load the vault with a different master key and try to open.
    process.env.SSO_VAULT_KEY = KEY_B;
    const { openSecret } = await loadVault();
    expect(() => openSecret(sealed)).toThrow();
  });

  it("throws a clear error when SSO_VAULT_KEY is missing", async () => {
    delete process.env.SSO_VAULT_KEY;
    const { sealSecret } = await loadVault();
    expect(() => sealSecret("x")).toThrow(/SSO_VAULT_KEY/);
  });

  it("throws a clear error when SSO_VAULT_KEY is not 32 bytes", async () => {
    process.env.SSO_VAULT_KEY = Buffer.from("too-short").toString("base64");
    const { sealSecret } = await loadVault();
    expect(() => sealSecret("x")).toThrow(/32 bytes/);
  });

  it("rejects a sealed value with an unknown version prefix", async () => {
    const { sealSecret, openSecret } = await loadVault();
    const sealed = sealSecret("v2?");
    const bad = sealed.replace(/^v1\./, "v2.");
    expect(() => openSecret(bad)).toThrow(/format|version/i);
  });

  it("rejects a malformed sealed value", async () => {
    const { openSecret } = await loadVault();
    expect(() => openSecret("not-a-vault-blob")).toThrow();
  });
});
