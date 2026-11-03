// The front door compresses what it proxies.
//
// Measured on a live board at 2.515.0: static assets came back
// `content-encoding: gzip`, but every API response had NO Content-Encoding
// header at all. One board load fetched ~906 KB of JSON over the wire, of which
// `/work-items` alone was 494 KB and `/members` 171 KB -- twice, from two
// consumers with different cache keys.
//
// The cause: Next compresses what IT serves (its own static output), and
// nothing compressed what Caddy proxies. Proven locally against a proxied
// 201 KB JSON fixture: 206,500 bytes with no `encode`, 27,578 with it -- 7.5x.
//
// This is a one-line directive that is easy to drop in a future rewrite of the
// Caddyfile, and nothing in the app would fail if it went: responses would
// simply get ~7x bigger, which no test would notice. Hence this file.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const CADDYFILE = "compose/Caddyfile";

/** Caddyfile comments start with `#`; strip them so prose cannot satisfy the rule. */
function directives(src: string): string[] {
  return src
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

describe("the front door compresses proxied responses", () => {
  const src = readFileSync(CADDYFILE, "utf8");
  const lines = directives(src);

  it("found the Caddyfile and it has real directives", () => {
    // Positive control: a moved or emptied file would make the rule vacuous.
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.some((l) => l.startsWith("reverse_proxy"))).toBe(true);
  });

  it("declares an encode directive", () => {
    const encode = lines.filter((l) => /^encode\b/.test(l));
    expect(encode).toHaveLength(1);
    // zstd first, gzip as the fallback every client understands.
    expect(encode[0]).toMatch(/\bgzip\b/);
  });

  it("puts encode where it covers the proxied routes, not inside one of them", () => {
    // `encode` must be a site-level directive. Nested inside a route block it
    // would compress only that route -- and the heavy JSON is on the catch-all.
    const encodeIdx = lines.findIndex((l) => /^encode\b/.test(l));
    const firstProxyIdx = lines.findIndex((l) => l.startsWith("reverse_proxy"));
    expect(encodeIdx).toBeGreaterThan(-1);
    expect(encodeIdx).toBeLessThan(firstProxyIdx);
  });

  it("does not comment the directive out", () => {
    // The failure that looks like a pass: the line still present but commented.
    // `directives()` strips comments, so a commented `encode` is absent above;
    // this asserts the raw text does not contain ONLY a commented form.
    const rawHasLive = src.split("\n").some((l) => /^\s*encode\b/.test(l));
    expect(rawHasLive).toBe(true);
  });
});
