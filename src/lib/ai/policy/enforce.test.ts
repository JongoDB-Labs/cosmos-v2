// src/lib/ai/policy/enforce.test.ts
import { describe, it, expect } from "vitest";
import { checkAgentPolicy } from "./enforce";
import { PERMISSIVE_AGENT_POLICY, type AgentPolicy } from "./index";

function policy(overrides: Partial<AgentPolicy>): AgentPolicy {
  return { ...PERMISSIVE_AGENT_POLICY, ...overrides };
}

describe("checkAgentPolicy — permissive default", () => {
  it("the PERMISSIVE default allows every tool with any args (no restriction)", () => {
    expect(checkAgentPolicy(PERMISSIVE_AGENT_POLICY, "query_finance", { limit: 9999 }))
      .toEqual({ action: "allow" });
    expect(checkAgentPolicy(PERMISSIVE_AGENT_POLICY, "create_work_item", { projectId: "p-anything", title: "x" }))
      .toEqual({ action: "allow" });
    expect(checkAgentPolicy(PERMISSIVE_AGENT_POLICY, "fetch_url", { url: "https://x" }))
      .toEqual({ action: "allow" });
  });
});

describe("checkAgentPolicy — AXIS 1: tools", () => {
  it("a tool in deniedTools is DENIED", () => {
    const d = checkAgentPolicy(policy({ deniedTools: ["fetch_url"] }), "fetch_url", {});
    expect(d.action).toBe("deny");
    expect(d.reason).toMatch(/tools axis/);
  });

  it("denylist WINS over an allowlist that includes the tool", () => {
    const d = checkAgentPolicy(
      policy({ allowedTools: ["fetch_url", "query_crm"], deniedTools: ["fetch_url"] }),
      "fetch_url",
      {},
    );
    expect(d.action).toBe("deny");
  });

  it("when allowedTools is SET, a tool not in it is DENIED", () => {
    const d = checkAgentPolicy(policy({ allowedTools: ["query_crm"] }), "create_work_item", {});
    expect(d.action).toBe("deny");
    expect(d.reason).toMatch(/allowlist/);
  });

  it("when allowedTools is SET, a tool IN it is allowed", () => {
    expect(checkAgentPolicy(policy({ allowedTools: ["query_crm"] }), "query_crm", {}))
      .toEqual({ action: "allow" });
  });

  it("an EMPTY allowedTools allowlist denies everything", () => {
    expect(checkAgentPolicy(policy({ allowedTools: [] }), "query_crm", {}).action).toBe("deny");
  });
});

describe("checkAgentPolicy — AXIS 2: domain", () => {
  it("a tool whose DOMAIN is denied is DENIED (finance ⇒ query_finance)", () => {
    const d = checkAgentPolicy(policy({ deniedDomains: ["finance"] }), "query_finance", {});
    expect(d.action).toBe("deny");
    expect(d.reason).toMatch(/domain axis/);
    expect(d.reason).toMatch(/finance/);
  });

  it("denying finance also blocks the other finance tools", () => {
    const p = policy({ deniedDomains: ["finance"] });
    for (const t of ["log_revenue", "log_expense", "get_trial_balance", "get_profit_and_loss"]) {
      expect(checkAgentPolicy(p, t, {}).action).toBe("deny");
    }
  });

  it("a tool in a NON-denied domain is allowed", () => {
    expect(checkAgentPolicy(policy({ deniedDomains: ["finance"] }), "query_work_items", {}))
      .toEqual({ action: "allow" });
  });
});

describe("checkAgentPolicy — AXIS 3a: projectId allowlist (deny)", () => {
  it("a projectId NOT in allowedProjectIds is DENIED", () => {
    const d = checkAgentPolicy(
      policy({ allowedProjectIds: ["p-allowed"] }),
      "create_work_item",
      { projectId: "p-other", title: "x" },
    );
    expect(d.action).toBe("deny");
    expect(d.reason).toMatch(/projectId/);
  });

  it("a projectId IN allowedProjectIds is allowed", () => {
    expect(
      checkAgentPolicy(policy({ allowedProjectIds: ["p-allowed"] }), "create_work_item", { projectId: "p-allowed", title: "x" }),
    ).toEqual({ action: "allow" });
  });

  it("a call WITHOUT a projectId is unaffected by the project allowlist", () => {
    expect(checkAgentPolicy(policy({ allowedProjectIds: ["p-allowed"] }), "query_crm", {}))
      .toEqual({ action: "allow" });
  });

  it("a non-string projectId arg is ignored (treated as absent)", () => {
    expect(
      checkAgentPolicy(policy({ allowedProjectIds: ["p-allowed"] }), "query_work_items", { projectId: 123 }),
    ).toEqual({ action: "allow" });
  });
});

describe("checkAgentPolicy — AXIS 3b: maxResultLimit clamp", () => {
  it("a `limit` above maxResultLimit is CLAMPED (not denied)", () => {
    const d = checkAgentPolicy(policy({ maxResultLimit: 10 }), "query_work_items", { projectId: "p", limit: 100 });
    expect(d.action).toBe("clamp");
    expect(d.clampedArgs).toEqual({ projectId: "p", limit: 10 });
    expect(d.reason).toMatch(/limit/);
  });

  it("clamps `maxResults` too", () => {
    const d = checkAgentPolicy(policy({ maxResultLimit: 5 }), "semantic_search", { maxResults: 50 });
    expect(d.action).toBe("clamp");
    expect(d.clampedArgs).toEqual({ maxResults: 5 });
  });

  it("a `limit` at or below the cap is allowed unchanged", () => {
    expect(checkAgentPolicy(policy({ maxResultLimit: 10 }), "query_work_items", { limit: 10 }))
      .toEqual({ action: "allow" });
    expect(checkAgentPolicy(policy({ maxResultLimit: 10 }), "query_work_items", { limit: 3 }))
      .toEqual({ action: "allow" });
  });

  it("does not mutate the original args object on clamp", () => {
    const args = { limit: 100 };
    checkAgentPolicy(policy({ maxResultLimit: 10 }), "query_work_items", args);
    expect(args.limit).toBe(100);
  });

  it("a non-number limit arg is ignored", () => {
    expect(checkAgentPolicy(policy({ maxResultLimit: 10 }), "query_work_items", { limit: "lots" }))
      .toEqual({ action: "allow" });
  });
});

describe("checkAgentPolicy — axis ordering (deny beats clamp)", () => {
  it("a denied tool with a clampable limit is DENIED, not clamped", () => {
    const d = checkAgentPolicy(
      policy({ deniedTools: ["query_work_items"], maxResultLimit: 10 }),
      "query_work_items",
      { limit: 100 },
    );
    expect(d.action).toBe("deny");
  });

  it("a denied DOMAIN with a clampable limit is DENIED, not clamped", () => {
    const d = checkAgentPolicy(
      policy({ deniedDomains: ["work_items"], maxResultLimit: 10 }),
      "query_work_items",
      { limit: 100 },
    );
    expect(d.action).toBe("deny");
  });
});
