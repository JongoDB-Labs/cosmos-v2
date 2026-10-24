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
// COSMOS-208, from a release train engineer: prompt for Description, Acceptance
// criteria and Definition of done when writing a ticket, with example text,
// and allow switching to plain text. Stored as one markdown description.
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

function postBody() {
  const call = vi.mocked(jsonFetch).mock.calls.find(
    ([url, init]) => String(url).endsWith("/work-items") && (init as RequestInit | undefined)?.method === "POST",
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  vi.mocked(useWorkItemTypes).mockReturnValue({ types: [{ id: "t1", key: "software.task", name: "Task" }] } as never);
  vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
    if (url.endsWith("/boards")) return Promise.resolve([{ id: "b1", columns: [{ key: "todo", name: "To Do" }] }]);
    if (url.endsWith("/work-items") && init?.method === "POST") return Promise.resolve({ id: "w", ticketNumber: 1 });
    return Promise.resolve([]);
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openFilled(user: ReturnType<typeof userEvent.setup>) {
  render(<CreateWorkItemDialog orgId="o1" open onOpenChange={vi.fn()} projects={PROJECTS} prefilledProjectId="p1" />);
  await screen.findByRole("dialog");
  await user.type(screen.getByLabelText("Title"), "Collapse past PIs");
  await user.type(screen.getByLabelText(/planned start/i), "2026-07-01");
  await user.type(screen.getByLabelText(/planned end/i), "2026-07-15");
}

describe("CreateWorkItemDialog: write-up template (COSMOS-208)", () => {
  it("prompts for the three sections, with example text, by default", async () => {
    const user = userEvent.setup();
    await openFilled(user);

    expect(screen.getByRole("radio", { name: "Template" })).toHaveAttribute("aria-checked", "true");
    for (const name of ["Description", "Acceptance criteria", "Definition of done"]) {
      const box = screen.getByLabelText(name) as HTMLTextAreaElement;
      expect(box.placeholder).toMatch(/e\.g\./);
      expect(box.value).toBe(""); // examples are placeholders, never saved text
    }
  });

  it("stores the filled sections as one markdown description", async () => {
    const user = userEvent.setup();
    await openFilled(user);
    await user.type(screen.getByLabelText("Description"), "Keep the row about current work.");
    await user.type(screen.getByLabelText("Acceptance criteria"), "- Past PIs start collapsed");
    await user.type(screen.getByLabelText("Definition of done"), "- Demoed to the RTE");
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody().description).toBe(
      "## Description\n\nKeep the row about current work.\n\n## Acceptance criteria\n\n- Past PIs start collapsed\n\n## Definition of done\n\n- Demoed to the RTE",
    );
  });

  it("switches to plain text and back without losing what was typed", async () => {
    const user = userEvent.setup();
    await openFilled(user);
    await user.type(screen.getByLabelText("Description"), "Why");
    await user.type(screen.getByLabelText("Acceptance criteria"), "- It works");

    await user.click(screen.getByRole("radio", { name: "Plain text" }));
    const plain = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(plain.value).toBe("## Description\n\nWhy\n\n## Acceptance criteria\n\n- It works");
    expect(screen.queryByLabelText("Definition of done")).toBeNull();

    await user.type(plain, "\n\n## Definition of done\n\n- Shipped");
    await user.click(screen.getByRole("radio", { name: "Template" }));
    expect(screen.getByLabelText("Description")).toHaveValue("Why");
    expect(screen.getByLabelText("Acceptance criteria")).toHaveValue("- It works");
    expect(screen.getByLabelText("Definition of done")).toHaveValue("- Shipped");
  });

  it("remembers plain text for next time", async () => {
    const user = userEvent.setup();
    await openFilled(user);
    await user.click(screen.getByRole("radio", { name: "Plain text" }));
    cleanup();

    render(<CreateWorkItemDialog orgId="o1" open onOpenChange={vi.fn()} projects={PROJECTS} prefilledProjectId="p1" />);
    await screen.findByRole("dialog");
    expect(screen.getByRole("radio", { name: "Plain text" })).toHaveAttribute("aria-checked", "true");
  });
});
