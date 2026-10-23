// @vitest-environment jsdom
// COSMOS-223: picking an interval in the New issue dialog fills the planned
// start and end from the interval, but only where they are still empty.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

function mockApi(intervals: { id: string; name: string; startDate?: string; endDate?: string }[]) {
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

function renderDialog() {
  render(
    <CreateWorkItemDialog orgId="o1" open onOpenChange={vi.fn()} projects={PROJECTS} prefilledProjectId="p1" />,
  );
}

const SPRINT = {
  id: "i1",
  name: "Sprint 26.4.1",
  startDate: "2026-11-02T00:00:00.000Z",
  endDate: "2026-11-13T00:00:00.000Z",
};

describe("CreateWorkItemDialog: an interval fills empty planned dates (COSMOS-223)", () => {
  it("fills both planned dates from the interval when they are empty", async () => {
    mockApi([SPRINT]);
    const user = userEvent.setup();
    renderDialog();
    await screen.findByRole("dialog");

    await user.selectOptions(await screen.findByRole("combobox", { name: "Interval" }), "i1");

    expect(screen.getByLabelText(/planned start/i)).toHaveValue("2026-11-02");
    expect(screen.getByLabelText(/planned end/i)).toHaveValue("2026-11-13");
  });

  it("keeps a planned date the user already entered", async () => {
    mockApi([SPRINT]);
    const user = userEvent.setup();
    renderDialog();
    await screen.findByRole("dialog");
    await user.clear(screen.getByLabelText(/planned start/i));
    await user.type(screen.getByLabelText(/planned start/i), "2026-10-30");

    await user.selectOptions(await screen.findByRole("combobox", { name: "Interval" }), "i1");

    expect(screen.getByLabelText(/planned start/i)).toHaveValue("2026-10-30");
    expect(screen.getByLabelText(/planned end/i)).toHaveValue("2026-11-13");
  });
});
