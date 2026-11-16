import { describe, it, expect } from "vitest";
import {
  isToolCallRunning,
  finalizeToolCalls,
  hasRunningToolCall,
  toolCallOutcome,
} from "./tool-status";

describe("isToolCallRunning — default-closed status machine", () => {
  it("is running ONLY when explicitly marked running", () => {
    expect(isToolCallRunning({ status: "running" })).toBe(true);
  });

  it("is done when explicitly marked done", () => {
    expect(isToolCallRunning({ status: "done" })).toBe(false);
  });

  it("is done when NO status is present (the `done` event shape)", () => {
    // AgentToolCall = {id, name, arguments, result} — no status field.
    expect(
      isToolCallRunning({ id: "t1", name: "list_projects", result: { count: 0 } }),
    ).toBe(false);
  });

  it("is done for a persisted history entry (status-less, has a result)", () => {
    expect(
      isToolCallRunning({ id: "t1", name: "create_work_item", result: { id: "x" } }),
    ).toBe(false);
  });

  it("does not treat an unknown status string as running", () => {
    expect(isToolCallRunning({ status: "queued" })).toBe(false);
  });
});

describe("finalizeToolCalls — nothing left spinning", () => {
  it("flips a still-running call to done", () => {
    const out = finalizeToolCalls([
      { id: "a", name: "create_project", status: "running", result: null },
    ]);
    expect(out[0].status).toBe("done");
  });

  it("preserves id / name / arguments / result", () => {
    const out = finalizeToolCalls([
      {
        id: "a",
        name: "update_work_item",
        arguments: { id: "wi1", status: "DONE" },
        result: { updated: true, id: "wi1" },
        status: "running",
      },
    ]);
    expect(out[0]).toMatchObject({
      id: "a",
      name: "update_work_item",
      arguments: { id: "wi1", status: "DONE" },
      result: { updated: true, id: "wi1" },
      status: "done",
    });
  });

  it("leaves already-done calls done and stamps status-less calls", () => {
    const out = finalizeToolCalls([
      { id: "a", status: "done" },
      { id: "b" },
    ]);
    expect(out.map((t) => t.status)).toEqual(["done", "done"]);
  });

  it("returns a new array (no mutation of inputs)", () => {
    const input = [{ id: "a", status: "running" as const }];
    const out = finalizeToolCalls(input);
    expect(input[0].status).toBe("running");
    expect(out[0].status).toBe("done");
  });
});

describe("hasRunningToolCall", () => {
  it("detects a still-running call in a mixed list", () => {
    expect(
      hasRunningToolCall([{ status: "done" }, { status: "running" }]),
    ).toBe(true);
  });

  it("is false when all calls are finished / status-less", () => {
    expect(hasRunningToolCall([{ status: "done" }, { id: "x" }])).toBe(false);
  });
});

describe("toolCallOutcome — what the chip says happened", () => {
  it("a preview is a proposal, not a run", () => {
    const preview = { status: "confirmation_required", tool: "delete_work_item", targetCount: 1, targetIds: ["w1"] };
    expect(toolCallOutcome({ id: "a", name: "delete_work_item", result: preview })).toBe("proposed");
    // Live, after the result event, and persisted (no status): the same.
    expect(toolCallOutcome({ id: "a", name: "delete_work_item", result: preview, status: "done" })).toBe("proposed");
  });

  it("a refusal is not done", () => {
    expect(toolCallOutcome({ name: "delete_work_item", result: { error: "Work item not found" } })).toBe("refused");
  });

  it("a finished change is done, and a running one is running", () => {
    expect(toolCallOutcome({ name: "delete_work_item", result: { deleted: true, id: "w1" } })).toBe("done");
    expect(toolCallOutcome({ name: "list_projects", result: [{ id: "p" }] })).toBe("done");
    expect(toolCallOutcome({ name: "delete_work_item", status: "running", result: null })).toBe("running");
  });
});
