import { describe, it, expect } from "vitest";
import { validateDefinition, workflowDefinitionSchema, type StatusRef, type WorkflowDefinition } from "../definition";

const STATUSES: StatusRef[] = [
  { key: "todo", category: "TODO" },
  { key: "doing", category: "IN_PROGRESS" },
  { key: "review", category: "IN_PROGRESS" },
  { key: "done", category: "DONE" },
  { key: "cancelled", category: "CANCELLED" },
];

function def(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schemaVersion: 1,
    statuses: [{ key: "todo", isInitial: true }, { key: "doing" }, { key: "review" }, { key: "done" }],
    transitions: [
      { id: "start", name: "Start", from: ["todo"], to: "doing" },
      { id: "submit", name: "Submit", from: ["doing"], to: "review" },
      { id: "resolve", name: "Resolve", from: ["review"], to: "done" },
      { id: "reopen", name: "Reopen", from: "*", to: "todo" },
    ],
    ...over,
  };
}

const codes = (d: WorkflowDefinition) => validateDefinition(d, STATUSES).map((i) => `${i.severity}:${i.code}`);

describe("workflowDefinitionSchema", () => {
  it("accepts a well-formed definition", () => {
    expect(workflowDefinitionSchema.safeParse(def()).success).toBe(true);
  });

  it("rejects an unknown condition kind rather than ignoring it", () => {
    const bad = def({
      transitions: [{ id: "t", name: "T", from: "*", to: "done", restrict: { kind: "runScript", code: "x" } as never }],
    });
    expect(workflowDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown permission key", () => {
    const bad = def({
      transitions: [
        { id: "t", name: "T", from: "*", to: "done", restrict: { kind: "actorHasPermission", permission: "NOT_A_BIT" as never } },
      ],
    });
    expect(workflowDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects extra properties, so a typo is not silently dropped", () => {
    const bad = { ...def(), transitons: [] };
    expect(workflowDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it("refuses a role that doesn't exist, and caps how big a restriction can be", () => {
    const withRestrict = (restrict: unknown) => def({ transitions: [{ id: "t", name: "T", from: "*", to: "done", restrict: restrict as never }] });
    expect(workflowDefinitionSchema.safeParse(withRestrict({ kind: "actorOrgRole", in: ["ADMIN"] })).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(withRestrict({ kind: "actorOrgRole", in: ["ADMN"] })).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse(withRestrict({ kind: "actorProjectRole", in: ["OWNER"] })).success).toBe(false);
    const leaf = { kind: "actorIsAssignee" };
    expect(workflowDefinitionSchema.safeParse(withRestrict({ any: Array(50).fill(leaf) })).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(withRestrict({ any: Array(51).fill(leaf) })).success).toBe(false);
    // Within each group's cap, but 1 + 5 × (1 + 40) = 206 parts in all.
    const wide = { all: Array(5).fill({ any: Array(40).fill(leaf) }) };
    expect(workflowDefinitionSchema.safeParse(withRestrict(wide)).success).toBe(false);
  });

  it("caps condition nesting on every parse, not only at publish", () => {
    const nested = (depth: number) => {
      let node: object = { kind: "actorIsAssignee" };
      for (let i = 1; i < depth; i++) node = { not: node };
      return def({ transitions: [{ id: "t", name: "T", from: "*", to: "done", restrict: node as never }] });
    };
    expect(workflowDefinitionSchema.safeParse(nested(8)).success).toBe(true);
    const deep = workflowDefinitionSchema.safeParse(nested(9));
    expect(deep.success).toBe(false);
    expect(deep.error?.issues[0].path).toEqual(["transitions", 0, "restrict"]);
  });
});

describe("validateDefinition", () => {
  it("passes a sound workflow with no issues", () => {
    expect(codes(def())).toEqual([]);
  });

  it("requires exactly one initial status", () => {
    expect(codes(def({ statuses: [{ key: "todo" }, { key: "done" }] }))).toContain("error:INITIAL_STATUS");
    expect(
      codes(def({ statuses: [{ key: "todo", isInitial: true }, { key: "done", isInitial: true }] })),
    ).toContain("error:INITIAL_STATUS");
  });

  it("requires a To Do and a Done status", () => {
    const noDone = def({
      statuses: [{ key: "todo", isInitial: true }, { key: "doing" }],
      transitions: [{ id: "s", name: "S", from: "*", to: "doing" }],
    });
    expect(codes(noDone)).toContain("error:NO_DONE");
  });

  it("rejects statuses and transitions that point outside the project or workflow", () => {
    const d = def({
      statuses: [{ key: "todo", isInitial: true }, { key: "done" }, { key: "ghost" }],
      transitions: [{ id: "x", name: "X", from: ["todo"], to: "review" }],
    });
    expect(codes(d)).toEqual(expect.arrayContaining(["error:UNKNOWN_STATUS", "error:UNKNOWN_TARGET"]));
  });

  it("rejects a duplicated transition id (automations reference it)", () => {
    const d = def();
    d.transitions.push({ ...d.transitions[0] });
    expect(codes(d)).toContain("error:DUPLICATE_TRANSITION");
  });

  it("warns about an unreachable status and a dead end", () => {
    const d = def({
      transitions: [
        { id: "start", name: "Start", from: ["todo"], to: "doing" },
        { id: "resolve", name: "Resolve", from: ["review"], to: "done" },
      ],
    });
    expect(codes(d)).toEqual(expect.arrayContaining(["warning:UNREACHABLE", "warning:NO_EXIT"]));
  });

  it("allows a dead end in Done", () => {
    expect(codes(def()).filter((c) => c.includes("NO_EXIT"))).toEqual([]);
  });

  it("insists a cancel-reason validator leads into a Cancelled status", () => {
    const d = def({
      transitions: [...def().transitions, { id: "c", name: "Cancel", from: "*", to: "done", validate: [{ kind: "cancelReason" }] }],
    });
    expect(codes(d)).toContain("error:CANCEL_REASON_TARGET");
  });

  it("refuses a restriction on a status or transition the workflow doesn't have", () => {
    const d = def({
      transitions: [
        ...def().transitions,
        { id: "x", name: "X", from: "*", to: "done", restrict: { all: [{ kind: "previousStatus", in: ["reveiw"] }, { kind: "actorIsNot", ref: "lastTransitionActor", transitionId: "aprove" }] } },
      ],
    });
    expect(codes(d)).toEqual(expect.arrayContaining(["error:UNKNOWN_STATUS", "error:UNKNOWN_TRANSITION"]));
  });

  it("caps condition nesting", () => {
    let node: object = { kind: "actorIsAssignee" };
    for (let i = 0; i < 9; i++) node = { not: node };
    const d = def({
      transitions: [...def().transitions, { id: "deep", name: "Deep", from: "*", to: "done", restrict: node as never }],
    });
    expect(codes(d)).toContain("error:CONDITION_TOO_DEEP");
  });
});
