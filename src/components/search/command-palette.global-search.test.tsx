// @vitest-environment jsdom
// COSMOS-33 — ⌘K is now a GLOBAL search. It must surface EVERY entity class the
// shared registry indexes (docs, OKRs, boards, people, PM registers, …), not
// just the original four (projects, work items, contacts, notes). Before this
// change the palette only knew how to group/label those four legacy types, so a
// `document` / `objective` / `board` / `user` hit rendered as nothing. This test
// locks the expanded coverage: new-type results appear under their headings and
// selecting one executes the navigation.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- base-ui / cmdk need these in jsdom (see memory: testing-base-ui-in-jsdom) ---
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/acme",
}));

import { CommandPalette } from "./command-palette";
import { DrawerProvider } from "@/components/drawers/drawer-provider";

// A cross-section of entity classes the OLD palette could not render — one org
// level (people, meetings), one project-scoped doc, one OKR, one board.
const GLOBAL_HITS = [
  { id: "u1", type: "user", name: "Ada Lovelace", url: "/acme/team" },
  { id: "d1", type: "document", name: "System Design Doc", url: "/acme/projects/FSC/files/d1" },
  { id: "o1", type: "objective", name: "Grow ARR 30%", url: "/acme/projects/FSC/okrs" },
  { id: "b1", type: "board", name: "Sprint Board", url: "/acme/projects/FSC/boards/b1" },
];

function mockSearchFetch(hits: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search?q=")) {
        return { ok: true, json: async () => hits } as unknown as Response;
      }
      return { ok: true, json: async () => [] } as unknown as Response;
    }),
  );
}

function renderPalette() {
  return render(
    <DrawerProvider>
      <CommandPalette orgs={[{ id: "org-1", slug: "acme" }]} />
    </DrawerProvider>,
  );
}

afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});

describe("CommandPalette — global search across all entity classes (COSMOS-33)", () => {
  it("renders results for entity types beyond the legacy four, grouped by class", async () => {
    mockSearchFetch(GLOBAL_HITS);
    const user = userEvent.setup();
    renderPalette();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search everything/i);
    await user.type(input, "a");

    // Group headings for classes the old palette had no mapping for.
    await waitFor(() => expect(screen.getByText("People")).toBeInTheDocument());
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Objectives")).toBeInTheDocument();
    expect(screen.getByText("Boards")).toBeInTheDocument();

    // And the actual entities are listed.
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("System Design Doc")).toBeInTheDocument();
    expect(screen.getByText("Grow ARR 30%")).toBeInTheDocument();
  });

  it("executes the selected result's navigation (keyboard-navigable → action)", async () => {
    mockSearchFetch(GLOBAL_HITS);
    const user = userEvent.setup();
    renderPalette();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search everything/i);
    await user.type(input, "design");

    const doc = await screen.findByText("System Design Doc");
    await user.click(doc);

    expect(push).toHaveBeenCalledWith("/acme/projects/FSC/files/d1");
  });
});
