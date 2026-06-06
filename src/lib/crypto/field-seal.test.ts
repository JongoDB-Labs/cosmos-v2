// @vitest-environment node
//
// field-seal — the reusable in-place, self-healing COLUMN seal. It MUST:
//   - seal→open round-trip exactly;
//   - open a SEALED envelope to plaintext;
//   - open a LEGACY plaintext value VERBATIM (transparent — no throw);
//   - isSealed true for real envelopes, false for plaintext (incl. "v2."-prefixed
//     non-envelopes);
//   - openFieldWithHeal fire the reseal callback ONLY on legacy plaintext, never on
//     an already-sealed value, and swallow a callback failure (best-effort).
// The vault reads process.env at call time, so we set a single-key ring per suite.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const KEY = crypto.randomBytes(32).toString("base64");
const ORIGINAL = process.env.SSO_VAULT_KEY;

beforeAll(() => {
  // Legacy single-key mode → ring { v1: KEY }, active v1; seals under v2.<kid=v1>.
  process.env.SSO_VAULT_KEY = KEY;
  delete process.env.SSO_VAULT_KEYS;
  delete process.env.SSO_VAULT_ACTIVE_KID;
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL;
});

import { sealField, openField, isSealed, openFieldWithHeal } from "./field-seal";

describe("field-seal", () => {
  it("seals then opens to the exact same plaintext (round-trip)", () => {
    const secret = "WHSEC-" + crypto.randomBytes(16).toString("hex");
    const sealed = sealField(secret);
    expect(sealed).not.toBe(secret);
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(openField(sealed)).toBe(secret);
  });

  it("seals JSON payloads (mcp env/headers shape) and round-trips", () => {
    const json = JSON.stringify({ TOKEN: "X", OTHER: "y" });
    const sealed = sealField(json);
    expect(sealed).not.toContain("TOKEN");
    expect(JSON.parse(openField(sealed))).toEqual({ TOKEN: "X", OTHER: "y" });
  });

  it("opens a LEGACY plaintext value verbatim (transparent — no throw)", () => {
    expect(openField("legacy-plaintext-secret")).toBe("legacy-plaintext-secret");
    // A plaintext that merely starts with the version prefix but isn't an envelope.
    expect(openField("v2.not-a-real-envelope")).toBe("v2.not-a-real-envelope");
    expect(openField("v2.kid.iv.tag")).toBe("v2.kid.iv.tag"); // wrong part count
  });

  it("isSealed is true for real envelopes, false for plaintext", () => {
    expect(isSealed(sealField("anything"))).toBe(true);
    expect(isSealed("plaintext")).toBe(false);
    expect(isSealed("v2.not-an-envelope")).toBe(false);
    expect(isSealed("v2.kid.iv.tag")).toBe(false); // 4 parts, not 5
  });

  it("openFieldWithHeal does NOT reseal an already-sealed value", async () => {
    const sealed = sealField("already-sealed");
    const reseal = vi.fn();
    const out = await openFieldWithHeal(sealed, reseal);
    expect(out).toBe("already-sealed");
    expect(reseal).not.toHaveBeenCalled();
  });

  it("openFieldWithHeal reseals ONLY a legacy plaintext value, passing the sealed form", async () => {
    let persisted: string | undefined;
    const out = await openFieldWithHeal("legacy-pt", (sealed) => {
      persisted = sealed;
    });
    expect(out).toBe("legacy-pt"); // transparent: returns the plaintext this call
    expect(persisted).toBeDefined();
    expect(isSealed(persisted!)).toBe(true);
    // The persisted sealed form opens back to the original plaintext.
    expect(openField(persisted!)).toBe("legacy-pt");
  });

  it("openFieldWithHeal swallows a reseal-callback failure (best-effort, still returns plaintext)", async () => {
    const out = await openFieldWithHeal("legacy-pt", () => {
      throw new Error("db down");
    });
    expect(out).toBe("legacy-pt");
  });
});
