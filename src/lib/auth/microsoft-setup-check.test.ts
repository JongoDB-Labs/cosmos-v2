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

  it("warns that existing accounts can't link until xms_edov or trusted domains are set up", () => {
    const lines = microsoftSetupWarnings({ enabled: true, tenant: "11111111-1111-4111-8111-111111111111" }, []);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/xms_edov/);
    expect(lines[0]).toMatch(/MICROSOFT_TRUSTED_DOMAINS/);
  });

  it("is quiet for a pinned tenant with trusted domains", () => {
    expect(microsoftSetupWarnings({ enabled: true, tenant: "11111111-1111-4111-8111-111111111111" }, ["example.com"])).toEqual([]);
  });
});
