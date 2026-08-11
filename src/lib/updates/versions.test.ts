// @vitest-environment node
//
// The update decision, with no network in sight.
//
// The property that matters most here is the REFUSAL cases. An update surface
// that occasionally offers a downgrade is worse than one that occasionally says
// nothing: downgrading across a schema migration corrupts a database, and this
// deployment applies migrations automatically on deploy. So "ahead" and
// "unparseable current version" are tested as first-class outcomes, not edges.
import { describe, it, expect } from "vitest";
import { versionsFromTags, updateStatus, isVersion } from "./versions";

describe("versionsFromTags — what in a registry tag list is actually a release", () => {
  it("reads bare versions and ignores the noise a registry accumulates", () => {
    expect(versionsFromTags(["2.276.8", "latest", "main", "sha256-abc.sig", "2.275.0"])).toEqual([
      "2.275.0",
      "2.276.8",
    ]);
  });

  it("accepts the composed `<version>-<suffix>` shape and returns the bare version", () => {
    // Composed instances tag 2.276.8-alpha; the version is what we compare and
    // display, so the suffix must not survive into the result.
    expect(versionsFromTags(["2.276.8-alpha", "2.275.0-alpha", "latest"], "alpha")).toEqual([
      "2.275.0",
      "2.276.8",
    ]);
  });

  it("does not accept another instance's tags", () => {
    // One registry can serve several composed instances. Offering one
    // instance's build to another would deploy the wrong composition —
    // a different set of plugins entirely.
    expect(versionsFromTags(["2.276.8-beta", "2.270.0-alpha"], "alpha")).toEqual(["2.270.0"]);
  });

  it("deduplicates when both tag shapes point at the same release", () => {
    expect(versionsFromTags(["2.276.8", "2.276.8-alpha"], "alpha")).toEqual(["2.276.8"]);
  });

  it("sorts numerically, not lexically", () => {
    // "2.9.0" > "2.10.0" as strings. A lexical sort would offer 2.9.0 as newest
    // and quietly propose a downgrade.
    expect(versionsFromTags(["2.9.0", "2.10.0", "2.100.0"])).toEqual(["2.9.0", "2.10.0", "2.100.0"]);
  });

  it("survives a garbage tag rather than blanking the whole check", () => {
    expect(versionsFromTags(["", "  ", "2.1.0", "v2.2.0", "2.2", "2.2.0.0"])).toEqual(["2.1.0"]);
  });

  it("rejects near-misses that are not plain releases", () => {
    expect(isVersion("2.276.8")).toBe(true);
    expect(isVersion("v2.276.8")).toBe(false);
    expect(isVersion("2.276.8-alpha")).toBe(false);
    expect(isVersion("2.276")).toBe(false);
  });
});

describe("updateStatus — offering an upgrade, and refusing to offer a downgrade", () => {
  it("reports the newer releases when the registry is ahead", () => {
    const s = updateStatus("2.275.0", ["2.274.0", "2.275.0", "2.276.0", "2.276.8"]);
    expect(s.updateAvailable).toBe(true);
    expect(s.latest).toBe("2.276.8");
    expect(s.newer).toEqual(["2.276.0", "2.276.8"]);
    expect(s.ahead).toBe(false);
  });

  it("says nothing is available when the instance is already current", () => {
    const s = updateStatus("2.276.8", ["2.275.0", "2.276.8"]);
    expect(s.updateAvailable).toBe(false);
    expect(s.newer).toEqual([]);
    expect(s.latest).toBe("2.276.8");
  });

  it("NEVER offers an update when the instance is ahead of the registry", () => {
    // The live state during a rollout, and what a stale or misconfigured
    // registry produces. The newest tag here is a DOWNGRADE.
    const s = updateStatus("2.276.8", ["2.274.0", "2.275.0"]);
    expect(s.updateAvailable).toBe(false);
    expect(s.newer).toEqual([]);
    expect(s.ahead).toBe(true);
    expect(s.latest).toBe("2.275.0"); // still reported, so the UI can explain WHY
  });

  it("refuses to decide when the running version is unreadable", () => {
    const s = updateStatus("unknown", ["2.276.8"]);
    expect(s.updateAvailable).toBe(false);
    expect(s.ahead).toBe(false);
  });

  it("reports nothing available against an empty registry listing", () => {
    const s = updateStatus("2.276.8", []);
    expect(s.latest).toBeNull();
    expect(s.updateAvailable).toBe(false);
    expect(s.ahead).toBe(false); // nothing to be ahead OF — must not read as a downgrade case
  });

  it("ignores unparseable entries in the available list", () => {
    const s = updateStatus("2.275.0", ["latest", "2.276.0", "garbage"]);
    expect(s.newer).toEqual(["2.276.0"]);
  });

  it("orders `newer` ascending so the UI can show the upgrade path", () => {
    const s = updateStatus("2.1.0", ["2.10.0", "2.2.0", "2.9.0"]);
    expect(s.newer).toEqual(["2.2.0", "2.9.0", "2.10.0"]);
  });
});
