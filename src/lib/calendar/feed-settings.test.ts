import { describe, it, expect } from "vitest";
import { FEED_CREATE_REFUSAL_TEXT, FEED_INACTIVE_TEXT, feedInactiveReason } from "./feed-settings";
import { KEY_INACTIVE_TEXT } from "@/lib/auth/api-key-policy";

const ON = { enabled: true, requiredIdpConnId: null };
const SSO = { enabled: true, requiredIdpConnId: "conn-1" };

describe("feedInactiveReason", () => {
  it("serves any link while the org requires no single sign-on", () => {
    expect(feedInactiveReason(ON, { idpConnId: null })).toBeNull();
    expect(feedInactiveReason(ON, { idpConnId: "conn-1" })).toBeNull();
  });

  it("where the org requires single sign-on, serves only a link made through its IdP", () => {
    expect(feedInactiveReason(SSO, { idpConnId: "conn-1" })).toBeNull();
    expect(feedInactiveReason(SSO, { idpConnId: null })).toBe("sso");
    expect(feedInactiveReason(SSO, { idpConnId: "conn-2" })).toBe("sso");
  });

  it("serves nothing while the org's switch is off, whatever the link", () => {
    expect(feedInactiveReason({ ...SSO, enabled: false }, { idpConnId: "conn-1" })).toBe("switch_off");
    expect(feedInactiveReason({ ...ON, enabled: false }, { idpConnId: null })).toBe("switch_off");
  });

  it("says why in the API key list's words, and what to do about it", () => {
    expect(FEED_INACTIVE_TEXT.sso.startsWith(KEY_INACTIVE_TEXT.sso)).toBe(true);
    expect(FEED_INACTIVE_TEXT.sso).toMatch(/make a new link/i);
    for (const t of Object.values(FEED_INACTIVE_TEXT)) expect(t).toMatch(/^Not active: /);
    for (const t of Object.values(FEED_CREATE_REFUSAL_TEXT)) expect(t).toMatch(/\.$/);
  });
});
