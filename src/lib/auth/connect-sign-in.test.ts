import { describe, expect, it } from "vitest";
import { connectCookieValue, connectOutcomeUrl, readConnectIntent, sessionHash } from "./connect-sign-in";

// Where a connect comes back to is checked by the same rule as a sign-in's
// return address (return-to.ts, whose tests cover each refused shape). These
// check that the connect flow applies it, on the way in and on the way out.
describe("the connect flow's return address", () => {
  it("keeps a same-site path", () => {
    const cookie = connectCookieValue({ provider: "google", state: "s", sessionId: "sid", returnTo: "/acme/settings/profile" });
    expect(readConnectIntent(cookie, "google", "s")?.returnTo).toBe("/acme/settings/profile");
  });

  it("turns anything that could leave the site into /", () => {
    for (const raw of ["//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "https://evil.example", "/.//evil.example", "evil", ""]) {
      const cookie = connectCookieValue({ provider: "google", state: "s", sessionId: "sid", returnTo: raw });
      expect(readConnectIntent(cookie, "google", "s")?.returnTo).toBe("/");
    }
  });

  it("never yields a URL on another origin", () => {
    for (const raw of ["//evil.example/x", "/\t/evil.example", "/%2F/evil.example"]) {
      expect(connectOutcomeUrl("https://app.example", raw, { connected: "google" }).origin).toBe("https://app.example");
    }
  });
});

describe("readConnectIntent", () => {
  const cookie = connectCookieValue({ provider: "microsoft", state: "s1", sessionId: "sid-1", returnTo: "/x" });

  it("answers only the provider and state it was started for", () => {
    expect(readConnectIntent(cookie, "microsoft", "s1")).toEqual({ sessionHash: sessionHash("sid-1"), returnTo: "/x" });
    expect(readConnectIntent(cookie, "google", "s1")).toBeNull();
    expect(readConnectIntent(cookie, "microsoft", "s2")).toBeNull();
  });

  it("ignores a missing or garbled cookie", () => {
    expect(readConnectIntent(undefined, "microsoft", "s1")).toBeNull();
    expect(readConnectIntent("not-base64-json", "microsoft", "s1")).toBeNull();
  });

  it("carries a hash of the session, never the session id itself", () => {
    expect(Buffer.from(cookie, "base64url").toString("utf8")).not.toContain("sid-1");
  });
});
