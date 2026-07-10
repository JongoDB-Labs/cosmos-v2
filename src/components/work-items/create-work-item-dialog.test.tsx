// @vitest-environment jsdom
// COSMOS-86 — the org-wide "New issue" dialog let users fill in the form but
// never created the item, while the Kanban board's inline quick-create worked.
// Two anomalies unique to THIS dialog caused it, and both are locked here:
//
//   1. The "Create issue" button was disabled until `workItemTypeId` was set,
//      so if the org's work-item types were slow / failed to load the button
//      stayed permanently disabled — the user could type a title but never
//      submit. Every working create path (CardQuickCreate, CreateIssueButton)
//      deliberately does NOT block on the async types fetch and falls back to
//      the bare "TASK" type.
//
//   2. `handleSubmit` made a prerequisite `GET /boards` via the THROWING
//      `jsonFetch` just to derive a columnKey. That route is BOARD_READ-gated,
//      so a user with ITEM_CREATE but not BOARD_READ (or any transient non-2xx)
//      threw before the work-items POST was ever sent — the create silently
//      aborted while the board quick-create still worked. It must fall back to
//      "backlog" and still POST.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

// Mock the async hooks the dialog reads so the test controls exactly what the
// types/custom-fields fetches "returned" — no QueryClientProvider needed.
vi.mock("@/hooks/use-work-item-types", () => ({ useWorkItemTypes: vi.fn() }));
vi.mock("@/hooks/use-custom-fields", () => ({ useCustomFields: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreateWorkItemDialog } from "./create-work-item-dialog";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { jsonFetch } from "@/lib/query/json-fetcher";

const PROJECTS = [{ id: "p1", key: "ENG", name: "Engineering" }];

/** Grab the parsed body of the work-items POST, or null if it never fired. */
function postBody() {
  const call = vi
    .mocked(jsonFetch)
    .mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/work-items") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CreateWorkItemDialog — New issue button creates the item (COSMOS-86)", () => {
  beforeEach(() => {
    vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  });

  it("enables Create and submits with the TASK fallback even when the org's types never load", async () => {
    // The failure condition: work-item types haven't resolved (empty list).
    vi.mocked(useWorkItemTypes).mockReturnValue({ types: [] } as never);
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/boards")) {
        return Promise.resolve([{ id: "b1", columns: [{ key: "todo", name: "To Do" }] }]);
      }
      if (url.endsWith("/work-items") && init?.method === "POST") {
        return Promise.resolve({ id: "wi1", ticketNumber: 7 });
      }
      return Promise.resolve([]);
    }) as never);

    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <CreateWorkItemDialog
        orgId="o1"
        open
        onOpenChange={vi.fn()}
        projects={PROJECTS}
        onCreated={onCreated}
      />,
    );

    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Title"), "  Event day setup  ");

    // Regression: the button must NOT be gated on a resolved type.
    const createBtn = screen.getByRole("button", { name: "Create issue" });
    expect(createBtn).not.toBeDisabled();

    await user.click(createBtn);

    await waitFor(() => expect(postBody()).not.toBeNull());
    const body = postBody();
    expect(body.title).toBe("Event day setup");
    expect(body.type).toBe("TASK"); // server-resolved fallback
    expect(body).not.toHaveProperty("workItemTypeId");
    expect(body.columnKey).toBe("todo");
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("still creates when the prerequisite boards GET fails (falls back to backlog, never aborts)", async () => {
    vi.mocked(useWorkItemTypes).mockReturnValue({
      types: [{ id: "t1", key: "software.task", name: "Task" }],
    } as never);
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (url.endsWith("/members")) return Promise.resolve([]);
      // BOARD_READ-gated GET rejects — must not abort the create.
      if (url.endsWith("/boards")) return Promise.reject(new Error("HTTP 403"));
      if (url.endsWith("/work-items") && init?.method === "POST") {
        return Promise.resolve({ id: "wi1", ticketNumber: 8 });
      }
      return Promise.resolve([]);
    }) as never);

    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <CreateWorkItemDialog
        orgId="o1"
        open
        onOpenChange={vi.fn()}
        projects={PROJECTS}
        onCreated={onCreated}
      />,
    );

    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Title"), "User story: sign-in");
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    await waitFor(() => expect(postBody()).not.toBeNull());
    const body = postBody();
    expect(body.title).toBe("User story: sign-in");
    expect(body.columnKey).toBe("backlog"); // graceful fallback, POST still sent
    expect(body.workItemTypeId).toBe("t1");
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });
});
