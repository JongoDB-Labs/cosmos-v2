// scripts/cutover/lib/exposability.test.ts
//
// Unit tests for the exposability-map snapshot + hash (Task 1) and the gov-flip
// sign-off gate (Task 2). The map assembly itself is exercised against the LIVE merged
// egress maps (the same ones the gate enforces); the canonicalization + hash are pinned
// for stability; the gate is tested across all four cases with an injected loader (no FS).

import { describe, it, expect } from "vitest";
import {
  getExposabilityMap,
  canonicalize,
  exposabilityHash,
  requireExposabilitySignoff,
  type ExposabilityMap,
  type ExposabilitySignoff,
} from "./exposability";

describe("getExposabilityMap — assembled from the LIVE merged egress maps", () => {
  it("includes native + connector entities with sorted fields/tools", () => {
    const map = getExposabilityMap();
    const byType = new Map(map.entities.map((e) => [e.entityType, e]));

    // Native entity (work_item) — structural allowlist, title as a handle, no CUI fields.
    const wi = byType.get("work_item");
    expect(wi).toBeDefined();
    expect(wi!.exposableFields).toContain("id");
    expect(wi!.exposableFields).toContain("status");
    expect(wi!.exposableFields).not.toContain("title"); // title is CUI → never exposed
    expect(wi!.handleableFields).toEqual(["title"]); // title is reference-only (handle)
    expect(wi!.availability).toBe("all");

    // Connector entity (github_issue) — merged in from the registry, structural only.
    const gh = byType.get("github_issue");
    expect(gh).toBeDefined();
    expect(gh!.exposableFields).toEqual([...gh!.exposableFields].sort()); // sorted
    expect(gh!.exposableFields).not.toContain("title");
    expect(gh!.exposableFields).not.toContain("body");
  });

  it("records tool families with NO entity mapping as full-withhold (google all, nango commercial-only)", () => {
    const map = getExposabilityMap();
    const byProvider = new Map(map.withheldToolFamilies.map((f) => [f.provider, f]));
    const google = byProvider.get("google");
    const nango = byProvider.get("nango");
    expect(google).toBeDefined();
    expect(google!.availability).toBe("all");
    expect(google!.tools.length).toBeGreaterThan(0);
    expect(nango).toBeDefined();
    expect(nango!.availability).toBe("commercial-only");
    // None of these tools appears as a mapping tool of any entity (they expose nothing).
    const mappedTools = new Set(map.entities.flatMap((e) => e.tools));
    for (const t of [...google!.tools, ...nango!.tools]) {
      expect(mappedTools.has(t)).toBe(false);
    }
  });

  it("entities are sorted by entityType (deterministic order)", () => {
    const map = getExposabilityMap();
    const types = map.entities.map((e) => e.entityType);
    expect(types).toEqual([...types].sort());
  });
});

describe("canonicalize + exposabilityHash — stability", () => {
  it("same map ⇒ same canonical bytes ⇒ same hash (stable across calls)", () => {
    const a = getExposabilityMap();
    const b = getExposabilityMap();
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(exposabilityHash(a)).toBe(exposabilityHash(b));
    expect(exposabilityHash()).toBe(exposabilityHash(a)); // default arg reads the live map
  });

  it("canonicalization is insertion-order-independent (object keys sorted recursively)", () => {
    const m1: ExposabilityMap = {
      version: 1,
      entities: [
        { entityType: "x", exposableFields: ["a", "b"], handleableFields: [], tools: ["t1"], availability: "all" },
      ],
      withheldToolFamilies: [],
    };
    // Same content, keys in a different insertion order.
    const m2: ExposabilityMap = {
      withheldToolFamilies: [],
      entities: [
        { tools: ["t1"], availability: "all", handleableFields: [], exposableFields: ["a", "b"], entityType: "x" },
      ],
      version: 1,
    } as ExposabilityMap;
    expect(canonicalize(m1)).toBe(canonicalize(m2));
    expect(exposabilityHash(m1)).toBe(exposabilityHash(m2));
  });

  it("a field change ⇒ a DIFFERENT hash", () => {
    const base = getExposabilityMap();
    const tampered: ExposabilityMap = {
      ...base,
      entities: base.entities.map((e) =>
        e.entityType === "work_item"
          ? { ...e, exposableFields: [...e.exposableFields, "title"] } // leak title!
          : e,
      ),
    };
    expect(exposabilityHash(tampered)).not.toBe(exposabilityHash(base));
  });

  it("an availability change ⇒ a DIFFERENT hash", () => {
    const base = getExposabilityMap();
    const tampered: ExposabilityMap = {
      ...base,
      entities: base.entities.map((e, i) => (i === 0 ? { ...e, availability: "commercial-only" } : e)),
    };
    expect(exposabilityHash(tampered)).not.toBe(exposabilityHash(base));
  });
});

describe("requireExposabilitySignoff — the gov-flip gate (fail-closed)", () => {
  const HASH = "a".repeat(64); // a fixed synthetic current hash for the gate cases.
  const validSignoff = (over: Partial<ExposabilitySignoff> = {}): ExposabilitySignoff => ({
    orgSlug: "fsc",
    mapHash: HASH,
    reviewer: "secadmin",
    signedAt: "2026-06-07T00:00:00Z",
    leakTestPassed: true,
    ...over,
  });

  it("COMMERCIAL tenant ⇒ PASS with no sign-off required", () => {
    const r = requireExposabilitySignoff("acme", "commercial", () => null, HASH);
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/no exposability sign-off required/);
  });

  it("GOV with a matching-hash + leak-passed sign-off ⇒ PASS", () => {
    const r = requireExposabilitySignoff("fsc", "gov", () => validSignoff(), HASH);
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/sign-off valid/);
  });

  it("GOV with NO sign-off file ⇒ FAIL", () => {
    const r = requireExposabilitySignoff("fsc", "gov", () => null, HASH);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/NO exposability sign-off found/);
  });

  it("GOV with a STALE hash ⇒ FAIL", () => {
    const r = requireExposabilitySignoff("fsc", "gov", () => validSignoff({ mapHash: "b".repeat(64) }), HASH);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/STALE sign-off/);
  });

  it("GOV with leakTestPassed=false ⇒ FAIL", () => {
    const r = requireExposabilitySignoff("fsc", "gov", () => validSignoff({ leakTestPassed: false }), HASH);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/leakTestPassed=false/);
  });

  it("GOV with a wrong-orgSlug sign-off ⇒ FAIL", () => {
    const r = requireExposabilitySignoff("fsc", "gov", () => validSignoff({ orgSlug: "other" }), HASH);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not match/);
  });

  it("GOV with a malformed sign-off ⇒ FAIL", () => {
    const r = requireExposabilitySignoff("fsc", "gov", () => ({ nope: true }), HASH);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/malformed/);
  });

  it("GOV when the loader THROWS ⇒ FAIL (fail-closed, reason captured, no CUI)", () => {
    const r = requireExposabilitySignoff("fsc", "gov", () => {
      throw new Error("disk error");
    }, HASH);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/failed to read the exposability sign-off/);
  });

  it("default currentHash reads the LIVE map; a gov sign-off bound to it passes", () => {
    const live = exposabilityHash();
    const r = requireExposabilitySignoff("fsc", "gov", () => validSignoff({ mapHash: live }));
    expect(r.ok).toBe(true);
  });
});
