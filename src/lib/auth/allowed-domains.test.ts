import { describe, it, expect } from "vitest";
import { emailDomain, emailDomainAllowed, normalizeDomain } from "./allowed-domains";

describe("normalizeDomain", () => {
  it("strips a leading @, lowercases and trims", () => {
    expect(normalizeDomain("  @Example.COM ")).toBe("example.com");
    expect(normalizeDomain("@@example.com")).toBe("example.com");
  });
});

describe("emailDomain", () => {
  it("reads the domain after the LAST @, which is the one delivery uses", () => {
    expect(emailDomain("a@example.com")).toBe("example.com");
    expect(emailDomain("A.B+tag@Example.COM")).toBe("example.com");
  });

  /**
   * The parser differential this helper used to have. `split("@")[1]` returned
   * the SECOND segment, so the allowlist saw `allowed.com` while mail would be
   * delivered to `evil.com`. Not reachable in practice — every caller runs
   * `z.string().email()` first and that rejects a second "@" — but the guard
   * should not depend on a validator it cannot see.
   */
  it("does not read an earlier segment as the domain", () => {
    expect(emailDomain("a@allowed.com@evil.com")).toBe("evil.com");
    expect(emailDomain('"x@allowed.com"@evil.com')).toBe("evil.com");
  });

  it("returns '' for an address with no local part or no domain", () => {
    for (const bad of ["@evil.com", "nope", "", "a@"]) {
      expect(emailDomain(bad)).toBe("");
    }
  });
});

describe("emailDomainAllowed", () => {
  it("an empty or blank list is unrestricted — that is the load-bearing default", () => {
    expect(emailDomainAllowed("anyone@anywhere.test", [])).toBe(true);
    expect(emailDomainAllowed("anyone@anywhere.test", null)).toBe(true);
    expect(emailDomainAllowed("anyone@anywhere.test", undefined)).toBe(true);
    expect(emailDomainAllowed("anyone@anywhere.test", ["  ", ""])).toBe(true);
  });

  it("matches the configured domain exactly, however either side is written", () => {
    expect(emailDomainAllowed("Person@Example.com", ["@EXAMPLE.COM"])).toBe(true);
    expect(emailDomainAllowed("person@example.com", ["other.com", "example.com"])).toBe(true);
  });

  it("does not wildcard subdomains — a simple, predictable mental model", () => {
    expect(emailDomainAllowed("person@mail.example.com", ["example.com"])).toBe(false);
    expect(emailDomainAllowed("person@notexample.com", ["example.com"])).toBe(false);
  });

  it("refuses a malformed address when a list is set", () => {
    expect(emailDomainAllowed("nope", ["example.com"])).toBe(false);
    expect(emailDomainAllowed("@example.com", ["example.com"])).toBe(false);
  });

  it("refuses an address whose real delivery domain is not on the list", () => {
    // The differential case, asserted through the predicate callers use.
    expect(emailDomainAllowed("a@example.com@evil.com", ["example.com"])).toBe(false);
  });
});
