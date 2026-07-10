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
