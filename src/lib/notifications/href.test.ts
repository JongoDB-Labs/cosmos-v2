import { describe, expect, it } from "vitest";
import { notificationHref } from "./href";

describe("notificationHref", () => {
  it("prefixes an org-relative path with the org slug", () => {
    expect(notificationHref("acme", "/notes/n1")).toBe("/acme/notes/n1");
    expect(notificationHref("acme", "/issues?item=abc")).toBe("/acme/issues?item=abc");
  });

  it("does not prefix a path that already carries the slug", () => {
    expect(notificationHref("acme", "/acme/issues?item=abc")).toBe("/acme/issues?item=abc");
    expect(notificationHref("acme", "/acme/feedback")).toBe("/acme/feedback");
    expect(notificationHref("acme", "/acme")).toBe("/acme");
  });

  it("only strips the slug as a whole path segment", () => {
    // An org called "acme" must not eat the start of "/acme-reports/…".
    expect(notificationHref("acme", "/acme-reports/x")).toBe("/acme/acme-reports/x");
  });

  it("adds the missing leading slash to a bare relative path", () => {
    expect(notificationHref("acme", "issues?item=abc")).toBe("/acme/issues?item=abc");
  });

  it("leaves a URL with a scheme alone", () => {
    expect(notificationHref("acme", "https://example.com/x")).toBe("https://example.com/x");
  });

  it("never builds a protocol-relative URL when no org is in view", () => {
    expect(notificationHref(null, "/issues?item=abc")).toBe("/issues?item=abc");
    expect(notificationHref("", "/issues")).toBe("/issues");
  });

  it("sends the root to the org home", () => {
    expect(notificationHref("acme", "/")).toBe("/acme");
  });
});
