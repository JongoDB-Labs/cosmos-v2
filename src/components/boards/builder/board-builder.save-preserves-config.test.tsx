// @vitest-environment jsdom
// The board builder's Save replaced the whole `Board.config` blob.
//
// It sent `config: { widgets }` (board-builder.tsx:108) and the route writes
// `config` wholesale (boards/[boardId]/route.ts:100), so every other key in
// that JSON was erased by any Save. All four of them have real readers:
//
//   config.query / config.savedFilter -> boardBaseline() in use-board-query,
//       read by EVERY board type. A board saved from Issues loses its baseline
//       and silently shows the whole project.
//   config.mode  -> boards/[boardId]/page.tsx:62-65. A Release Timeline board
//       becomes an interactive Gantt.
//   config.typeKeys -> table-view.tsx:185. A Table loses its type columns.
//
// Found while investigating why nothing links to this page. The builder has no
// entry point anywhere in the app, so the only way to reach it is to type the
// URL -- which is the one thing that makes this latent rather than daily. It is
// still a data-loss bug on a page that ships, so it is fixed here regardless of
// what we decide about the builder's future.
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
  usePathname: () => "/acme/projects/FSC/boards/b1/builder",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { BoardBuilder } from "./board-builder";

/** Every other key a real board carries in `config`, each with a live reader. */
const EXISTING_CONFIG = {
  query: 'status = "open"',
  mode: "release-timeline",
  typeKeys: ["task", "bug"],
  savedFilter: { priorities: ["CRITICAL"] },
};

function renderBuilder() {
  return render(
    // The builder invalidates the board's cached copy after a Save, so it
    // lives under a query client, as it always does in the app.
    <QueryClientProvider client={new QueryClient()}>
    <BoardBuilder
      orgId="o1"
      projectId="p1"
      boardId="b1"
      initialBoard={{
        id: "b1",
        name: "A board",
        type: "DASHBOARD",
        config: { ...EXISTING_CONFIG, widgets: [] },
        columns: [],
      } as never}
      sector={undefined}
    />
    </QueryClientProvider>,
  );
}

/**
 * Save is `disabled={!isDirty || saving}`, so a freshly loaded builder cannot
 * save at all. Renaming the board is the smallest real edit that dirties it.
 */
function dirtyThenSave() {
  fireEvent.change(screen.getByPlaceholderText(/board name/i), {
    target: { value: "A renamed board" },
  });
  const save = screen.getByRole("button", { name: /^save$/i });
  expect(save).not.toBeDisabled();
  save.click();
}

/** The body of the PUT the Save button sent. */
async function savedBody(): Promise<Record<string, unknown>> {
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
  expect(call, "no PUT was sent").toBeTruthy();
  return JSON.parse(String((call![1] as RequestInit).body));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the builder's Save", () => {
  it("sends a PUT at all", async () => {
    // Positive control: every assertion below reads that request, so if Save
    // silently did nothing they would all pass over an absent call.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    renderBuilder();
    dirtyThenSave();
    await waitFor(async () => expect(await savedBody()).toBeTruthy());
  });

  it("keeps the keys it does not own", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    renderBuilder();
    dirtyThenSave();
    await waitFor(async () => {
      const config = (await savedBody()).config as Record<string, unknown>;
      expect(config.query).toBe(EXISTING_CONFIG.query);
      expect(config.mode).toBe(EXISTING_CONFIG.mode);
      expect(config.typeKeys).toEqual(EXISTING_CONFIG.typeKeys);
      expect(config.savedFilter).toEqual(EXISTING_CONFIG.savedFilter);
    });
  });

  it("still writes the widgets it does own", async () => {
    // The control against over-correcting: preserving the blob must not stop
    // the builder saving the one key it is for.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    renderBuilder();
    dirtyThenSave();
    await waitFor(async () => {
      const config = (await savedBody()).config as Record<string, unknown>;
      expect(config).toHaveProperty("widgets");
    });
  });
});
