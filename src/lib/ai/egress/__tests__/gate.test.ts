// src/lib/ai/egress/__tests__/gate.test.ts
import { describe, it, expect } from "vitest";
import { projectForModel } from "../gate";
import { isWithheld, type EgressContext } from "../types";

const base: Omit<EgressContext, "tenantClass" | "mode"> = { conversationId: "c1", turn: 0 };

describe("projectForModel", () => {
  it("passes the value through for a commercial tenant in passthrough mode", () => {
    const ctx: EgressContext = { ...base, tenantClass: "commercial", mode: "passthrough" };
    const r = projectForModel("the quarterly revenue is $4.2M", ctx, { valueKind: "tool_result", toolName: "get_finance_summary" });
    expect(r.modelValue).toBe("the quarterly revenue is $4.2M");
    expect(r.decision.exposed).toBe(true);
    expect(r.decision.decidedBy).toBe("none");
    expect(r.decision.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("withholds for a gov tenant even in passthrough mode (fail-closed)", () => {
    const ctx: EgressContext = { ...base, tenantClass: "gov", mode: "passthrough" };
    const r = projectForModel("CUI//SP-PROPIN payload", ctx, { valueKind: "tool_result" });
    expect(isWithheld(r.modelValue)).toBe(true);
    expect(r.decision.exposed).toBe(false);
    expect(r.decision.withheldCount).toBe(1);
    expect(r.decision.decidedBy).toBe("tenant");
  });

  it("never leaks the raw value into the decision record", () => {
    const ctx: EgressContext = { ...base, tenantClass: "gov", mode: "passthrough" };
    const secret = "CUI secret string";
    const r = projectForModel(secret, ctx, { valueKind: "tool_result" });
    expect(JSON.stringify(r.decision)).not.toContain(secret);
  });

  it("never throws on unserializable values (BigInt / circular) and still fails closed", () => {
    const ctx: EgressContext = { ...base, tenantClass: "gov", mode: "passthrough" };
    // BigInt mirrors OrgMember.permissions; the circular ref carries CUI in a key.
    const circular: Record<string, unknown> = { SECRET_CUI_FIELD: "x" };
    circular.self = circular;
    for (const bad of [{ perms: 10n } as unknown, circular]) {
      const r = projectForModel(bad, ctx, { valueKind: "tool_result" });
      expect(isWithheld(r.modelValue)).toBe(true); // fail-closed
      expect(r.decision.contentHash).toMatch(/^[0-9a-f]{64}$/); // hashed, didn't throw
      expect(JSON.stringify(r.decision)).not.toContain("SECRET_CUI_FIELD");
    }
  });
});
