import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTAKE_POLICY,
  normalizeIntakePolicyInput,
  readIntakePolicy,
  serializeIntakePolicy,
  type IntakePolicy,
} from "./intake-policy";

/**
 * intake-policy is the single normalized view over the four org-tunable intake
 * knobs (rate limits, auto-trigger roles, classifier confidence, high-risk
 * zones), each with a SAFE DEFAULT. The config-round-trip + defaults guarantees
 * are covered here since the config route, the settings form, and the
 * remediation loop all inherit whatever this gets wrong.
 */

describe("readIntakePolicy — safe defaults", () => {
  it("an empty / missing / non-object settings yields exactly the default policy", () => {
    for (const input of [{}, null, undefined, 42, "x", []]) {
      expect(readIntakePolicy(input)).toEqual(DEFAULT_INTAKE_POLICY);
    }
  });

  it("the default policy is members-and-above, medium confidence, all zones on, permissive caps", () => {
    expect(DEFAULT_INTAKE_POLICY.autoTriggerRoles).toEqual(["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER"]);
    expect(DEFAULT_INTAKE_POLICY.classifier.judgeMinConfidence).toBe("medium");
    expect(DEFAULT_INTAKE_POLICY.highRiskZones).toEqual([
      "auth",
      "secrets",
      "billing",
      "data-destructive",
      "security-egress",
      "dependencies",
    ]);
    expect(DEFAULT_INTAKE_POLICY.rateLimits).toEqual({
      perUserPerRun: 10,
      perOrgPerRun: 50,
      maxQueueDepth: 100,
      buildBudget: 100,
    });
  });

  it("a malformed classifier value falls back to the default confidence", () => {
    expect(readIntakePolicy({ classifierPolicy: { judgeMinConfidence: "banana" } }).classifier).toEqual({
      judgeMinConfidence: "medium",
    });
  });

  it("an explicit empty highRiskZones array is honoured (every advisory zone off)", () => {
    expect(readIntakePolicy({ highRiskZones: [] }).highRiskZones).toEqual([]);
  });

  it("unknown high-risk-zone keys are dropped and the rest are canonically ordered", () => {
    expect(readIntakePolicy({ highRiskZones: ["billing", "made-up", "auth"] }).highRiskZones).toEqual([
      "auth",
      "billing",
    ]);
  });
});

describe("readIntakePolicy — config round-trip", () => {
  it("read(serialize(policy)) === policy for a normalized custom policy", () => {
    const policy: IntakePolicy = {
      rateLimits: { perUserPerRun: 2, perOrgPerRun: 5, maxQueueDepth: 8, buildBudget: 4 },
      autoTriggerRoles: ["OWNER", "ADMIN"],
      classifier: { judgeMinConfidence: "high" },
      highRiskZones: ["auth", "billing"],
    };
    expect(readIntakePolicy(serializeIntakePolicy(policy))).toEqual(policy);
  });

  it("the default policy round-trips through serialize → read unchanged", () => {
    expect(readIntakePolicy(serializeIntakePolicy(DEFAULT_INTAKE_POLICY))).toEqual(DEFAULT_INTAKE_POLICY);
  });

  it("serialize writes the same keys the remediation loop reads", () => {
    const serialized = serializeIntakePolicy(DEFAULT_INTAKE_POLICY);
    expect(Object.keys(serialized).sort()).toEqual([
      "autoTriggerRoles",
      "classifierPolicy",
      "highRiskZones",
      "intakeLimits",
    ]);
  });
});

describe("normalizeIntakePolicyInput — untrusted form payloads", () => {
  it("drops bogus roles, de-dupes, and canonically orders; empty → default", () => {
    expect(normalizeIntakePolicyInput({ autoTriggerRoles: ["ADMIN", "OWNER", "ADMIN", "NOPE"] }).autoTriggerRoles).toEqual([
      "OWNER",
      "ADMIN",
    ]);
    expect(normalizeIntakePolicyInput({ autoTriggerRoles: [] }).autoTriggerRoles).toEqual(
      DEFAULT_INTAKE_POLICY.autoTriggerRoles,
    );
    expect(normalizeIntakePolicyInput({ autoTriggerRoles: "not-array" }).autoTriggerRoles).toEqual(
      DEFAULT_INTAKE_POLICY.autoTriggerRoles,
    );
  });

  it("clamps negative / non-integer rate limits to non-negative integers", () => {
    const out = normalizeIntakePolicyInput({
      rateLimits: { perUserPerRun: -3, perOrgPerRun: 2.6, maxQueueDepth: "x", buildBudget: 7 },
    });
    expect(out.rateLimits).toEqual({ perUserPerRun: 0, perOrgPerRun: 3, maxQueueDepth: 100, buildBudget: 7 });
  });

  it("falls back to the full default policy for garbage input", () => {
    expect(normalizeIntakePolicyInput(null)).toEqual(DEFAULT_INTAKE_POLICY);
    expect(normalizeIntakePolicyInput("nope")).toEqual(DEFAULT_INTAKE_POLICY);
  });

  it("normalize is idempotent (feeding a normalized policy back in yields the same)", () => {
    const once = normalizeIntakePolicyInput({
      rateLimits: { perUserPerRun: 1, perOrgPerRun: 1, maxQueueDepth: 1, buildBudget: 1 },
      autoTriggerRoles: ["MEMBER"],
      classifier: { judgeMinConfidence: "low" },
      highRiskZones: ["auth"],
    });
    expect(normalizeIntakePolicyInput(once)).toEqual(once);
  });
});
