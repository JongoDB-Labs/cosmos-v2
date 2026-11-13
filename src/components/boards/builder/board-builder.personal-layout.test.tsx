// @vitest-environment jsdom
//
// The builder in PERSONAL mode edits only the caller's own arrangement of a
// dashboard. Its Save must go to `…/my-layout` and never to the board itself,
// which is the layout everyone else sees.
//
// Each "never" below has its positive control in the same file: the shared
// mode's Save does reach the board, so an absent board PUT in personal mode is
// the mode talking, not a probe that sees nothing.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
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
  usePathname: () => "/acme/projects/ACME/boards/b1/builder",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { BoardBuilder } from "./board-builder";
import { useBuilderStore } from "@/lib/boards/builder-store";

const SHARED = [
  {
    id: "w-shared",
    type: "counter",
    config: { title: "Shared counter" },
    // A layout carrying a key the strict my-layout contract would refuse.
    layout: { x: 0, y: 0, w: 3, h: 2, minW: 2 },
  },
];

function renderBuilder(props: Partial<React.ComponentProps<typeof BoardBuilder>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BoardBuilder
        orgId="o1"
        projectId="p1"
        boardId="b1"
        initialBoard={{
          id: "b1",
          name: "Team health",
          type: "DASHBOARD",
          config: { widgets: SHARED, query: "priority = HIGH" },
        } as never}
        boardHref="/acme/projects/ACME/boards/b1"
        {...props}
      />
    </QueryClientProvider>,
  );
}

function puts(): Array<{ url: string; body: Record<string, unknown> }> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => (init as RequestInit)?.method === "PUT")
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The builder's store is module state; start each test from nothing.
  useBuilderStore.setState({ widgets: [], undoStack: [], redoStack: [], isDirty: false, selectedWidgetId: null });
});

describe("the builder in personal mode", () => {
  it("starts from the shared layout when the viewer has none of their own", () => {
    renderBuilder({ mode: "personal", personalWidgets: null, canEditShared: false });
    expect(screen.getAllByText("Shared counter").length).toBeGreaterThan(0);
    expect(screen.getByTestId("builder-mode")).toHaveTextContent(/only you see these changes/i);
  });

  it("starts from the viewer's own layout when they have one", () => {
    renderBuilder({
      mode: "personal",
      canEditShared: false,
      personalWidgets: [
        { id: "m1", type: "text-block", config: { title: "My notes" }, layout: { x: 0, y: 0, w: 6, h: 3 } },
      ],
    });
    expect(screen.getAllByText("My notes").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Shared counter")).toHaveLength(0);
  });

  it("saves to my-layout, and never to the board", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ layout: null }), { status: 200 })));
    renderBuilder({ mode: "personal", personalWidgets: null, canEditShared: false });
    // The name is the shared board's: shown, not editable here.
    expect(screen.getByRole("textbox", { name: "Board name" })).toHaveAttribute("readonly");

    fireEvent.click(screen.getByRole("button", { name: /Deadline List/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save my layout" }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    const [put] = puts();
    expect(put.url).toBe("/api/v1/orgs/o1/projects/p1/boards/b1/my-layout");
    expect(Object.keys(put.body)).toEqual(["widgets"]);
    const widgets = put.body.widgets as Array<Record<string, unknown>>;
    expect(widgets.map((w) => w.type)).toEqual(["counter", "deadline-list"]);
    // Exactly the keys the contract accepts — the stray `minW` is dropped.
    expect(widgets[0].layout).toEqual({ x: 0, y: 0, w: 3, h: 2 });
  });

  it("offers no switch to the shared layout to someone who cannot edit it", () => {
    renderBuilder({ mode: "personal", personalWidgets: null, canEditShared: false });
    expect(screen.queryByRole("link", { name: /shared layout/i })).toBeNull();
    // Positive control: the link probe does find the Back link.
    expect(screen.getByRole("link", { name: "Back to board" })).toBeTruthy();
  });
});

describe("the builder in shared mode (positive control)", () => {
  it("saves to the board itself", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    renderBuilder({ mode: "shared", canEditShared: true });
    fireEvent.click(screen.getByRole("button", { name: /Deadline List/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].url).toBe("/api/v1/orgs/o1/projects/p1/boards/b1");
  });

  it("offers an editor their own layout instead", () => {
    renderBuilder({ mode: "shared", canEditShared: true });
    expect(screen.getByRole("link", { name: "Edit only my layout instead" })).toHaveAttribute(
      "href",
      "/acme/projects/ACME/boards/b1/builder?view=mine",
    );
  });
});
