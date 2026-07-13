import { describe, it, expect } from "vitest";
import {
  isToolCallRunning,
  finalizeToolCalls,
  hasRunningToolCall,
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
