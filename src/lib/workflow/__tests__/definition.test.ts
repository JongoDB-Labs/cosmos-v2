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

  it("caps condition nesting", () => {
    let node: object = { kind: "actorIsAssignee" };
    for (let i = 0; i < 9; i++) node = { not: node };
    const d = def({
      transitions: [...def().transitions, { id: "deep", name: "Deep", from: "*", to: "done", restrict: node as never }],
    });
    expect(codes(d)).toContain("error:CONDITION_TOO_DEEP");
  });
});
