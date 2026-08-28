// @vitest-environment jsdom
//
// COSMOS-164 — reported by users: "every time i try to work on the description
// of a ticket it blanks out / resets / refreshes and i lose my progress. same
// thing in feedback area i think."
//
// The feedback board subscribes to the org's SSE stream (COSMOS-129) and
// re-pulls its list on seven event types — including `work-item.created`, which
// fires for ANY work item created anywhere in the org, i.e. at moments that have
// nothing to do with what this user is doing. That loader set `loading` (and, on
// failure, `error`), and BOTH early-return above the submit dialog and the detail
// modal. So every background refresh ripped the dialog the user was typing into
// out of the DOM for the duration of the request — losing focus and the caret, so
// the next keystrokes landed nowhere — and a refresh that failed replaced the
// board with an error panel and hid it entirely.
//
// The window that matters is while the request is IN FLIGHT, so these tests hold
// the fetch open and assert against that moment; asserting only after it settles
// proves nothing, because the portal component itself never unmounts and its
// state comes back with it.
//
// Both halves are locked: a background refresh must not disturb an open dialog,
// and it must still actually refresh the list (otherwise dropping the
// subscription altogether would "pass" this file).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, cleanup } from "@testing-library/react";
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

// Capture the portal's realtime handlers so a test can deliver a live event at
// the exact moment a real one would arrive: mid-typing.
const rt = vi.hoisted(() => ({
  handlers: {} as Record<string, (payload?: unknown) => void>,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/test-org/feedback" }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-realtime-events", () => ({
  useRealtimeEvents: (
    _orgId: string,
    handlers: Record<string, (payload?: unknown) => void>,
  ) => {
    rt.handlers = handlers;
  },
}));
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn(() => Promise.resolve([])),
}));

import { FeedbackPortal } from "./feedback-portal";
import { PermissionsProvider } from "@/components/providers/permissions-provider";

const EXISTING = {
  id: "fr-1",
  type: "FEATURE" as const,
  title: "Bulk-archive completed work items",
  description: "Archive many items at once.",
  status: "OPEN" as const,
  voteCount: 4,
  hasVoted: false,
  isMine: false,
  createdAt: "2026-07-01T12:00:00.000Z",
  attachments: [],
  authorName: "Ada Lovelace",
  authorEmail: "ada@test.local",
};
// What the board pulls back on the live refresh — someone else's submission
// landing while this user types.
const ARRIVED = { ...EXISTING, id: "fr-2", title: "Someone else's brand-new request" };

/**
 * The list loads through a raw `fetch(basePath)`. The mount load resolves at
 * once; the NEXT one (the live refresh) is held open until the test releases it,
 * which is the window a real network round-trip occupies and the window the bug
 * lived in. `settle` resolves it with the refreshed board; `fail` rejects it.
 */
function deferredFetch() {
  let release!: (outcome: { ok: boolean }) => void;
  const gate = new Promise<{ ok: boolean }>((r) => {
    release = r;
  });
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => [EXISTING] } as Response;
    }
    const outcome = await gate;
    if (!outcome.ok) return { ok: false, status: 500, json: async () => ({}) } as Response;
    return {
      ok: true,
      status: 200,
      json: async () => [EXISTING, ARRIVED],
    } as Response;
  });
  return {
    fetchMock,
    settle: () => act(async () => void release({ ok: true })),
    fail: () => act(async () => void release({ ok: false })),
  };
}

const renderPortal = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PermissionsProvider orgs={[{ id: "org-1", slug: "test-org", role: "ADMIN" }]}>
      <QueryClientProvider client={qc}>
        <FeedbackPortal orgId="org-1" />
      </QueryClientProvider>
    </PermissionsProvider>,
  );
};

/** Deliver one server event, flushing only the render it schedules synchronously. */
function emit(type: string) {
  const handler = rt.handlers[type];
  expect(handler, `portal should subscribe to ${type}`).toBeTypeOf("function");
  act(() => {
    handler();
  });
}

describe("FeedbackPortal — a live refresh must not tear down what you're typing (COSMOS-164)", () => {
  let deferred: ReturnType<typeof deferredFetch>;

  beforeEach(() => {
    rt.handlers = {};
    deferred = deferredFetch();
    vi.stubGlobal("fetch", deferred.fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("leaves an in-progress submission untouched while a live refresh is in flight", async () => {
    const user = userEvent.setup();
    renderPortal();
    await screen.findByRole("button", {
      name: /view details for "Bulk-archive completed work items"/i,
    });

    await user.click(screen.getByRole("button", { name: /submit feedback/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Title"), "Half-typed idea");
    const details = within(dialog).getByLabelText(/details \(optional\)/i);
    await user.type(details, "Two paragraphs I do not want to retype");
    expect(details).toHaveFocus();

    // A work item is created elsewhere in the org — nothing to do with this user.
    emit("work-item.created");

    // Mid-request: the very same dialog and textarea are still mounted, still
    // focused, still holding every character. (With the skeleton early-return
    // they were gone for the whole round-trip and the caret with them.)
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByLabelText(/details \(optional\)/i)).toBe(details);
    expect(details).toHaveFocus();
    expect(details).toHaveValue("Two paragraphs I do not want to retype");
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Half-typed idea");

    // …and the refresh genuinely ran: the item that arrived is on the board.
    await deferred.settle();
    expect(screen.getByText("Someone else's brand-new request")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(details).toHaveValue("Two paragraphs I do not want to retype");
  });

  it("leaves an in-progress edit of an item's details untouched while a live refresh is in flight", async () => {
    const user = userEvent.setup();
    renderPortal();

    await user.click(
      await screen.findByRole("button", {
        name: /view details for "Bulk-archive completed work items"/i,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Edit" }));

    const details = within(dialog).getByLabelText("Details");
    await user.clear(details);
    await user.type(details, "A much better description, rewritten by hand");

    emit("feedback.delivered");

    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByLabelText("Details")).toBe(details);
    expect(details).toHaveFocus();
    // Still the user's text — never the server's copy.
    expect(details).toHaveValue("A much better description, rewritten by hand");

    await deferred.settle();
    expect(screen.getByLabelText("Details")).toBe(details);
    expect(details).toHaveValue("A much better description, rewritten by hand");
  });

  it("keeps the board (and the open dialog) when a live refresh FAILS", async () => {
    const user = userEvent.setup();
    renderPortal();
    await screen.findByRole("button", {
      name: /view details for "Bulk-archive completed work items"/i,
    });

    await user.click(screen.getByRole("button", { name: /submit feedback/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Title"), "Half-typed idea");

    emit("feedback.rejected");
    await deferred.fail();

    // A background refresh that couldn't reach the server leaves the last good
    // board — and the dialog — exactly as they were, rather than swapping the
    // whole surface for "Couldn't load feedback."
    expect(screen.queryByText(/couldn't load feedback/i)).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Half-typed idea");
    expect(
      screen.getByText("Bulk-archive completed work items"),
    ).toBeInTheDocument();
  });
});
