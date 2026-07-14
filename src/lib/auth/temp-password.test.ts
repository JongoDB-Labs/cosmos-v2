// @vitest-environment node
//
// The temporary-password generator used when an admin creates an email/password
// invite. It must be cryptographically strong, always satisfy the app's password
// policy (so the very first login isn't rejected by our own rules), and never
// collide in practice.
import { describe, it, expect } from "vitest";
import { generateTempPassword, TEMP_PASSWORD_ALPHABET } from "./temp-password";
import { passwordPolicyError } from "./password";

describe("generateTempPassword", () => {
  it("always satisfies the app password policy", () => {
    for (let i = 0; i < 200; i++) {
      expect(passwordPolicyError(generateTempPassword())).toBeNull();
    }
  });

  it("only uses the unambiguous alphabet (no O/0/I/l/1 look-alikes)", () => {
    const allowed = new Set(TEMP_PASSWORD_ALPHABET.split(""));
    for (let i = 0; i < 100; i++) {
      for (const ch of generateTempPassword()) {
        expect(allowed.has(ch)).toBe(true);
      }
    }
    // The alphabet itself must exclude the classic transcription look-alikes.
    for (const bad of ["0", "O", "I", "l", "1"]) {
      expect(TEMP_PASSWORD_ALPHABET.includes(bad)).toBe(false);
    }
  });

  it("is long enough to carry real entropy (>= 20 chars)", () => {
    expect(generateTempPassword().length).toBeGreaterThanOrEqual(20);
  });

  it("does not collide across many generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(generateTempPassword());
    expect(seen.size).toBe(5000);
  });

  it("has no single-character dominance (sane distribution)", () => {
    // Cheap sanity check that we're not accidentally emitting a constant.
    const counts = new Map<string, number>();
    const N = 2000;
    for (let i = 0; i < N; i++) {
      for (const ch of generateTempPassword()) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    // No character should account for more than ~15% of all emitted characters
    // (uniform over ~50 symbols would be ~2%).
    for (const c of counts.values()) {
      expect(c / total).toBeLessThan(0.15);
    }
  });
});
