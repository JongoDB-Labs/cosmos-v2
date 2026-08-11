// @vitest-environment jsdom
// COSMOS-63 — two reported defects in the board "New issue" dialog:
//   1. Escape does not close it.
//   2. It "orphans" across a client-side route change: the body scroll lock
//      stays applied and Cancel is inert.
//
// Boards now share the one CreateWorkItemDialog (COSMOS-40); NewIssueButton is
// the thin wrapper that owns its `open` state. So this drives the wrapper, which
// is the surface a user actually touches on a board.
//
// The orphan test rerenders the SAME component at the SAME position with a
// different `boardId` — exactly what the App Router does navigating between two
// boards of the same type, where React updates in place instead of remounting.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- base-ui needs these in jsdom ---
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

vi.mock("@/hooks/use-work-item-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-work-item-types")>()),
  useWorkItemTypes: vi.fn(),
}));
vi.mock("@/hooks/use-custom-fields", () => ({ useCustomFields: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/keys", () => ({
  useOrgQueryKey: (...parts: unknown[]) => ["org", "acme", ...parts],
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));

import { NewIssueButton } from "./new-issue-button";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { jsonFetch } from "@/lib/query/json-fetcher";

const BASE = {
  orgId: "o1",
  projectId: "p1",
  projectKey: "ENG",
  onCreated: () => {},
};

beforeEach(() => {
  vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  vi.mocked(useWorkItemTypes).mockReturnValue({
    types: [{ id: "t1", key: "task", name: "Task" }],
  } as never);
  vi.mocked(jsonFetch).mockImplementation((() => Promise.resolve([])) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.documentElement.removeAttribute("data-base-ui-scroll-locked");
  document.body.style.overflow = "";
  document.documentElement.style.overflow = "";
});

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /new issue/i }));
  await screen.findByRole("dialog");
}

describe("board New issue dialog", () => {
  it("closes when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<NewIssueButton {...BASE} boardId="b1" />);
    await open(user);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes when the board changes underneath it (same view type, no remount)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NewIssueButton {...BASE} boardId="b1" />);
    await open(user);

    rerender(<NewIssueButton {...BASE} boardId="b2" />);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes when the project changes underneath it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NewIssueButton {...BASE} boardId="b1" />);
    await open(user);

    rerender(
      <NewIssueButton {...BASE} projectId="p2" projectKey="OPS" boardId="b1" />,
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

// NOT TESTED HERE: that the body scroll lock is released. I wrote that test,
// and it failed on its own GUARD — base-ui never applies a detectable lock under
// jsdom (no layout, no scrollbar), so `scrollLocked()` was false even with the
// dialog open. Asserting it becomes false afterwards would then have passed
// while measuring nothing. The lock is base-ui's, keyed off the dialog being
// open, so "the dialog is closed" above is the real precondition — and that IS
// asserted. Left as a comment rather than a test that cannot fail correctly.
