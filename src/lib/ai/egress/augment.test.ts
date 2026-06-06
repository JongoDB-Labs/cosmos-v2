// @vitest-environment node
//
// augmentWithHandles (the MINT side of the opaque-handle resolver) unit tests.
// Locks: default-deny minting (only HANDLEABLE_FIELDS string fields present on the
// SOURCE entity), correct projected↔source index matching across the same
// unwrapping projectResult does, structural fields preserved, and no-op for
// unknown entity / non-entity / flag-handled-elsewhere cases.
//
// mintHandle is mocked to a deterministic token so we assert the mapping logic in
// isolation (the real seal/scope behavior is covered by handles.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mintHandle } = vi.hoisted(() => ({
  mintHandle: vi.fn(),
}));
vi.mock("./handles", () => ({ mintHandle }));

import { augmentWithHandles, projectResult, HANDLEABLE_FIELDS } from "./projection";

const CONV = "conv-x";

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  // Deterministic fake token per mint; record the (value, meta) it was called with.
  mintHandle.mockImplementation(async () => `h:TOKEN${n++}`.padEnd(26, "0"));
});

describe("augmentWithHandles — wrapper (list/query) results", () => {
  it("mints handles for HANDLEABLE work_item.title in a {count, items:[...]} wrapper, matched by index", async () => {
    const source = {
      count: 2,
      items: [
        { id: "w1", title: "CUI//SP kill chain", status: "DOING", description: "ignored (not in returns)" },
        { id: "w2", title: "CUI//SP exfil", status: "DONE" },
      ],
    };
    // The structural model view as the loop computes it.
    const modelView = projectResult(source, "work_item");
    const { modelView: out, minted } = await augmentWithHandles(modelView, source, "work_item", CONV);

    expect(minted).toBe(2);
    const o = out as { count: number; items: Array<Record<string, unknown>> };
    // structural fields preserved...
    expect(o.count).toBe(2);
    expect(o.items[0].id).toBe("w1");
    expect(o.items[0].status).toBe("DOING");
    expect(o.items[1].id).toBe("w2");
    // ...PLUS a handle token added for `title` (NOT the CUI value).
    expect(typeof o.items[0].title).toBe("string");
    expect(o.items[0].title).toMatch(/^h:TOKEN/);
    expect(o.items[1].title).toMatch(/^h:TOKEN/);
    // never the actual CUI:
    expect(JSON.stringify(out)).not.toContain("CUI");
    expect(JSON.stringify(out)).not.toContain("kill chain");
    // mintHandle was called with the REAL value + correct meta.
    expect(mintHandle).toHaveBeenCalledWith(CONV, "CUI//SP kill chain", { entityType: "work_item", fieldName: "title" });
    expect(mintHandle).toHaveBeenCalledWith(CONV, "CUI//SP exfil", { entityType: "work_item", fieldName: "title" });
  });

  it("mints crm_contact name + notes from a {count, contacts:[...]} wrapper", async () => {
    const source = {
      count: 1,
      contacts: [{ id: "c1", name: "Jane Doe", notes: "CUI//SP relationship notes", stage: "LEAD", value: null }],
    };
    const modelView = projectResult(source, "crm_contact");
    const { modelView: out, minted } = await augmentWithHandles(modelView, source, "crm_contact", CONV);
    expect(minted).toBe(2);
    const c = (out as { contacts: Array<Record<string, unknown>> }).contacts[0];
    expect(c.id).toBe("c1");
    expect(c.stage).toBe("LEAD");
    expect(c.name).toMatch(/^h:TOKEN/);
    expect(c.notes).toMatch(/^h:TOKEN/);
    expect(JSON.stringify(out)).not.toContain("Jane Doe");
    expect(JSON.stringify(out)).not.toContain("relationship notes");
  });

  it("mints search_result title + snippet from a {query, count, results:[...]} wrapper", async () => {
    const source = {
      query: "secret",
      count: 1,
      results: [{ id: "n1", type: "note", title: "CUI title", snippet: "CUI body", similarity: 0.8 }],
    };
    const modelView = projectResult(source, "search_result");
    const { modelView: out, minted } = await augmentWithHandles(modelView, source, "search_result", CONV);
    expect(minted).toBe(2);
    const hit = (out as { results: Array<Record<string, unknown>> }).results[0];
    expect(hit.id).toBe("n1");
    expect(hit.type).toBe("note");
    expect(hit.similarity).toBe(0.8);
    expect(hit.title).toMatch(/^h:TOKEN/);
    expect(hit.snippet).toMatch(/^h:TOKEN/);
    expect(JSON.stringify(out)).not.toContain("CUI");
  });
});

describe("augmentWithHandles — default-deny", () => {
  it("does NOT mint a HANDLEABLE field that is absent / empty / non-string on the source", async () => {
    const source = {
      count: 3,
      items: [
        { id: "w1", status: "DONE" },           // title absent → no mint
        { id: "w2", title: "", status: "DONE" }, // title empty → no mint
        { id: "w3", title: 12345, status: "DONE" }, // title non-string → no mint
      ],
    };
    const modelView = projectResult(source, "work_item");
    const { modelView: out, minted } = await augmentWithHandles(modelView, source, "work_item", CONV);
    expect(minted).toBe(0);
    expect(mintHandle).not.toHaveBeenCalled();
    const items = (out as { items: Array<Record<string, unknown>> }).items;
    expect("title" in items[0]).toBe(false);
    expect("title" in items[1]).toBe(false);
  });

  it("unknown entityType ⇒ no-op (no handles)", async () => {
    const r = await augmentWithHandles({ withheld: true }, { foo: "CUI" }, "mystery", CONV);
    expect(r.minted).toBe(0);
    expect(mintHandle).not.toHaveBeenCalled();
  });

  it("an entity type with NO HANDLEABLE_FIELDS (e.g. project) ⇒ no-op", async () => {
    expect(HANDLEABLE_FIELDS["project"]).toBeUndefined();
    const source = { count: 1, projects: [{ id: "p1", name: "CUI Project", archived: false }] };
    const modelView = projectResult(source, "project");
    const r = await augmentWithHandles(modelView, source, "project", CONV);
    expect(r.minted).toBe(0);
    expect(mintHandle).not.toHaveBeenCalled();
  });

  it("a fully-withheld (non-entity) view ⇒ no-op", async () => {
    const r = await augmentWithHandles({ withheld: true, ref: "withheld:structural" }, "CUI bare string", "work_item", CONV);
    expect(r.minted).toBe(0);
    expect(mintHandle).not.toHaveBeenCalled();
  });

  it("a bare entity[] view is matched element-wise to the source array", async () => {
    const source = [{ id: "w1", title: "CUI a" }, { id: "w2", title: "CUI b" }];
    const modelView = projectResult(source, "work_item");
    const { modelView: out, minted } = await augmentWithHandles(modelView, source, "work_item", CONV);
    expect(minted).toBe(2);
    const arr = out as Array<Record<string, unknown>>;
    expect(arr[0].id).toBe("w1");
    expect(arr[0].title).toMatch(/^h:TOKEN/);
    expect(arr[1].title).toMatch(/^h:TOKEN/);
  });
});
