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
// COSMOS-205, from a release train engineer: block creating a Story or Feature
// until an interval (sprint or PI) is picked, in a project that has intervals.
// Other types, and projects with no intervals, are unaffected.
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
// Only the data-fetching hook is faked. `selectableTypes` and `typesForSector`
// come through REAL, so this dialog is filtered by the same code production
// runs — a passthrough stub would let a broken filter pass here unnoticed.
vi.mock("@/hooks/use-work-item-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-work-item-types")>()),
  useWorkItemTypes: vi.fn(),
}));
vi.mock("@/hooks/use-custom-fields", () => ({ useCustomFields: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreateWorkItemDialog } from "./create-work-item-dialog";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { jsonFetch } from "@/lib/query/json-fetcher";

const PROJECTS = [{ id: "p1", key: "ENG", name: "Engineering" }];
const TYPES = [
  { id: "t-task", key: "software.task", name: "Task" },
  { id: "t-story", key: "software.story", name: "Story" },
  { id: "t-feature", key: "feature", name: "Feature" },
];

function mockApi(intervals: { id: string; name: string }[]) {
  vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
    if (url.includes("/intervals")) return Promise.resolve(intervals);
    if (url.endsWith("/boards")) {
      return Promise.resolve([{ id: "b1", columns: [{ key: "todo", name: "To Do" }] }]);
    }
    if (url.endsWith("/work-items") && init?.method === "POST") {
      return Promise.resolve({ id: "wi1", ticketNumber: 7 });
    }
    return Promise.resolve([]);
  }) as never);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  vi.mocked(useWorkItemTypes).mockReturnValue({ types: TYPES } as never);
});

async function fillRequired(user: ReturnType<typeof userEvent.setup>, type: string) {
  await screen.findByRole("dialog");
  await user.type(screen.getByLabelText("Title"), "Onboard the pilot customer");
  await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), type);
  await user.clear(screen.getByLabelText(/planned start/i));
  await user.type(screen.getByLabelText(/planned start/i), "2026-07-01");
  await user.clear(screen.getByLabelText(/planned end/i));
  await user.type(screen.getByLabelText(/planned end/i), "2026-07-15");
}

function renderDialog() {
  render(
    <CreateWorkItemDialog orgId="o1" open onOpenChange={vi.fn()} projects={PROJECTS} prefilledProjectId="p1" />,
  );
}

describe("CreateWorkItemDialog: a Story or Feature needs an interval (COSMOS-205)", () => {
  it("blocks a Story until an interval is picked, then creates it in that interval", async () => {
    mockApi([{ id: "i1", name: "Sprint 26.4.1" }]);
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user, "Story");

    const interval = await screen.findByRole("combobox", { name: "Interval" });
    const create = screen.getByRole("button", { name: "Create issue" });
    expect(create).toBeDisabled();
    expect(interval).toHaveAttribute("aria-required", "true");
    expect(screen.getByText(/can't be created without one/)).toBeTruthy();

    await user.selectOptions(interval, "i1");
    expect(create).not.toBeDisabled();
    await user.click(create);

    await waitFor(() => {
      const call = vi.mocked(jsonFetch).mock.calls.find(
        ([url, init]) => String(url).endsWith("/work-items") && (init as RequestInit)?.method === "POST",
      );
      expect(call && JSON.parse((call[1] as RequestInit).body as string).intervalId).toBe("i1");
    });
  });

  it("applies to a custom Feature type with a bare key too", async () => {
    mockApi([{ id: "i1", name: "PI 26.4" }]);
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user, "Feature");
    await screen.findByRole("combobox", { name: "Interval" });
    expect(screen.getByRole("button", { name: "Create issue" })).toBeDisabled();
  });

  it("leaves a Task optional", async () => {
    mockApi([{ id: "i1", name: "Sprint 26.4.1" }]);
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user, "Task");
    await screen.findByRole("combobox", { name: "Interval" });
    expect(screen.getByRole("button", { name: "Create issue" })).not.toBeDisabled();
  });

  it("does not block a Story in a project that has no intervals", async () => {
    mockApi([]);
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user, "Story");
    expect(screen.queryByRole("combobox", { name: "Interval" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create issue" })).not.toBeDisabled();
  });
});
