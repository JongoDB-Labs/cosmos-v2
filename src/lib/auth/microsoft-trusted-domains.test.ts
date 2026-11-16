import { afterEach, describe, expect, it, vi } from "vitest";
import { microsoftTrustedDomains, normalizeTrustedDomain } from "./microsoft";

// Trusted Microsoft domains come from two places: the instance admin's list in
// Admin → Sign-in providers, and MICROSOFT_TRUSTED_DOMAINS. Sign-in trusts
// both, so an operator who can't edit the server's environment can still finish
// the setup from the app.
describe("microsoftTrustedDomains", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("trusts the domains the admin configured, with no environment variable", () => {
    vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "");
    expect(microsoftTrustedDomains(["example.com"])).toEqual(["example.com"]);
  });

  it("joins the configured list and the environment variable, once each", () => {
    vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "Example.com, corp.example");
    expect(microsoftTrustedDomains(["example.com", "other.example"]).sort()).toEqual(
      ["corp.example", "example.com", "other.example"],
    );
  });

  it("is empty when neither says anything", () => {
    vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "");
    expect(microsoftTrustedDomains()).toEqual([]);
    expect(microsoftTrustedDomains(null)).toEqual([]);
  });
});

describe("normalizeTrustedDomain", () => {
  it("lowercases and drops a leading @", () => {
    expect(normalizeTrustedDomain(" @Example.COM ")).toBe("example.com");
    expect(normalizeTrustedDomain("sub.corp.example")).toBe("sub.corp.example");
  });

  it("refuses anything that isn't a plain domain", () => {
    for (const bad of ["", "localhost", "*.example.com", "a@example.com", "example .com", "https://example.com", "example.com/"]) {
      expect(normalizeTrustedDomain(bad)).toBeNull();
    }
  });
});
