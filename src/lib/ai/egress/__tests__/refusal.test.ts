// src/lib/ai/egress/__tests__/refusal.test.ts
//
// A tool's refusal on a WITHHELD result. The structural projection drops every
// top-level string, so `{ error: "Project not found" }` reached the model as
// `{}` and the model made up a reason. A refusal now reaches it, but only as
// text written in server code: never a string built from a row or a request.
import { describe, it, expect } from "vitest";
import { ConflictError, NotFoundError } from "@/lib/rbac/check";
import { serviceRefusal } from "@/lib/ai/executors/_ctx";
import { projectResult } from "../projection";
import {
  INVALID_INPUT_REFUSAL,
  REASON_WITHHELD_REFUSAL,
  VERBATIM_REFUSALS,
  badIdRefusal,
  internalFailureRefusal,
} from "../refusal";

const SECRET = "Sentinel kill chain";

describe("a refusal on a withheld result", () => {
  it("a constant refusal reaches the model word for word, for a mapped tool", () => {
    expect(projectResult({ error: "Project not found" }, "work_item", "list_work_items")).toEqual({ error: "Project not found" });
    expect(projectResult({ error: "Insufficient permissions" }, "saved_view", "list_saved_views")).toEqual({ error: "Insufficient permissions" });
  });

  it("and for a tool with no entity mapping, whose results are otherwise withheld whole", () => {
    expect(projectResult({ error: "Insufficient permissions" }, undefined, "get_finance_summary")).toEqual({ error: "Insufficient permissions" });
  });

  it("this tool's internal-failure answer reaches the model as it is", () => {
    const text = internalFailureRefusal("create_whiteboard");
    expect(projectResult({ error: text }, "whiteboard", "create_whiteboard")).toEqual({ error: text });
    const bad = badIdRefusal("get_work_item");
    expect(projectResult({ error: bad }, "work_item", "get_work_item")).toEqual({ error: bad });
  });

  it("but only for the call's own tool: the same sentence naming another tool is not let through", () => {
    // The tool name is the one value interpolated into a passed text, so it must
    // be the call's own and nothing the result supplies.
    const forged = internalFailureRefusal(SECRET);
    expect(projectResult({ error: forged }, "work_item", "get_work_item")).toEqual({ error: REASON_WITHHELD_REFUSAL });
  });

  it("a refusal that quotes a value from a row is NOT passed through", () => {
    // The shape a shared service really throws: board-service quotes a column key.
    const conflict = serviceRefusal(new ConflictError(`A column's category is its status's: change "${SECRET}" in Settings → Workflows.`));
    const notFound = serviceRefusal(new NotFoundError(`Work item "${SECRET}" not found`));
    for (const r of [conflict, notFound, { error: `Work item "${SECRET}" is archived` }]) {
      const view = projectResult(r, "board", "update_board");
      expect(view).toEqual({ error: REASON_WITHHELD_REFUSAL });
      expect(JSON.stringify(view)).not.toContain(SECRET);
    }
  });

  it("a text that only STARTS with a constant refusal is not one", () => {
    const view = projectResult({ error: `Project not found: ${SECRET}` }, "project", "get_project");
    expect(view).toEqual({ error: REASON_WITHHELD_REFUSAL });
  });

  it("a schema rejection is named as one, without its detail", () => {
    // zod's detail can quote an argument, and an argument can be a resolved handle.
    const view = projectResult({ error: `Invalid input: expected one of "${SECRET}"` }, "work_item", "update_work_item");
    expect(view).toEqual({ error: INVALID_INPUT_REFUSAL });
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it("a rejected query keeps its refusal and loses its diagnostics", () => {
    const view = projectResult(
      { error: `Unknown value "${SECRET}" for status. Fix the query and try again.`, diagnostics: [{ line: 1, message: SECRET }] },
      "saved_view",
      "create_saved_view",
    );
    expect(view).toEqual({ error: REASON_WITHHELD_REFUSAL });
  });

  it("a record that merely HAS an error field is projected like any other, and its error dropped", () => {
    const row = { id: "w1", status: "DONE", title: SECRET, error: "Project not found" };
    const view = projectResult(row, "work_item", "get_work_item") as Record<string, unknown>;
    expect(view).toEqual({ id: "w1", status: "DONE" });
  });

  it("control: an ordinary result still projects structurally", () => {
    expect(projectResult({ count: 1, items: [{ id: "w1", title: SECRET }] }, "work_item", "list_work_items")).toEqual({
      count: 1,
      items: [{ id: "w1" }],
    });
  });

  it("every text the model can be handed is a constant with nothing quoted into it", () => {
    for (const t of [...VERBATIM_REFUSALS, INVALID_INPUT_REFUSAL, REASON_WITHHELD_REFUSAL]) {
      expect(t, t).not.toMatch(/\$\{|CUI|FOUO/);
      expect(t.length, t).toBeGreaterThan(0);
    }
  });
});
