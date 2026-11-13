import { describe, expect, it } from "vitest";
import {
  automationAuditDelta,
  automationWidening,
  pruneToProjects,
  readAutomationConfig,
  validateEnableGate,
  widensAutomation,
  type AutomationConfig,
} from "./automation-config";

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
  autonomousDelivery: { enabled: false, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 },
};

describe("autonomousDelivery.workers", () => {
  it("defaults to 2 when absent (legacy configs)", () => {
    const cfg = readAutomationConfig({ autonomousDelivery: { enabled: true, projectIds: ["a"] } });
    expect(cfg.autonomousDelivery.workers).toBe(2);
  });
  it("clamps to 1..3 and rounds non-integers", () => {
    for (const [input, want] of [[0, 1], [1, 1], [3, 3], [9, 3], [2.6, 3], [-4, 1], ["x", 2]] as const) {
      const cfg = readAutomationConfig({ autonomousDelivery: { enabled: true, projectIds: ["a"], workers: input } });
      expect(cfg.autonomousDelivery.workers).toBe(want);
    }
  });
  it("pruneToProjects carries workers through", () => {
    const cfg = readAutomationConfig({ autonomousDelivery: { enabled: true, projectIds: ["a"], workers: 3 } });
    const pruned = pruneToProjects(cfg, new Set(["a"]));
    expect(pruned.autonomousDelivery.workers).toBe(3);
  });
});

describe("autonomousDelivery.notify", () => {
  it("defaults BOTH events ON when absent (legacy configs)", () => {
    const cfg = readAutomationConfig({ autonomousDelivery: { enabled: true, projectIds: ["a"] } });
    expect(cfg.autonomousDelivery.notify).toEqual({ parked: true, shipped: true });
  });
  it("honors an explicit false per event", () => {
    const cfg = readAutomationConfig({ autonomousDelivery: { enabled: true, projectIds: ["a"], notify: { parked: false, shipped: true }, workers: 2 } });
    expect(cfg.autonomousDelivery.notify).toEqual({ parked: false, shipped: true });
  });
  it("pruneToProjects carries notify through untouched", () => {
    const cfg = readAutomationConfig({ autonomousDelivery: { enabled: true, projectIds: ["a"], notify: { parked: false, shipped: false }, workers: 2 } });
    const pruned = pruneToProjects(cfg, new Set(["a"]));
    expect(pruned.autonomousDelivery.notify).toEqual({ parked: false, shipped: false });
  });
});

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
    const cfg = readAutomationConfig({ autonomousDelivery: { enabled: true, notify: { parked: true, shipped: true }, workers: 2 } });
    expect(cfg.autonomousDelivery).toEqual({ enabled: true, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 });
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
      autonomousDelivery: { enabled: true, projectIds: ["x", false, "y"], notify: { parked: true, shipped: true }, workers: 2 },
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
      autonomousDelivery: { enabled: true, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 },
    };
    expect(validateEnableGate(cfg)).toBe("Select at least one project before enabling autonomous delivery.");
  });

  it("returns null when both automations are disabled", () => {
    expect(validateEnableGate(EMPTY)).toBeNull();
  });

  it("returns null when both automations are enabled with a valid scope", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: ["a", "b"], defaultProjectId: "b" },
      autonomousDelivery: { enabled: true, projectIds: ["c"], notify: { parked: true, shipped: true }, workers: 2 },
    };
    expect(validateEnableGate(cfg)).toBeNull();
  });

  it("returns the FIRST failing reason when multiple gates fail at once", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: [], defaultProjectId: null },
      autonomousDelivery: { enabled: true, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 },
    };
    expect(validateEnableGate(cfg)).toBe(
      "Select at least one project to receive triaged feedback before enabling auto-triage."
    );
  });
});

describe("pruneToProjects", () => {
  it("drops a stale id from both autoRemediation.projectIds and autonomousDelivery.projectIds", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: ["a", "stale"], defaultProjectId: "a" },
      autonomousDelivery: { enabled: true, projectIds: ["b", "stale"], notify: { parked: true, shipped: true }, workers: 2 },
    };
    const pruned = pruneToProjects(cfg, new Set(["a", "b"]));
    expect(pruned.autoRemediation.projectIds).toEqual(["a"]);
    expect(pruned.autonomousDelivery.projectIds).toEqual(["b"]);
  });

  it("clears defaultProjectId to null when it pointed at a dropped id", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: ["a", "stale"], defaultProjectId: "stale" },
      autonomousDelivery: { enabled: false, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 },
    };
    const pruned = pruneToProjects(cfg, new Set(["a"]));
    expect(pruned.autoRemediation.defaultProjectId).toBeNull();
  });

  it("keeps defaultProjectId when it's still among the pruned projectIds", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: ["a", "b"], defaultProjectId: "b" },
      autonomousDelivery: { enabled: false, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 },
    };
    const pruned = pruneToProjects(cfg, new Set(["a", "b", "c"]));
    expect(pruned.autoRemediation.projectIds).toEqual(["a", "b"]);
    expect(pruned.autoRemediation.defaultProjectId).toBe("b");
  });

  it("drops nothing when every referenced id is valid", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: ["a", "b"], defaultProjectId: "a" },
      autonomousDelivery: { enabled: true, projectIds: ["b"], notify: { parked: true, shipped: true }, workers: 2 },
    };
    expect(pruneToProjects(cfg, new Set(["a", "b"]))).toEqual(cfg);
  });

  it("disables a block (and clears the default) when pruning empties its scope — an automation with no projects can't run, and enabled-but-empty wedges the form", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: ["stale1", "stale2"], defaultProjectId: "stale1" },
      autonomousDelivery: { enabled: true, projectIds: ["stale3"], notify: { parked: true, shipped: true }, workers: 2 },
    };
    const pruned = pruneToProjects(cfg, new Set());
    expect(pruned.autoRemediation).toEqual({ enabled: false, projectIds: [], defaultProjectId: null });
    expect(pruned.autonomousDelivery).toEqual({ enabled: false, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 });
  });

  it("keeps `enabled` when at least one project survives the prune", () => {
    const cfg: AutomationConfig = {
      autoRemediation: { enabled: true, projectIds: ["a", "stale"], defaultProjectId: "a" },
      autonomousDelivery: { enabled: true, projectIds: ["a", "stale"], notify: { parked: true, shipped: true }, workers: 2 },
    };
    const pruned = pruneToProjects(cfg, new Set(["a"]));
    expect(pruned.autoRemediation).toEqual({ enabled: true, projectIds: ["a"], defaultProjectId: "a" });
    expect(pruned.autonomousDelivery).toEqual({ enabled: true, projectIds: ["a"], notify: { parked: true, shipped: true }, workers: 2 });
  });
});

describe("widensAutomation — what needs the instance operator", () => {
  const cfg = (
    triage: { enabled: boolean; projectIds: string[] },
    delivery: { enabled: boolean; projectIds: string[]; notify?: { parked: boolean; shipped: boolean }; workers?: number },
  ): AutomationConfig => ({
    autoRemediation: { ...triage, defaultProjectId: triage.projectIds[0] ?? null },
    autonomousDelivery: { notify: { parked: true, shipped: true }, workers: 2, ...delivery },
  });
  const off = cfg({ enabled: false, projectIds: [] }, { enabled: false, projectIds: [] });

  it("turning either automation on widens", () => {
    expect(widensAutomation(off, cfg({ enabled: true, projectIds: [] }, { enabled: false, projectIds: [] }))).toBe(true);
    expect(widensAutomation(off, cfg({ enabled: false, projectIds: [] }, { enabled: true, projectIds: [] }))).toBe(true);
  });

  it("adding a project to either list widens, whether or not that automation is on", () => {
    const on = cfg({ enabled: true, projectIds: ["a"] }, { enabled: true, projectIds: ["a"] });
    expect(widensAutomation(on, cfg({ enabled: true, projectIds: ["a", "b"] }, { enabled: true, projectIds: ["a"] }))).toBe(true);
    expect(widensAutomation(on, cfg({ enabled: true, projectIds: ["a"] }, { enabled: true, projectIds: ["a", "b"] }))).toBe(true);
    expect(widensAutomation(off, cfg({ enabled: false, projectIds: [] }, { enabled: false, projectIds: ["a"] }))).toBe(true);
  });

  it("swapping one project for another widens: the count is unchanged but a new project joins", () => {
    const on = cfg({ enabled: false, projectIds: [] }, { enabled: true, projectIds: ["a", "b"] });
    expect(widensAutomation(on, cfg({ enabled: false, projectIds: [] }, { enabled: true, projectIds: ["a", "c"] }))).toBe(true);
  });

  it("turning off, removing projects, notify changes and fewer workers never widen", () => {
    const on = cfg({ enabled: true, projectIds: ["a", "b"] }, { enabled: true, projectIds: ["a", "b"] });
    expect(widensAutomation(on, on)).toBe(false);
    expect(widensAutomation(on, off)).toBe(false);
    expect(widensAutomation(on, cfg({ enabled: true, projectIds: ["b"] }, { enabled: true, projectIds: ["a"] }))).toBe(false);
    expect(
      widensAutomation(
        on,
        cfg({ enabled: true, projectIds: ["b", "a"] }, { enabled: true, projectIds: ["a", "b"], notify: { parked: false, shipped: false }, workers: 1 }),
      ),
    ).toBe(false);
  });

  it("raising parallel build workers widens, on or off: the shared pool runs the highest count any enabled org asks for", () => {
    const at = (workers: number, enabled = true) => cfg({ enabled: false, projectIds: [] }, { enabled, projectIds: ["a"], workers });
    expect(widensAutomation(at(2), at(3))).toBe(true);
    expect(widensAutomation(at(1), at(2))).toBe(true);
    expect(widensAutomation(at(1, false), at(3, false))).toBe(true);
    expect(widensAutomation(at(3), at(2))).toBe(false);
    expect(widensAutomation(at(2), at(2))).toBe(false);
  });

  it("a legacy config with no stored worker count reads as the default 2, so asking for 3 widens and 2 does not", () => {
    const stored = readAutomationConfig({ autonomousDelivery: { enabled: true, projectIds: ["a"] } });
    expect(widensAutomation(stored, cfg({ enabled: false, projectIds: [] }, { enabled: true, projectIds: ["a"], workers: 3 }))).toBe(true);
    expect(widensAutomation(stored, cfg({ enabled: false, projectIds: [] }, { enabled: true, projectIds: ["a"], workers: 2 }))).toBe(false);
  });

  it("compares against the legacy stored shape as normalized: an unchanged legacy target is not an addition", () => {
    const stored = readAutomationConfig({ autoRemediation: { enabled: true, targetProjectId: "a" } });
    expect(widensAutomation(stored, cfg({ enabled: true, projectIds: ["a"] }, { enabled: false, projectIds: [] }))).toBe(false);
  });
});

describe("automationWidening — what a refused request asked for, as counts", () => {
  const base: AutomationConfig = {
    autoRemediation: { enabled: false, projectIds: ["a"], defaultProjectId: "a" },
    autonomousDelivery: { enabled: true, projectIds: ["a"], notify: { parked: true, shipped: true }, workers: 2 },
  };

  it("names each widening and counts added projects, never which", () => {
    const widening = automationWidening(base, {
      autoRemediation: { enabled: true, projectIds: ["a", "b", "c"], defaultProjectId: "a" },
      autonomousDelivery: { ...base.autonomousDelivery, projectIds: ["a", "b", "b"], workers: 3 },
    });
    expect(widening).toEqual({
      turnsOnAutoTriage: true,
      turnsOnDelivery: false,
      autoTriageProjectsAdded: 2,
      deliveryProjectsAdded: 1,
      workersBefore: 2,
      workersAfter: 3,
    });
    expect(JSON.stringify(widening)).not.toMatch(/"a"|"b"|"c"/);
  });

  it("is all-false and zero for a change that narrows", () => {
    expect(
      automationWidening(base, { ...base, autonomousDelivery: { ...base.autonomousDelivery, enabled: false, workers: 1 } }),
    ).toEqual({
      turnsOnAutoTriage: false,
      turnsOnDelivery: false,
      autoTriageProjectsAdded: 0,
      deliveryProjectsAdded: 0,
      workersBefore: 2,
      workersAfter: 1,
    });
  });
});

describe("automationAuditDelta — what gets audited", () => {
  const base: AutomationConfig = {
    autoRemediation: { enabled: true, projectIds: ["a", "b"], defaultProjectId: "a" },
    autonomousDelivery: { enabled: true, projectIds: ["a"], notify: { parked: true, shipped: true }, workers: 2 },
  };

  it("is null when neither flag, project list nor worker count moved, even if notify or order did", () => {
    expect(automationAuditDelta(base, base)).toBeNull();
    expect(
      automationAuditDelta(base, {
        autoRemediation: { enabled: true, projectIds: ["b", "a"], defaultProjectId: "b" },
        autonomousDelivery: { ...base.autonomousDelivery, notify: { parked: false, shipped: true } },
      }),
    ).toBeNull();
  });

  it("records a change in parallel build workers, either way", () => {
    expect(automationAuditDelta(base, { ...base, autonomousDelivery: { ...base.autonomousDelivery, workers: 3 } })).toMatchObject({
      workersBefore: 2,
      workersAfter: 3,
    });
    expect(automationAuditDelta(base, { ...base, autonomousDelivery: { ...base.autonomousDelivery, workers: 1 } })).toMatchObject({
      workersBefore: 2,
      workersAfter: 1,
    });
  });

  it("records flags before and after and project COUNTS, never project ids", () => {
    const delta = automationAuditDelta(base, { ...base, autonomousDelivery: { ...base.autonomousDelivery, enabled: false } });
    expect(delta).toEqual({
      autoTriageEnabledBefore: true,
      autoTriageEnabledAfter: true,
      autoTriageProjectsBefore: 2,
      autoTriageProjectsAfter: 2,
      deliveryEnabledBefore: true,
      deliveryEnabledAfter: false,
      deliveryProjectsBefore: 1,
      deliveryProjectsAfter: 1,
      workersBefore: 2,
      workersAfter: 2,
    });
    expect(JSON.stringify(delta)).not.toMatch(/"a"|"b"/);
  });

  it("records a same-size swap of projects", () => {
    const delta = automationAuditDelta(base, { ...base, autonomousDelivery: { ...base.autonomousDelivery, projectIds: ["c"] } });
    expect(delta).toMatchObject({ deliveryProjectsBefore: 1, deliveryProjectsAfter: 1 });
  });
});
