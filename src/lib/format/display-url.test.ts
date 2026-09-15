import { describe, it, expect } from "vitest";
import { displayUrl, isBareUrlLabel } from "./display-url";

const MAX = 48;

describe("displayUrl", () => {
  it("shortens the reported case — the 85-char spec link from the bug report", () => {
    const raw =
      "https://example.com/very/long/path/to/a/specification/document?version=42&reviewer=bob";
    const out = displayUrl(raw);
    expect(out.length).toBeLessThanOrEqual(MAX);
    // The positive control: it is genuinely shorter than what shipped.
    expect(out.length).toBeLessThan(raw.length);
    // And it still says WHERE the link goes and WHAT it is.
    expect(out).toContain("example.com");
    expect(out).toContain("document");
  });

  it("leaves a short URL alone", () => {
    expect(displayUrl("https://example.com/spec")).toBe("example.com/spec");
  });

  it("drops the scheme and a leading www.", () => {
    expect(displayUrl("https://www.example.com/a")).toBe("example.com/a");
    expect(displayUrl("http://example.com/a")).toBe("example.com/a");
  });

  it("renders a bare host with no trailing slash", () => {
    expect(displayUrl("https://example.com")).toBe("example.com");
    expect(displayUrl("https://example.com/")).toBe("example.com");
  });

  it("marks a dropped query string so the label never claims to be the whole URL", () => {
    expect(displayUrl("https://example.com/a?x=1")).toBe("example.com/a…");
    expect(displayUrl("https://example.com/a#frag")).toBe("example.com/a…");
  });

  it("keeps the END of a long path — the identifying part", () => {
    const out = displayUrl(
      "https://example.com/sites/teams/programme/delivery/artefacts/final-report.pdf",
    );
    expect(out).toContain("example.com");
    expect(out).toContain("final-report.pdf");
    // The middle is what gets elided, not the filename.
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(MAX);
  });

  it("never exceeds the cap, even for an absurd host", () => {
    const out = displayUrl(`https://${"sub.".repeat(30)}example.com/a/b/c`);
    expect(out.length).toBeLessThanOrEqual(MAX);
  });

  it("returns unparseable input truncated rather than throwing or emptying it", () => {
    expect(displayUrl("not a url")).toBe("not a url");
    expect(displayUrl("")).toBe("");
    const long = "x".repeat(200);
    expect(displayUrl(long).length).toBeLessThanOrEqual(MAX);
  });
});

describe("isBareUrlLabel", () => {
  it("recognises Lexical's [url](url) autolink round-trip", () => {
    // The editor exports an auto-linked paste as its own href, so the label and
    // the href are the same string. That is the case worth detecting.
    const u = "https://example.com/a/b";
    expect(isBareUrlLabel(u, u)).toBe(true);
  });

  it("ignores scheme, www. and a trailing slash when comparing", () => {
    expect(isBareUrlLabel("example.com/a", "https://example.com/a")).toBe(true);
    expect(isBareUrlLabel("https://www.example.com/a/", "https://example.com/a")).toBe(true);
    expect(isBareUrlLabel("HTTPS://EXAMPLE.COM/A", "https://example.com/a")).toBe(true);
  });

  it("keeps a real human label — the whole point of writing one", () => {
    expect(isBareUrlLabel("The spec", "https://example.com/a")).toBe(false);
    expect(isBareUrlLabel("example.com/b", "https://example.com/a")).toBe(false);
  });
});
