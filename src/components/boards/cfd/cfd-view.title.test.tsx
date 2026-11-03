// @vitest-environment jsdom
// The title the a11y e2e scan anchors on.
//
// `e2e/a11y.spec.ts` waits for this board's title before running axe, because
// scanning before the view renders proves nothing. That anchor was
// `getByRole("heading", { name: "Cumulative Flow Diagram" })` and it broke when
// 2.511.0 moved the title into the shared `BoardToolbarTitle`, which renders a
// styled <div> rather than an <h2>. Two changes that were each correct and each
// green on their own branch: the toolbar refactor and the new board scans
// merged back to back, and nothing ever ran the combination.
//
// So this spec asserts exactly what the e2e anchor depends on, in a test that
// runs locally on every change. An e2e-only contract is one vitest and tsc
// cannot see.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// NOTE: this board calls `fetch` + `res.json()` directly rather than going
// through `jsonFetch`, so unlike every other board view its responses are NOT
// wrapped in `{ data }`. Wrapping them here left it stuck on its skeleton.
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    const body = String(url).endsWith("/boards/b1")
      ? {
          id: "b1",
          name: "CFD",
          type: "CFD",
          config: {},
          columns: [
            { id: "c1", key: "todo", name: "To do", sortOrder: 0, category: "TODO" },
            { id: "c2", key: "done", name: "Done", sortOrder: 1, category: "DONE" },
          ],
        }
      : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }),
);

import { CfdView } from "./cfd-view";

afterEach(cleanup);

describe("the CFD board's title", () => {
  it("is on screen, which is what the a11y scan waits for", async () => {
    render(<CfdView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />);
    expect(await screen.findByText("Cumulative Flow Diagram")).toBeTruthy();
  });

  it("is NOT a heading, so the e2e anchor must not ask for one", async () => {
    // The positive control for the fix: if someone restores an <h2> here, this
    // fails and points at the e2e anchor that would then be wrong the other
    // way. Either way the two stay in step.
    render(<CfdView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />);
    await screen.findByText("Cumulative Flow Diagram");
    expect(screen.queryByRole("heading", { name: "Cumulative Flow Diagram" })).toBeNull();
  });
});
