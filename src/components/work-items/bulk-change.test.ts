import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { announceBulkChange, combineBulkChanges, sendBulkChange } from "./bulk-change";
import type { BulkDenial } from "@/lib/workflow/contract";

const resolve = { id: "resolve", name: "Resolve", to: "done" };
const needs = (id: string): BulkDenial => ({
  id,
  code: "transition_input_required",
  message: "Resolve needs Resolution.",
  transition: resolve,
  fields: [{ field: { system: "resolution" }, required: true }],
});

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());
const sent = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

describe("sendBulkChange", () => {
  it("asks once for every item a transition wants details for, and sends just those again", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ updated: 1, denied: [needs("a"), needs("b"), { id: "c", code: "transition_not_allowed", message: "No way there." }] }))
      .mockResolvedValueOnce(json({ updated: 2, denied: [] }));
    const ask = vi.fn(async (_refusal: unknown) => ({ "system:resolution": "Fixed" }));

    const result = await sendBulkChange({ basePath: "/p", ids: ["a", "b", "c", "d"], update: { columnKey: "done" }, ask });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ code: "transition_input_required", transition: { id: "resolve", name: "Resolve, 2 items" } });
    expect(sent()).toEqual([
      { ids: ["a", "b", "c", "d"], update: { columnKey: "done" } },
      { ids: ["a", "b"], update: { columnKey: "done" }, transition: { id: "resolve", input: { "system:resolution": "Fixed" } } },
    ]);
    expect(result).toEqual({ updated: 3, denied: [{ id: "c", code: "transition_not_allowed", message: "No way there." }] });
  });

  it("counts the items as left alone when the person backs out", async () => {
    fetchMock.mockResolvedValueOnce(json({ updated: 0, denied: [needs("a")] }));
    const result = await sendBulkChange({ basePath: "/p", ids: ["a"], update: { columnKey: "done" }, ask: async () => null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.denied.map((d) => d.id)).toEqual(["a"]);
  });
});

describe("announceBulkChange", () => {
  it("says what moved and what stayed put", () => {
    announceBulkChange({ updated: 3, denied: [{ id: "c", code: "transition_invalid", message: "Finish its sub-items first." }] }, "Done");
    expect(toast.warning).toHaveBeenCalledWith("Updated 3 items — Done. 1 item stayed put: Finish its sub-items first.");
  });

  it("is an error when nothing moved, and quiet on a full success without a label", () => {
    announceBulkChange({ updated: 0, denied: [{ id: "c", code: "transition_not_allowed", message: "No way there." }] });
    expect(toast.error).toHaveBeenCalledWith("No items changed. No way there.");
    announceBulkChange({ updated: 2, denied: [] });
    expect(toast.success).not.toHaveBeenCalled();
    announceBulkChange({ updated: 2, denied: [] }, "Done");
    expect(toast.success).toHaveBeenCalledWith("Updated 2 items — Done");
  });

  it("adds up several projects' results", () => {
    expect(combineBulkChanges([{ updated: 1, denied: [] }, { updated: 2, denied: [needs("x")] }])).toEqual({ updated: 3, denied: [needs("x")] });
  });
});
