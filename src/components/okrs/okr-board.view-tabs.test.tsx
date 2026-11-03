// @vitest-environment jsdom
// The OKR board's view switcher was three plain <button>s: no role="tab", no
// role="tablist", no aria-selected, and labels that were lowercase string
// literals ("objectives") capitalised by CSS.
//
// Its two siblings got this right -- the sprint-health dashboard renders
// role="tablist" aria-label="Sprint health view" and the ceremony board
// role="tablist" aria-label="Ceremony section" -- so a screen reader announced
// two of the three board view switchers as tabs and this one as three
// unrelated buttons, with no indication of which view was showing.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// Spread the real module rather than replacing it: `FetchError` is also
// exported from here and is reached at runtime by the mutation paths this board
// sets up, so a bare `{ jsonFetch }` mock made vitest raise an unhandled
// rejection -- "No FetchError export is defined on the mock" -- which it warns
// "might cause false positive tests".
vi.mock("@/lib/query/json-fetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn(async () => []) };
});

import { OkrBoard } from "./okr-board";

function renderOkr() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OkrBoard orgId="o1" projectId="p1" />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("OKR view switcher", () => {
  it("is a tablist", async () => {
    renderOkr();
    expect(await screen.findByRole("tablist", { name: /okr view/i })).toBeTruthy();
  });

  it("offers all three views as tabs", async () => {
    renderOkr();
    await screen.findByRole("tablist", { name: /okr view/i });
    const names = screen.getAllByRole("tab").map((t) => t.textContent?.trim());
    expect(names).toEqual(["Objectives", "Health", "Alignment"]);
  });

  it("says which view is showing", async () => {
    renderOkr();
    await screen.findByRole("tablist", { name: /okr view/i });
    const selected = screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent?.trim()).toBe("Objectives");
  });

  it("moves the selection when another view is chosen", async () => {
    renderOkr();
    await screen.findByRole("tablist", { name: /okr view/i });
    // fireEvent wraps the dispatch in act(), so the state update flushes
    // before the assertions; a raw .click() leaves the re-render pending.
    fireEvent.click(screen.getByRole("tab", { name: "Health" }));
    expect(screen.getByRole("tab", { name: "Health" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Objectives" }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("labels the tabs in the case they are displayed in", async () => {
    // They used to be lowercase literals with `capitalize` applied, so the
    // accessible name ("objectives") and the visible text ("Objectives")
    // disagreed -- and the CSS, not the label, carried the real wording.
    renderOkr();
    await screen.findByRole("tablist", { name: /okr view/i });
    for (const t of screen.getAllByRole("tab")) {
      const text = t.textContent!.trim();
      expect(text[0]).toBe(text[0].toUpperCase());
      expect(t.className).not.toContain("capitalize");
    }
  });
});
