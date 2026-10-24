import { describe, it, expect } from "vitest";
import { judgeLockVersions, versionTag } from "./lock-version.mjs";

/**
 * A lock entry's `"version"` is only useful if it names the commit its `ref`
 * pins. These pin the rule that a recorded tag pointing anywhere else — or
 * nowhere — fails the lock check rather than reading as a release it is not.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** A resolver over a fixed table: slug → tag → sha. Absent slug = no checkout. */
const repos = (table) => (slug, tag) => (slug in table ? (table[slug][tag] ?? null) : undefined);

describe("versionTag", () => {
  it("prefixes a SemVer plugin.json version with v", () => {
    expect(versionTag("1.133.5")).toBe("v1.133.5");
  });

  it("refuses anything that is not X.Y.Z", () => {
    expect(versionTag(undefined)).toBeNull();
    expect(versionTag("1.2")).toBeNull();
    expect(versionTag("1.2.3-rc.1")).toBeNull();
    expect(versionTag("1.2.3; rm -rf /")).toBeNull();
  });
});

describe("judgeLockVersions", () => {
  it("accepts a version whose tag resolves to the pinned ref", () => {
    const plugins = { alpha: { ref: SHA_A, version: "v1.0.0" } };
    expect(judgeLockVersions(plugins, repos({ alpha: { "v1.0.0": SHA_A } }))).toEqual([]);
  });

  it("fails a version whose tag names a different commit", () => {
    const plugins = { alpha: { ref: SHA_A, version: "v1.0.0" } };
    const problems = judgeLockVersions(plugins, repos({ alpha: { "v1.0.0": SHA_B } }));
    expect(problems.map((p) => p.slug)).toEqual(["alpha"]);
    expect(problems[0].message).toMatch(/tag v1\.0\.0 is bbbbbbbbb, but the pin is aaaaaaaaa/);
  });

  it("fails a version whose tag does not exist in the checkout", () => {
    const plugins = { alpha: { ref: SHA_A, version: "v9.9.9" } };
    const problems = judgeLockVersions(plugins, repos({ alpha: {} }));
    expect(problems[0].message).toMatch(/tag v9\.9\.9 not found/);
  });

  it("cannot judge a plugin with no checkout, and does not pretend to", () => {
    const plugins = { alpha: { ref: SHA_A, version: "v1.0.0" } };
    expect(judgeLockVersions(plugins, repos({}))).toEqual([]);
  });

  it("fails a malformed version even without a checkout", () => {
    const plugins = { alpha: { ref: SHA_A, version: "1.0.0" } };
    expect(judgeLockVersions(plugins, repos({}))[0].message).toMatch(/not a vX\.Y\.Z tag/);
  });

  it("fails a version recorded against a moving 'main' pin", () => {
    const plugins = { alpha: { ref: "main", version: "v1.0.0" } };
    expect(judgeLockVersions(plugins, repos({}))[0].message).toMatch(/'main' pin/);
  });

  it("ignores entries that record no version", () => {
    expect(judgeLockVersions({ alpha: { ref: SHA_A } }, repos({ alpha: {} }))).toEqual([]);
  });
});
