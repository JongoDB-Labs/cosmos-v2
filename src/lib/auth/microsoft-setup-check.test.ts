import { describe, expect, it } from "vitest";
import { microsoftSetupWarnings } from "./microsoft-setup-check";

describe("microsoftSetupWarnings", () => {
  it("says nothing when Microsoft sign-in is off", () => {
    expect(microsoftSetupWarnings(null, [])).toEqual([]);
    expect(microsoftSetupWarnings({ enabled: false, tenant: "common" }, [])).toEqual([]);
  });

  it("warns that any tenant is accepted when the tenant is common, organizations or unset", () => {
    for (const tenant of ["common", "organizations", null]) {
      const lines = microsoftSetupWarnings({ enabled: true, tenant }, ["example.com"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/any Microsoft tenant/);
    }
  });

  // The server can't see the app registration, so it can't know whether tokens
  // will carry xms_edov. The line must be true either way: it states what the
  // server does know, and tells the operator to act only on the evidence that
  // the claim is missing (a sign-in refused with ms_setup_incomplete).
  it("with no trusted domains, says linking rests on xms_edov, which it can't see, and asks for a change only if sign-ins are refused for it", () => {
    const lines = microsoftSetupWarnings({ enabled: true, tenant: "11111111-1111-4111-8111-111111111111" }, []);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatch(/^MICROSOFT_TRUSTED_DOMAINS is not set\b/);
    expect(line).toMatch(/xms_edov/);
    expect(line).toMatch(/can't see whether the app registration sends/);
    const sentences = line.split(/(?<=\.)\s+/);
    expect(sentences.length).toBeGreaterThan(1);
    // No unconditional instruction: the old line opened a sentence with "Add".
    for (const s of sentences) expect(s).not.toMatch(/^(Add|Set)\b/);
    const instruction = sentences.filter((s) => /\badd\b/i.test(s));
    expect(instruction).toHaveLength(1);
    expect(instruction[0]).toMatch(/^If sign-ins are refused with ms_setup_incomplete, /);
  });

  it("is quiet for a pinned tenant with trusted domains", () => {
    expect(microsoftSetupWarnings({ enabled: true, tenant: "11111111-1111-4111-8111-111111111111" }, ["example.com"])).toEqual([]);
  });
});
