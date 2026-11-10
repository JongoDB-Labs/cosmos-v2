// @vitest-environment jsdom
//
// The board's chrome is ONE band, not two stacked identical ones.
//
// ffe324aa: "very cluttered and stacked on top of each other, which just pushes
// the kanban board itself down way too much to where you have no visibility."
//
// The cause was structural. `FilterBar`'s root and `BOARD_TOOLBAR_BAND` carry
// character-for-character the same classes
// (`flex flex-wrap items-center gap-3 px-4 py-2 border-b bg-background/50`), so
// a board rendering both drew the SAME band twice -- and in normal mode the
// second one held exactly two controls, "Select" against the left edge and
// "New work item" at the right, with nothing between. `BoardScopeNotice` owned a
// third. On a sprint board, whose wrapper adds its own, that was four
// horizontal bands before the first card.
//
// 2.511.0 made the eleven toolbars CONSISTENT, which is a different property
// and is why the complaint survived it: nothing then reduced the band COUNT.
// `sprint-board.compact-chrome.test.tsx` asserts the same property one level
// up, for the sprint context; this is the board's own half.
//
// jsdom computes no layout, so this cannot assert pixels. It asserts the cause:
// that the filter control and the create control share ONE bordered ancestor.
// Counting bands alone would pass if the chrome failed to render at all, so the
// shared-ancestor assertion is the one that carries the meaning, and the
// positive controls below prove the chrome is really there.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!("EventSource" in globalThis)) {
  globalThis.EventSource = class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  } as unknown as typeof EventSource;
}

vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermissions: () => ({
    orgId: "o1",
    orgSlug: "acme",
    role: "ADMIN",
    permissions: 0n,
    can: () => true,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { KanbanBoard } from "./kanban-board";

const item = (id: string, title: string, priority: string) => ({
  id,
  orgId: "o1",
  projectId: "p1",
  workItemTypeId: "t1",
  title,
  description: "",
  columnKey: "todo",
  priority,
  assigneeId: null,
  assignees: [],
  parentId: null,
  intervalId: null,
  ticketNumber: 1,
  tags: [],
  customFields: {},
  archivedAt: null,
  startDate: null,
  dueDate: null,
  completedAt: null,
  storyPoints: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  workItemType: { id: "t1", key: "task", name: "Task", icon: null, color: null },
});

const ITEMS = [item("i1", "Critical outage", "CRITICAL"), item("i2", "Polish copy", "LOW")];

function installFetch(config: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/boards/b1")
        ? {
            id: "b1",
            name: "Board",
            type: "KANBAN",
            config,
            columns: [
              { id: "c1", key: "todo", name: "To do", sortOrder: 0, category: "TODO" },
            ],
          }
        : url.endsWith("/work-items")
          ? ITEMS
          : [];
      return new Response(JSON.stringify({ data: body }), { status: 200 });
    }),
  );
}

function renderKanban() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KanbanBoard orgId="o1" projectId="p1" projectKey="P1" boardId="b1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// `~=` matches a whole class TOKEN, not a substring. `*=` looks right and is
// wrong: "border-b" is a substring of "border-border", so a `*=` selector
// matches any element carrying that utility -- including the New work item button
// itself, which made an earlier draft of this file report two bands and claim
// the two controls were in different ones. The selector was the defect, not the
// chrome.
const BAND = '[class~="border-b"]';

/** The nearest bordered band an element sits in, or null if it is in none. */
const bandOf = (el: HTMLElement) => el.closest(BAND);

/** Every horizontal rule in the board's chrome. Each is vertical space the cards do not get. */
const bands = (container: HTMLElement) => container.querySelectorAll(BAND);

describe("Kanban chrome is one band", () => {
  it("renders the filter control and the create control at all", async () => {
    // Positive control. Every assertion below is about where these two sit, so
    // all of them would pass vacuously on a board that rendered neither.
    installFetch({});
    renderKanban();
    expect(await screen.findByRole("button", { name: "New work item" })).toBeTruthy();
    expect(screen.getByPlaceholderText(/search/i)).toBeTruthy();
  });

  it("puts the search box and New work item in the SAME bordered band", async () => {
    installFetch({});
    renderKanban();
    const newIssue = await screen.findByRole("button", { name: "New work item" });
    const search = screen.getByPlaceholderText(/search/i);

    const band = bandOf(search);
    // Guards against both elements simply having no band at all, which would
    // make the equality below trivially true (null === null).
    expect(band).not.toBeNull();
    expect(bandOf(newIssue)).toBe(band);
  });

  it("draws exactly one band above the cards", async () => {
    installFetch({});
    const { container } = renderKanban();
    await screen.findByRole("button", { name: "New work item" });
    expect(bands(container)).toHaveLength(1);
  });

  it("keeps the scope notice inside that band rather than adding one", async () => {
    // A board saved from Issues is the case that used to stack a THIRD band:
    // BoardScopeNotice carried its own `border-b px-4 py-1`.
    installFetch({ savedFilter: { priorities: ["CRITICAL"] } });
    const { container } = renderKanban();
    const notice = await screen.findByText(/filter this board was saved with/);
    const newIssue = screen.getByRole("button", { name: "New work item" });

    expect(bandOf(notice)).toBe(bandOf(newIssue));
    expect(bands(container)).toHaveLength(1);
  });

  it("still says what it used to say", async () => {
    // The band count must not have been bought by dropping information.
    installFetch({ savedFilter: { priorities: ["CRITICAL"] } });
    renderKanban();
    expect(await screen.findByText(/filter this board was saved with/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "New work item" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^select$/i })).toBeTruthy();
    expect(screen.getByPlaceholderText(/search/i)).toBeTruthy();
  });
});
