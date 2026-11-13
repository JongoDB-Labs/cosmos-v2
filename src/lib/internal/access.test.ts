import { describe, expect, it } from "vitest";
import {
  canSetFirstPassword,
  connectSignInRefusal,
  isInternalAdmin,
  isSystemAdmin,
  sessionVouchesForAddress,
  type SystemAdminSubject,
} from "./access";

describe("isInternalAdmin", () => {
  it("returns false when env unset", () => {
    expect(isInternalAdmin("admin@example.com", undefined)).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isInternalAdmin("Admin@Example.com", "admin@example.com")).toBe(true);
  });

  it("accepts comma-separated list", () => {
    expect(isInternalAdmin("a@x.com", "b@x.com, a@x.com,c@x.com")).toBe(true);
  });

  it("rejects unknown emails", () => {
    expect(isInternalAdmin("nope@x.com", "a@x.com")).toBe(false);
  });
});

const ADMIN = "ops@admin.test";
const subject = (over: Partial<SystemAdminSubject> = {}): SystemAdminSubject => ({
  email: ADMIN,
  ssoProvisioned: false,
  authMethod: "google",
  idpConnId: null,
  googleBound: true,
  microsoftBound: false,
  passwordUntrusted: false,
  ...over,
});

describe("sessionVouchesForAddress", () => {
  it("counts a first-party session only through the credential that signed it in", () => {
    expect(sessionVouchesForAddress(subject())).toBe(true);
    expect(sessionVouchesForAddress(subject({ authMethod: "google", googleBound: false }))).toBe(false);
    expect(sessionVouchesForAddress(subject({ authMethod: "microsoft", microsoftBound: true }))).toBe(true);
    expect(sessionVouchesForAddress(subject({ authMethod: "microsoft", microsoftBound: false }))).toBe(false);
    expect(sessionVouchesForAddress(subject({ authMethod: "password" }))).toBe(true);
    expect(sessionVouchesForAddress(subject({ authMethod: "password", passwordUntrusted: true }))).toBe(false);
    expect(sessionVouchesForAddress(subject({ authMethod: null }))).toBe(false);
  });

  it("never through a session that came through an org's IdP, whatever method it claims", () => {
    expect(sessionVouchesForAddress(subject({ authMethod: "oidc" }))).toBe(false);
    expect(sessionVouchesForAddress(subject({ authMethod: "google", idpConnId: "conn-1" }))).toBe(false);
    expect(sessionVouchesForAddress(subject({ authMethod: "password", idpConnId: "conn-1" }))).toBe(false);
  });

  it("never for an account an IdP made", () => {
    expect(sessionVouchesForAddress(subject({ ssoProvisioned: true }))).toBe(false);
  });
});

describe("canSetFirstPassword", () => {
  it("only a Google or Microsoft session that vouches for the address", () => {
    expect(canSetFirstPassword(subject())).toBe(true);
    expect(canSetFirstPassword(subject({ authMethod: "microsoft", googleBound: false, microsoftBound: true }))).toBe(true);
    // A password session can't be setting a FIRST password, and must not count as one.
    expect(canSetFirstPassword(subject({ authMethod: "password" }))).toBe(false);
    expect(canSetFirstPassword(subject({ authMethod: "oidc" }))).toBe(false);
    expect(canSetFirstPassword(subject({ idpConnId: "conn-1" }))).toBe(false);
    expect(canSetFirstPassword(subject({ authMethod: null }))).toBe(false);
  });
});

describe("isSystemAdmin", () => {
  it("needs the listed address AND a session that vouches for it", () => {
    expect(isSystemAdmin(subject(), ADMIN)).toBe(true);
    expect(isSystemAdmin(subject(), "someone@else.test")).toBe(false);
    expect(isSystemAdmin(subject({ authMethod: null }), ADMIN)).toBe(false);
    expect(isSystemAdmin(subject({ ssoProvisioned: true }), ADMIN)).toBe(false);
    expect(isSystemAdmin(null, ADMIN)).toBe(false);
  });
});

describe("connectSignInRefusal", () => {
  // Not a platform admin: the rule is the same for every account.
  const person = { email: "person@example.test" };

  it("lets a session that vouches for the address connect another method", () => {
    expect(connectSignInRefusal(subject({ ...person, authMethod: "password", googleBound: false }))).toBeNull();
    expect(connectSignInRefusal(subject({ ...person, authMethod: "google" }))).toBeNull();
    expect(connectSignInRefusal(subject({ ...person, authMethod: "microsoft", googleBound: false, microsoftBound: true }))).toBeNull();
  });

  it("asks a session from before methods were recorded to sign in again, on any account", () => {
    expect(connectSignInRefusal(subject({ ...person, authMethod: null }))).toBe("connect_sign_in_again");
    expect(connectSignInRefusal(subject({ authMethod: null }))).toBe("connect_sign_in_again");
  });

  it("asks a Google or Microsoft session whose identity is no longer bound to sign in again", () => {
    expect(connectSignInRefusal(subject({ ...person, authMethod: "google", googleBound: false }))).toBe("connect_sign_in_again");
    expect(connectSignInRefusal(subject({ ...person, authMethod: "microsoft", microsoftBound: false }))).toBe("connect_sign_in_again");
  });

  it("refuses a password an SSO session could have set, with its own reason", () => {
    expect(connectSignInRefusal(subject({ ...person, authMethod: "password", passwordUntrusted: true }))).toBe("connect_password_untrusted");
    expect(connectSignInRefusal(subject({ authMethod: "password", passwordUntrusted: true }))).toBe("connect_password_untrusted");
  });

  it("never from an SSO session, or for an account an IdP made", () => {
    expect(connectSignInRefusal(subject({ ...person, authMethod: "oidc" }))).toBe("connect_not_allowed");
    expect(connectSignInRefusal(subject({ ...person, idpConnId: "conn-1" }))).toBe("connect_not_allowed");
    expect(connectSignInRefusal(subject({ ...person, ssoProvisioned: true }))).toBe("connect_not_allowed");
    expect(connectSignInRefusal(subject({ ...person, ssoProvisioned: true, authMethod: null }))).toBe("connect_not_allowed");
  });
});
