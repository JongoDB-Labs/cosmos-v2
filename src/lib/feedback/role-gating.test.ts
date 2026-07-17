import { describe, expect, it } from "vitest";
import type { OrgRole } from "@prisma/client";
import {
  DEFAULT_AUTO_TRIGGER_ROLES,
  ORG_ROLES,
  canRoleAutoTrigger,
  readRoleGateConfig,
  roleGateMessage,
  type RoleGateConfig,
} from "./role-gating";

/**
 * Pure-decision coverage for role-based auto-trigger gating (COSMOS-120, Phase 3b).
 * The full `runFeedbackRemediation` wiring (author-role lookup, human-triage park,
 * audit + submitter notification) is covered against the real e2e DB in
 * remediate.test.ts; this file pins the deterministic decision logic + config
 * normalization / round-trip.
 */

describe("readRoleGateConfig", () => {
  it("falls back to the members-and-above default for absent / malformed settings", () => {
    const dflt = { autoTriggerRoles: [...DEFAULT_AUTO_TRIGGER_ROLES] };
    expect(readRoleGateConfig(undefined)).toEqual(dflt);
    expect(readRoleGateConfig(null)).toEqual(dflt);
    expect(readRoleGateConfig({})).toEqual(dflt);
    expect(readRoleGateConfig({ autoTriggerRoles: "nope" })).toEqual(dflt);
    expect(readRoleGateConfig({ autoTriggerRoles: {} })).toEqual(dflt);
    // An array with no VALID roles is treated as "unset" → default (never an
    // empty allow-set, which would gate everyone including owners).
    expect(readRoleGateConfig({ autoTriggerRoles: ["ROOT", 42, null] })).toEqual(dflt);
    expect(readRoleGateConfig({ autoTriggerRoles: [] })).toEqual(dflt);
  });

  it("excludes VIEWER and GUEST from the default set", () => {
    const { autoTriggerRoles } = readRoleGateConfig(undefined);
    expect(autoTriggerRoles).toContain("MEMBER");
    expect(autoTriggerRoles).toContain("OWNER");
    expect(autoTriggerRoles).not.toContain("VIEWER");
    expect(autoTriggerRoles).not.toContain("GUEST");
  });

  it("reads a configured set, dropping bogus entries and de-duplicating", () => {
    const cfg = readRoleGateConfig({
      autoTriggerRoles: ["MEMBER", "GUEST", "MEMBER", "NOT_A_ROLE", 7],
    });
    expect(cfg.autoTriggerRoles).toEqual(["MEMBER", "GUEST"]);
  });

  it("normalizes to canonical (most-trusted-first) order regardless of input order", () => {
    const cfg = readRoleGateConfig({ autoTriggerRoles: ["GUEST", "OWNER", "MEMBER"] });
    expect(cfg.autoTriggerRoles).toEqual(["OWNER", "MEMBER", "GUEST"]);
  });

  it("round-trips: reading a normalized config's own roles yields the same config", () => {
    const first = readRoleGateConfig({ autoTriggerRoles: ["GUEST", "MEMBER", "OWNER"] });
    const second = readRoleGateConfig({ autoTriggerRoles: first.autoTriggerRoles });
    expect(second).toEqual(first);
    // ...and it survives a JSON serialize/parse through org settings storage.
    const persisted = JSON.parse(JSON.stringify({ autoTriggerRoles: first.autoTriggerRoles }));
    expect(readRoleGateConfig(persisted)).toEqual(first);
  });
});

describe("canRoleAutoTrigger — default policy (members and above)", () => {
  const cfg = readRoleGateConfig(undefined);

  const expectations: Array<[OrgRole, boolean]> = [
    ["OWNER", true],
    ["ADMIN", true],
    ["BILLING_ADMIN", true],
    ["MEMBER", true],
    ["VIEWER", false],
    ["GUEST", false],
  ];

  for (const [role, allowed] of expectations) {
    it(`${role} → ${allowed ? "auto-trigger" : "human triage"}`, () => {
      expect(canRoleAutoTrigger(role, cfg)).toBe(allowed);
    });
  }

  it("covers every OrgRole in the enum (no role left unclassified)", () => {
    const covered = new Set(expectations.map(([r]) => r));
    for (const role of ORG_ROLES) expect(covered.has(role)).toBe(true);
  });

  it("treats a null / unknown / unresolvable submitter role as lowest-trust", () => {
    expect(canRoleAutoTrigger(null, cfg)).toBe(false);
    expect(canRoleAutoTrigger(undefined, cfg)).toBe(false);
    expect(canRoleAutoTrigger("NOT_A_ROLE" as OrgRole, cfg)).toBe(false);
  });
});

describe("canRoleAutoTrigger — per-org override", () => {
  it("honors a widened set (e.g. an org that trusts VIEWERs to auto-trigger)", () => {
    const cfg: RoleGateConfig = readRoleGateConfig({
      autoTriggerRoles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
    });
    expect(canRoleAutoTrigger("VIEWER", cfg)).toBe(true);
    expect(canRoleAutoTrigger("GUEST", cfg)).toBe(false);
  });

  it("honors a tightened set (e.g. only owners/admins auto-trigger)", () => {
    const cfg: RoleGateConfig = readRoleGateConfig({ autoTriggerRoles: ["OWNER", "ADMIN"] });
    expect(canRoleAutoTrigger("OWNER", cfg)).toBe(true);
    expect(canRoleAutoTrigger("MEMBER", cfg)).toBe(false);
    expect(canRoleAutoTrigger("VIEWER", cfg)).toBe(false);
  });
});

describe("roleGateMessage", () => {
  it("is a non-empty submitter-facing string that names no internal role", () => {
    const msg = roleGateMessage();
    expect(msg.length).toBeGreaterThan(0);
    for (const role of ORG_ROLES) expect(msg).not.toContain(role);
  });
});
