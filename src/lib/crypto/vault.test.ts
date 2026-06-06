// @vitest-environment node
//
// Vault round-trip + tamper-detection + KEYRING/re-wrap tests. The vault is the
// reusable secret-sealing primitive (SSO client secrets first; connectors next).
// It MUST: round-trip exactly, reject a tampered ciphertext/tag (GCM auth),
// reject the wrong key, fail loudly when keys are absent/invalid, AND support a
// rotatable keyring (multi-key, active-kid) with a v2.<kid>.<iv>.<tag>.<ct>
// envelope, legacy v1 blobs still openable, and an idempotent re-wrap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");
const KEY_OLD = crypto.randomBytes(32).toString("base64");
const KEY_NEW = crypto.randomBytes(32).toString("base64");

// The vault reads process.env at call time, so we just set the env per test and
// re-import. A fresh import per call defeats any accidental module-level caching.
async function loadVault() {
  vi.resetModules();
  return import("./vault");
}

// Clear ALL vault env so each test starts from a known state, then restore.
const KEYS = ["SSO_VAULT_KEY", "SSO_VAULT_KEYS", "SSO_VAULT_ACTIVE_KID"] as const;
const ORIGINAL: Record<string, string | undefined> = {};
for (const k of KEYS) ORIGINAL[k] = process.env[k];

function clearVaultEnv() {
  for (const k of KEYS) delete process.env[k];
}

beforeEach(() => {
  clearVaultEnv();
  // Default: legacy single-key mode (backward-compat path) so the original
  // suite keeps exercising the v1 envelope exactly as before.
  process.env.SSO_VAULT_KEY = KEY_A;
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

describe("vault sealSecret/openSecret (legacy single-key, backward-compat)", () => {
  it("round-trips a secret exactly under the legacy v1 envelope", async () => {
    const { sealSecret, openSecret } = await loadVault();
    const plaintext = "super-secret-oidc-client-secret-üñîçødé-🔐";
    const sealed = sealSecret(plaintext);
    // Backward-compat mode still SEALS new secrets under v2.v1 (active kid is "v1"),
    // but it can OPEN the historical v1 envelope too (asserted below).
    expect(sealed).toMatch(/^v2\.v1\./);
    expect(sealed).not.toContain(plaintext);
    expect(openSecret(sealed)).toBe(plaintext);
  });

  it("opens a historical legacy v1.<iv>.<tag>.<ct> blob under the ring key v1", async () => {
    // Build a genuine v1-envelope blob the way the OLD vault did, then prove the
    // new keyring opens it unchanged (the non-negotiable backward-compat invariant).
    const key = Buffer.from(KEY_A, "base64");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("legacy-plaintext", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const legacy = ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");

    const { openSecret } = await loadVault();
    expect(openSecret(legacy)).toBe("legacy-plaintext");
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
    const parts = sealed.split("."); // v2.<kid>.<iv>.<tag>.<ct>
    const tagBuf = Buffer.from(parts[3], "base64");
    tagBuf[0] ^= 0xff;
    parts[3] = tagBuf.toString("base64");
    expect(() => openSecret(parts.join("."))).toThrow();
  });

  it("throws on a tampered ciphertext", async () => {
    const { sealSecret, openSecret } = await loadVault();
    const sealed = sealSecret("tamper-the-ct");
    const parts = sealed.split(".");
    const ctBuf = Buffer.from(parts[4], "base64");
    ctBuf[0] ^= 0xff;
    parts[4] = ctBuf.toString("base64");
    expect(() => openSecret(parts.join("."))).toThrow();
  });

  it("throws when opened under the wrong key", async () => {
    const { sealSecret } = await loadVault();
    const sealed = sealSecret("cross-key");
    // Re-load the vault with a different master key (still kid v1) and try to open.
    process.env.SSO_VAULT_KEY = KEY_B;
    const { openSecret } = await loadVault();
    expect(() => openSecret(sealed)).toThrow();
  });

  it("throws a clear error when no vault key is configured at all", async () => {
    clearVaultEnv();
    const { sealSecret } = await loadVault();
    expect(() => sealSecret("x")).toThrow(/vault keys|SSO_VAULT_KEY/);
  });

  it("throws a clear error when SSO_VAULT_KEY is not 32 bytes", async () => {
    process.env.SSO_VAULT_KEY = Buffer.from("too-short").toString("base64");
    const { sealSecret } = await loadVault();
    expect(() => sealSecret("x")).toThrow(/32 bytes/);
  });

  it("rejects a sealed value with an unknown version prefix", async () => {
    const { openSecret } = await loadVault();
    expect(() => openSecret("v9.foo.bar.baz")).toThrow(/format|version/i);
  });

  it("rejects a malformed sealed value", async () => {
    const { openSecret } = await loadVault();
    expect(() => openSecret("not-a-vault-blob")).toThrow();
  });
});

// ── Keyring (multi-key, active-kid) + re-wrap ─────────────────────────────────

describe("vault keyring + rewrapSecret", () => {
  // Helper: set up a two-key ring {old, new} with a chosen active kid.
  function ring(active: "old" | "new") {
    clearVaultEnv();
    process.env.SSO_VAULT_KEYS = JSON.stringify({ old: KEY_OLD, new: KEY_NEW });
    process.env.SSO_VAULT_ACTIVE_KID = active;
  }

  it("seals new secrets under the active kid (v2.<active>...)", async () => {
    ring("new");
    const { sealSecret, activeKid, kidOf } = await loadVault();
    expect(activeKid()).toBe("new");
    const sealed = sealSecret("hi");
    expect(sealed).toMatch(/^v2\.new\./);
    expect(kidOf(sealed)).toBe("new");
  });

  it("v2 round-trips under the kid it was sealed with", async () => {
    ring("old");
    const { sealSecret, openSecret } = await loadVault();
    const sealed = sealSecret("round-trip-üñî");
    expect(sealed).toMatch(/^v2\.old\./);
    expect(openSecret(sealed)).toBe("round-trip-üñî");
  });

  it("opens an old-kid secret while active=new (ring still holds old)", async () => {
    // Seal under old (active=old), then flip active to new — opening must still work
    // because `old` remains in the ring. This is the rotation overlap window.
    ring("old");
    const v1 = await loadVault();
    const sealedOld = v1.sealSecret("overlap");
    ring("new");
    const v2 = await loadVault();
    expect(v2.openSecret(sealedOld)).toBe("overlap");
  });

  it("rewrapSecret migrates a non-active-kid secret to the active kid, preserving plaintext", async () => {
    ring("old");
    const sealer = await loadVault();
    const sealedOld = sealer.sealSecret("migrate-me");
    expect(sealer.kidOf(sealedOld)).toBe("old");

    ring("new");
    const { rewrapSecret, openSecret, kidOf } = await loadVault();
    const { sealed, changed } = rewrapSecret(sealedOld);
    expect(changed).toBe(true);
    expect(sealed).not.toBe(sealedOld); // blob changed
    expect(kidOf(sealed)).toBe("new"); // now on the active kid
    expect(openSecret(sealed)).toBe("migrate-me"); // plaintext preserved
  });

  it("rewrapSecret is a no-op when already on the active kid (idempotent)", async () => {
    ring("new");
    const { sealSecret, rewrapSecret } = await loadVault();
    const sealed = sealSecret("already-active");
    const first = rewrapSecret(sealed);
    expect(first.changed).toBe(false);
    expect(first.sealed).toBe(sealed);
    // A second re-wrap of the re-wrapped value is also a no-op.
    const second = rewrapSecret(first.sealed);
    expect(second.changed).toBe(false);
    expect(second.sealed).toBe(first.sealed);
  });

  it("rewrapSecret migrates a legacy v1 blob to the active v2 kid", async () => {
    // Build a real legacy v1 blob under KEY_OLD, register it as kid "old" in the
    // ring, set active=new, and prove the re-wrap upgrades v1 → v2.new.
    const key = Buffer.from(KEY_OLD, "base64");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("legacy-secret", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const legacy = ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");

    clearVaultEnv();
    // The legacy blob's kid is "v1", so the ring MUST include a "v1" key (= KEY_OLD)
    // for it to open during the overlap window.
    process.env.SSO_VAULT_KEYS = JSON.stringify({ v1: KEY_OLD, new: KEY_NEW });
    process.env.SSO_VAULT_ACTIVE_KID = "new";

    const { rewrapSecret, openSecret, kidOf } = await loadVault();
    expect(kidOf(legacy)).toBe("v1");
    const { sealed, changed } = rewrapSecret(legacy);
    expect(changed).toBe(true);
    expect(kidOf(sealed)).toBe("new");
    expect(openSecret(sealed)).toBe("legacy-secret");
  });

  it("openSecret throws when the kid is absent from the ring (RETIRED key)", async () => {
    // Seal under old, then RETIRE old: ring = { new } only. Opening the old-sealed
    // value must fail loudly — proof the retired key is truly gone (IA-5 evidence).
    ring("old");
    const sealer = await loadVault();
    const sealedOld = sealer.sealSecret("orphaned");

    clearVaultEnv();
    process.env.SSO_VAULT_KEYS = JSON.stringify({ new: KEY_NEW });
    process.env.SSO_VAULT_ACTIVE_KID = "new";
    const { openSecret } = await loadVault();
    expect(() => openSecret(sealedOld)).toThrow(/retired|not in the keyring|"old"/);
  });

  it("throws at load when a ring key is the wrong length", async () => {
    clearVaultEnv();
    process.env.SSO_VAULT_KEYS = JSON.stringify({
      new: KEY_NEW,
      bad: Buffer.from("too-short").toString("base64"),
    });
    process.env.SSO_VAULT_ACTIVE_KID = "new";
    const { sealSecret } = await loadVault();
    expect(() => sealSecret("x")).toThrow(/32 bytes/);
  });

  it("throws when SSO_VAULT_ACTIVE_KID is not present in the ring", async () => {
    clearVaultEnv();
    process.env.SSO_VAULT_KEYS = JSON.stringify({ new: KEY_NEW });
    process.env.SSO_VAULT_ACTIVE_KID = "ghost";
    const { sealSecret } = await loadVault();
    expect(() => sealSecret("x")).toThrow(/not present|ACTIVE_KID/);
  });

  it("throws when SSO_VAULT_KEYS is set but SSO_VAULT_ACTIVE_KID is missing", async () => {
    clearVaultEnv();
    process.env.SSO_VAULT_KEYS = JSON.stringify({ new: KEY_NEW });
    const { sealSecret } = await loadVault();
    expect(() => sealSecret("x")).toThrow(/SSO_VAULT_ACTIVE_KID/);
  });

  it("throws on an invalid kid charset in the ring", async () => {
    clearVaultEnv();
    process.env.SSO_VAULT_KEYS = JSON.stringify({ "bad kid!": KEY_NEW });
    process.env.SSO_VAULT_ACTIVE_KID = "bad kid!";
    const { sealSecret } = await loadVault();
    expect(() => sealSecret("x")).toThrow(/invalid kid|charset/);
  });

  it("rejects a malformed v2 envelope (wrong part count)", async () => {
    ring("new");
    const { openSecret } = await loadVault();
    expect(() => openSecret("v2.new.onlythree.parts")).toThrow(/v2\.<kid>|Malformed/);
  });

  it("kidOf reports v1 for legacy blobs and the kid for v2 blobs", async () => {
    ring("new");
    const { sealSecret, kidOf } = await loadVault();
    expect(kidOf(sealSecret("x"))).toBe("new");
    expect(kidOf("v1.aaa.bbb.ccc")).toBe("v1");
  });
});
