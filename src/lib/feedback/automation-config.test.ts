import { describe, expect, it } from "vitest";
import { readAutomationConfig, validateEnableGate, type AutomationConfig } from "./automation-config";

/**
 * automation-config is the single place that turns an org's untrusted
 * `settings` JSON into a normalized AutomationConfig (with back-compat for
 * the legacy single-project auto-remediation shape) and gates "enabled
 * without a valid project scope." It's shared by the config route, triage,
 * and Foreman — every consumer inherits whatever this gets wrong, so the
 * normalization + gate rules are covered exhaustively here rather than
 * per-consumer.
 */

const EMPTY: AutomationConfig = {
  autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
  autonomousDelivery: { enabled: false, projectIds: [] },
};

describe("readAutomationConfig", () => {
  it("normalizes the legacy single-project shape (targetProjectId) into projectIds + defaultProjectId", () => {
    const cfg = readAutomationConfig({
      autoRemediation: { enabled: true, targetProjectId: "p1" },
    });
    expect(cfg.autoRemediation).toEqual({
      enabled: true,
      projectIds: ["p1"],
      defaultProjectId: "p1",
    });
  });

  it("passes the new multi-project shape through unchanged", () => {
    const cfg = readAutomationConfig({
      autoRemediation: { enabled: true, projectIds: ["a", "b"], defaultProjectId: "b" },
    });
    expect(cfg.autoRemediation).toEqual({
      enabled: true,
      projectIds: ["a", "b"],
      defaultProjectId: "b",
    });
  });

  it("prefers a new-shape projectIds array over a stray legacy targetProjectId", () => {
    const cfg = readAutomationConfig({
      autoRemediation: { enabled: true, projectIds: ["a"], targetProjectId: "legacy-should-be-ignored" },
    });
    expect(cfg.autoRemediation.projectIds).toEqual(["a"]);
  });

  it("reads a bare autonomousDelivery.enabled with no projectIds as enabled + empty scope", () => {
    const cfg = readAutomationConfig({ autonomousDelivery: { enabled: true } });
    expect(cfg.autonomousDelivery).toEqual({ enabled: true, projectIds: [] });
  });

  it("treats undefined settings as all-empty/false without throwing", () => {
    expect(() => readAutomationConfig(undefined)).not.toThrow();
    expect(readAutomationConfig(undefined)).toEqual(EMPTY);
  });

  it("treats null settings as all-empty/false without throwing", () => {
    expect(() => readAutomationConfig(null)).not.toThrow();
    expect(readAutomationConfig(null)).toEqual(EMPTY);
  });

  it("treats a non-object primitive settings value as all-empty/false without throwing", () => {
    expect(() => readAutomationConfig(42)).not.toThrow();
    expect(readAutomationConfig(42)).toEqual(EMPTY);
  });

  it("treats an empty object as all-empty/false", () => {
    expect(readAutomationConfig({})).toEqual(EMPTY);
  });

  it("filters non-string entries out of a garbage-mixed projectIds array", () => {
    const cfg = readAutomationConfig({
      autoRemediation: { enabled: true, projectIds: ["a", 1, null, "b"] },
    });
    expect(cfg.autoRemediation.projectIds).toEqual(["a", "b"]);
  });

  it("falls back to defaultProjectId: null when defaultProjectId isn't a string", () => {
    const cfg = readAutomationConfig({
      autoRemediation: { enabled: true, projectIds: ["a"], defaultProjectId: 42 },
    });
    expect(cfg.autoRemediation.defaultProjectId).toBeNull();
  });

  it("falls back to the legacy shape when projectIds is present but not an array", () => {
    const cfg = readAutomationConfig({
      autoRemediation: { enabled: true, projectIds: "not-an-array", targetProjectId: "p1" },
    });
    expect(cfg.autoRemediation).toEqual({
      enabled: true,
      projectIds: ["p1"],
      defaultProjectId: "p1",
    });
  });

  it("doesn't throw when autoRemediation/autonomousDelivery sub-fields are non-object garbage", () => {
    expect(() => readAutomationConfig({ autoRemediation: "garbage", autonomousDelivery: 7 })).not.toThrow();
    const cfg = readAutomationConfig({ autoRemediation: "garbage", autonomousDelivery: 7 });
    expect(cfg).toEqual(EMPTY);
  });

  it("filters non-string entries out of autonomousDelivery.projectIds", () => {
    const cfg = readAutomationConfig({
      autonomousDelivery: { enabled: true, projectIds: ["x", false, "y"] },
    });
    expect(cfg.autonomousDelivery.projectIds).toEqual(["x", "y"]);
  });
});

describe("validateEnableGate", () => {
  it("requires at least one project before enabling auto-triage", () => {
    const cfg: AutomationConfig = {
      ...EMPTY,
      autoRemediation: { enabled: true, projectIds: [], defaultProjectId: null },
    };
    expect(validateEnableGate(cfg)).toBe(
      "Select at least one project to receive triaged feedback before enabling auto-triage."
    );
  });

  it("requires a default project that is one of the selected projects", () => {
    const cfg: AutomationConfig = {
      ...EMPTY,
      autoRemediation: { enabled: true, projectIds: ["a", "b"], defaultProjectId: "c" },
    };
    expect(validateEnableGate(cfg)).toBe(
      "Choose a default project (one of the selected projects) before enabling auto-triage."
    );
  });

  it("rejects a null defaultProjectId even when projectIds is non-empty", () => {
    const cfg: AutomationConfig = {
      ...EMPTY,
      autoRemediation: { enabled: true, projectIds: ["a"], defaultProjectId: null },
    };
    expect(validateEnableGate(cfg)).toBe(
      "Choose a default project (one of the selected projects) before enabling auto-triage."
    );
  });

  it("requires at least one project before enabling autonomous delivery", () => {
    const cfg: AutomationConfig = {
      ...EMPTY,
      autonomousDelivery: { enabled: true, projectIds: [] },
    };
    expect(validateEnableGate(cfg)).toBe("Select at least one project before enabling autonomous delivery.");
  });

  it("returns null when both automations are disabled", () => {
    expect(validateEnableGate(EMPTY)).toBeNull();
  });

  it("returns null when both automations are enabled with a valid scope", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: ["a", "b"], defaultProjectId: "b" },
      autonomousDelivery: { enabled: true, projectIds: ["c"] },
    };
    expect(validateEnableGate(cfg)).toBeNull();
  });

  it("returns the FIRST failing reason when multiple gates fail at once", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: [], defaultProjectId: null },
      autonomousDelivery: { enabled: true, projectIds: [] },
    };
    expect(validateEnableGate(cfg)).toBe(
      "Select at least one project to receive triaged feedback before enabling auto-triage."
    );
  });
});
