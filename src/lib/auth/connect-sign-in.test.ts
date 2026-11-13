import { describe, expect, it } from "vitest";
import { connectCookieValue, connectOutcomeUrl, readConnectIntent, safeReturnTo, sessionHash } from "./connect-sign-in";

describe("safeReturnTo", () => {
  it("keeps a same-site path", () => {
    expect(safeReturnTo("/acme/settings/profile")).toBe("/acme/settings/profile");
    expect(safeReturnTo("/a?b=c#d")).toBe("/a?b=c#d");
  });

  it("turns anything that could leave the site into /", () => {
    for (const raw of ["//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "https://evil.example", "evil", "", null, 7]) {
      expect(safeReturnTo(raw)).toBe("/");
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
