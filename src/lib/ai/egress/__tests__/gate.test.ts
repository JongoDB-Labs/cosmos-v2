import { describe, it, expect } from "vitest";
import { projectForModel } from "../gate";
import { isWithheld, type EgressContext } from "../types";

const ctxOf = (tenantClass: "gov" | "commercial"): EgressContext =>
  ({ orgId: "o1", conversationId: "c1", turn: 0, tenantClass, mode: "enforced" });

describe("projectForModel (enforced policy)", () => {
  it("commercial EXPOSES unclassified tool data", () => {
    const r = projectForModel("2 open tasks", ctxOf("commercial"), { valueKind: "tool_result", ceiling: "UNCLASSIFIED" });
    expect(r.modelValue).toBe("2 open tasks");
    expect(r.decision.exposed).toBe(true);
  });
  it("commercial WITHHOLDS CUI tool data (mandatory ceiling)", () => {
    const r = projectForModel("CUI payload", ctxOf("commercial"), { valueKind: "tool_result", ceiling: "CUI" });
    expect(isWithheld(r.modelValue)).toBe(true);
    expect(r.decision.decidedBy).toBe("classification");
  });
  it("a CUI project in a COMMERCIAL org is still withheld (data-driven, not tenant-driven)", () => {
    const r = projectForModel("secret", ctxOf("commercial"), { valueKind: "tool_result", ceiling: "FOUO" });
    expect(isWithheld(r.modelValue)).toBe(true);
  });
  it("gov WITHHOLDS even unclassified tool data (default-deny)", () => {
    const r = projectForModel("anything", ctxOf("gov"), { valueKind: "tool_result", ceiling: "UNCLASSIFIED" });
    expect(isWithheld(r.modelValue)).toBe(true);
    expect(r.decision.decidedBy).toBe("tenant");
  });
  it("system + user prompts ALWAYS flow (non-data) for both tenants", () => {
    for (const tc of ["gov", "commercial"] as const) {
      for (const kind of ["system", "user"] as const) {
        const r = projectForModel("you are cosmos", ctxOf(tc), { valueKind: kind, ceiling: "UNCLASSIFIED" });
        expect(r.decision.exposed).toBe(true);
      }
    }
  });
  it("never throws on unserializable data and fails closed (gov)", () => {
    const circ: Record<string, unknown> = { SECRET: "x" }; circ.self = circ;
    const r = projectForModel(circ, ctxOf("gov"), { valueKind: "tool_result", ceiling: "UNCLASSIFIED" });
    expect(isWithheld(r.modelValue)).toBe(true);
    expect(JSON.stringify(r.decision)).not.toContain("SECRET");
  });
  it("marking tripwire — commercial+UNCLASSIFIED user prompt containing CUI marking is WITHHELD (allow→deny)", () => {
    // Without the tripwire this would be exposed (system/user kind, non-data, commercial tenant).
    // The marking "CUI//SP secret" triggers detectMarkings → override exposed=false.
    const r = projectForModel("CUI//SP secret notes from the meeting", ctxOf("commercial"), { valueKind: "user", ceiling: "UNCLASSIFIED" });
    expect(isWithheld(r.modelValue)).toBe(true);
    expect(r.decision.exposed).toBe(false);
    expect(r.decision.decidedBy).toBe("classification");
  });
  it("marking tripwire — clean user prompt still flows (no false positive)", () => {
    const r = projectForModel("summarize the open tasks", ctxOf("commercial"), { valueKind: "user", ceiling: "UNCLASSIFIED" });
    expect(r.decision.exposed).toBe(true);
    expect(typeof r.modelValue).toBe("string");
  });
});
