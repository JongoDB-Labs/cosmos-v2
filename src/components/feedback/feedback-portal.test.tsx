// @vitest-environment jsdom
// COSMOS-6 — FR view: after submitting a feature request, clicking it must open
// a modal showing its full details (title, description, type, reporter,
// timestamp, status), and that modal must be closeable (close button / Esc /
// overlay) while returning focus to the list item. The detail modal shipped in
// v2.78.0 but had no regression guard — this locks the click → modal → close
// flow so a future refactor can't silently break it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  within,
  waitFor,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui needs these in jsdom (see memory: testing-base-ui-in-jsdom) ---
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

vi.mock("next/navigation", () => ({ usePathname: () => "/test-org/feedback" }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
// The submit dialog's project picker fetches via jsonFetch; the detail flow
// doesn't need projects, so an empty list keeps that query quiet.
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn(() => Promise.resolve([])),
}));

import { FeedbackPortal } from "./feedback-portal";

const FR = {
  id: "fr-1",
  type: "FEATURE" as const,
  title: "Bulk-archive completed work items",
  description: "As a lead I want to archive many items at once so my board stays clean.",
  status: "OPEN" as const,
  voteCount: 4,
  hasVoted: false,
  isMine: false,
  createdAt: "2026-07-01T12:00:00.000Z",
  attachments: [],
  authorName: "Ada Lovelace",
  authorEmail: "ada@test.local",
};

// The portal loads its list via a raw `fetch(basePath)`; return our single FR.
function stubFetch(items: unknown[] = [FR]) {
  return vi.fn(async () =>
    ({ ok: true, status: 200, json: async () => items }) as Response,
  );
}

const renderPortal = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FeedbackPortal orgId="org-1" />
    </QueryClientProvider>,
  );
};

describe("FeedbackPortal — FR detail modal (COSMOS-6)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", stubFetch());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists a submitted feature request as a clickable item that opens a detail modal with full details", async () => {
    const user = userEvent.setup();
    renderPortal();

    // The FR appears in the list, exposed as a details trigger.
    const trigger = await screen.findByRole("button", {
      name: /view details for "Bulk-archive completed work items"/i,
    });

    await user.click(trigger);

    // Modal opens with the FR's full details.
    const dialog = await screen.findByRole("dialog");
    const inDialog = within(dialog);
    expect(inDialog.getByText("Bulk-archive completed work items")).toBeInTheDocument();
    expect(inDialog.getByText(/archive many items at once/i)).toBeInTheDocument();
    expect(inDialog.getByText("Feature")).toBeInTheDocument(); // type
    expect(inDialog.getByText("Open")).toBeInTheDocument(); // status
    expect(inDialog.getByText(/Reported by Ada Lovelace/i)).toBeInTheDocument(); // reporter
    expect(inDialog.getByText(/Submitted/i)).toBeInTheDocument(); // timestamp
  });

  it("closes the detail modal via its close button and returns focus to the list item", async () => {
    const user = userEvent.setup();
    renderPortal();

    const trigger = await screen.findByRole("button", {
      name: /view details for "Bulk-archive completed work items"/i,
    });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /close/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Focus returns to the list item the modal was opened from.
    expect(trigger).toHaveFocus();
  });

  it("closes the detail modal with the Escape key", async () => {
    const user = userEvent.setup();
    renderPortal();

    const trigger = await screen.findByRole("button", {
      name: /view details for "Bulk-archive completed work items"/i,
    });
    await user.click(trigger);

    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

// COSMOS-31 — organize & filter FRs and BRs by status and type. Filtering by a
// *single* status already worked; the acceptance criteria call for filtering by
// "one or more statuses" (a union), combinable with the type filter, and an
// empty/cleared state that returns the full unfiltered list. These lock that in.
describe("FeedbackPortal — status + type filtering (COSMOS-31)", () => {
  const ITEMS = [
    { ...FR, id: "a", title: "Alpha open feature", type: "FEATURE", status: "OPEN" },
    { ...FR, id: "b", title: "Bravo in-progress bug", type: "BUG", status: "IN_PROGRESS" },
    { ...FR, id: "c", title: "Charlie done feature", type: "FEATURE", status: "DONE" },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", stubFetch(ITEMS));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Titles of the currently-listed items, read from their detail triggers.
  const listedTitles = () =>
    screen
      .queryAllByRole("button", { name: /^view details for /i })
      .map((b) => b.getAttribute("aria-label")?.replace(/^view details for "(.*)"$/i, "$1"));

  it("filters by one or more statuses (a union) and clearing restores the full list", async () => {
    const user = userEvent.setup();
    renderPortal();

    // Full list to start (empty filter = everything).
    await screen.findByRole("button", { name: /view details for "Alpha open feature"/i });
    expect(listedTitles()).toEqual([
      "Alpha open feature",
      "Bravo in-progress bug",
      "Charlie done feature",
    ]);

    // Pick one status → only that status shows.
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(listedTitles()).toEqual(["Alpha open feature"]);

    // Add a second status → the union of both shows.
    await user.click(screen.getByRole("button", { name: "In progress" }));
    expect(listedTitles()).toEqual(["Alpha open feature", "Bravo in-progress bug"]);

    // Toggling a status back off removes it from the union.
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(listedTitles()).toEqual(["Bravo in-progress bug"]);

    // Clearing returns the full, unfiltered list.
    await user.click(screen.getByRole("button", { name: /clear/i }));
    expect(listedTitles()).toEqual([
      "Alpha open feature",
      "Bravo in-progress bug",
      "Charlie done feature",
    ]);
  });

  it("combines a status filter with the type filter (status AND type)", async () => {
    const user = userEvent.setup();
    renderPortal();

    await screen.findByRole("button", { name: /view details for "Alpha open feature"/i });

    // Only Features…
    await user.selectOptions(screen.getByLabelText("Filter by type"), "FEATURE");
    expect(listedTitles()).toEqual(["Alpha open feature", "Charlie done feature"]);

    // …that are also Done → the two filters intersect.
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(listedTitles()).toEqual(["Charlie done feature"]);
  });

  it("filters by requirement type in isolation (Bugs only) and resetting to All restores the full list", async () => {
    const user = userEvent.setup();
    renderPortal();

    await screen.findByRole("button", { name: /view details for "Alpha open feature"/i });

    // Restrict to Bugs → only the single BUG item remains (type filter alone,
    // no status filter set).
    await user.selectOptions(screen.getByLabelText("Filter by type"), "BUG");
    expect(listedTitles()).toEqual(["Bravo in-progress bug"]);

    // Clearing the type back to All returns the full, unfiltered list.
    await user.selectOptions(screen.getByLabelText("Filter by type"), "ALL");
    expect(listedTitles()).toEqual([
      "Alpha open feature",
      "Bravo in-progress bug",
      "Charlie done feature",
    ]);
  });
});

// COSMOS-9 — search the feedback board instead of scrolling and eyeballing it.
// The search box (title + description keyword match) shipped in v2.84.1 but had
// no regression guard; these lock the four acceptance criteria: a search input
// exists, it matches title AND description (case-insensitively), it composes
// with the type filter, and a no-match state clearly names what was searched.
describe("FeedbackPortal — keyword search (COSMOS-9)", () => {
  const ITEMS = [
    {
      ...FR,
      id: "a",
      title: "Dark mode toggle",
      description: "Add a dark theme option to the settings page.",
      type: "FEATURE",
      status: "OPEN",
    },
    {
      ...FR,
      id: "b",
      title: "Export board to CSV",
      description: "Download the whole board as a spreadsheet.",
      type: "FEATURE",
      status: "OPEN",
    },
    {
      ...FR,
      id: "c",
      title: "Login screen crash",
      description: "The app crashes on the dark login screen.",
      type: "BUG",
      status: "OPEN",
    },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", stubFetch(ITEMS));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const listedTitles = () =>
    screen
      .queryAllByRole("button", { name: /^view details for /i })
      .map((b) => b.getAttribute("aria-label")?.replace(/^view details for "(.*)"$/i, "$1"));

  it("exposes a search input and filters the list by a keyword in the title", async () => {
    const user = userEvent.setup();
    renderPortal();
    await screen.findByRole("button", { name: /view details for "Dark mode toggle"/i });

    const box = screen.getByRole("searchbox", { name: /search feedback/i });
    await user.type(box, "export");

    expect(listedTitles()).toEqual(["Export board to CSV"]);
  });

  it("matches keywords in the description too, case-insensitively", async () => {
    const user = userEvent.setup();
    renderPortal();
    await screen.findByRole("button", { name: /view details for "Dark mode toggle"/i });

    // "dark" hits the title of item a AND the description of item c — and an
    // upper-case query still matches, proving the search is case-insensitive.
    await user.type(screen.getByRole("searchbox", { name: /search feedback/i }), "DARK");

    expect(listedTitles()).toEqual(["Dark mode toggle", "Login screen crash"]);
  });

  it("composes the search with the type filter (search AND type)", async () => {
    const user = userEvent.setup();
    renderPortal();
    await screen.findByRole("button", { name: /view details for "Dark mode toggle"/i });

    await user.type(screen.getByRole("searchbox", { name: /search feedback/i }), "dark");
    // Both a (FEATURE) and c (BUG) match "dark"; restricting to Features drops
    // the bug, leaving only the feature request.
    await user.selectOptions(screen.getByLabelText("Filter by type"), "FEATURE");

    expect(listedTitles()).toEqual(["Dark mode toggle"]);
  });

  it("clearly indicates when no matches are found, naming the query", async () => {
    const user = userEvent.setup();
    renderPortal();
    await screen.findByRole("button", { name: /view details for "Dark mode toggle"/i });

    await user.type(screen.getByRole("searchbox", { name: /search feedback/i }), "zzz-nope");

    // No items remain listed…
    expect(listedTitles()).toEqual([]);
    // …and the empty state names what was searched for.
    const emptyMsg = screen.getByText(/no feedback matching/i);
    expect(emptyMsg).toHaveTextContent(/zzz-nope/);
  });
});
