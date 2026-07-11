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

describe("CreateWorkItemDialog — cycle is settable at creation (COSMOS-64)", () => {
  beforeEach(() => {
    vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
    vi.mocked(useWorkItemTypes).mockReturnValue({
      types: [{ id: "t1", key: "software.task", name: "Task" }],
    } as never);
  });

  /** Mock every fetch the dialog makes, serving the project's cycles. */
  function mockWithCycles() {
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/cycles")) {
        return Promise.resolve([
          { id: "c1", name: "Sprint 1" },
          { id: "c2", name: "Sprint 2" },
        ]);
      }
      if (url.endsWith("/boards")) {
        return Promise.resolve([{ id: "b1", columns: [{ key: "todo", name: "To Do" }] }]);
      }
      if (url.endsWith("/work-items") && init?.method === "POST") {
        return Promise.resolve({ id: "wi1", ticketNumber: 9 });
      }
      return Promise.resolve([]);
    }) as never);
  }

  it("exposes a Cycle picker and submits the chosen cycleId", async () => {
    mockWithCycles();
    const user = userEvent.setup();
    render(
      <CreateWorkItemDialog
        orgId="o1"
        open
        onOpenChange={vi.fn()}
        projects={PROJECTS}
        onCreated={vi.fn()}
      />,
    );

    await screen.findByRole("dialog");
    // The picker only appears once the project's cycles have loaded.
    const cycleSelect = await screen.findByLabelText("Cycle");
    await user.type(screen.getByLabelText("Title"), "Scoped to a sprint");
    await user.selectOptions(cycleSelect, "c2");
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody().cycleId).toBe("c2");
  });

  it("omits cycleId when no cycle is chosen (extra fields stay optional)", async () => {
    mockWithCycles();
    const user = userEvent.setup();
    render(
      <CreateWorkItemDialog
        orgId="o1"
        open
        onOpenChange={vi.fn()}
        projects={PROJECTS}
        onCreated={vi.fn()}
      />,
    );

    await screen.findByRole("dialog");
    await screen.findByLabelText("Cycle"); // picker present but left untouched
    await user.type(screen.getByLabelText("Title"), "No sprint yet");
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody()).not.toHaveProperty("cycleId");
  });
});

describe("CreateWorkItemDialog — Duplicate issue draft (COSMOS-13)", () => {
  // The source issue the draft is seeded from. Its GET payload carries the core
  // fields; comments/activity/status are deliberately absent from create, so a
  // duplicate can never carry them over.
  const SOURCE = {
    title: "Review vendor A codebase",
    description: "Full security review of the repo.",
    priority: "HIGH",
    workItemTypeId: "t2",
    assigneeId: "u1",
    assignees: [{ userId: "u1" }],
    cycleId: null,
    storyPoints: 5,
    dueDate: "2026-08-01T00:00:00.000Z",
    tags: ["security", "review"],
    customFields: null,
  };

  beforeEach(() => {
    vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
    vi.mocked(useWorkItemTypes).mockReturnValue({
      types: [
        { id: "t1", key: "software.task", name: "Task" },
        { id: "t2", key: "software.bug", name: "Bug" },
      ],
    } as never);
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (url.endsWith("/members")) {
        return Promise.resolve([
          { userId: "u1", user: { id: "u1", displayName: "Ana", email: "ana@x.co" } },
        ]);
      }
      if (url.endsWith("/cycles")) return Promise.resolve([]);
      if (url.endsWith("/boards")) {
        return Promise.resolve([{ id: "b1", columns: [{ key: "todo", name: "To Do" }] }]);
      }
      // The source fetch — GET ends with the item id, not a bare /work-items.
      if (url.endsWith("/work-items/src1")) return Promise.resolve(SOURCE);
      if (url.endsWith("/work-items") && init?.method === "POST") {
        return Promise.resolve({ id: "wi-new", ticketNumber: 42 });
      }
      return Promise.resolve([]);
    }) as never);
  });

  it("pre-fills the draft from the source, lets you edit it, and creates a NEW issue (not a /duplicate clone)", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <CreateWorkItemDialog
        orgId="o1"
        open
        onOpenChange={vi.fn()}
        projects={[{ id: "p1", key: "ENG", name: "Engineering" }]}
        duplicateSource={{ itemId: "src1", projectId: "p1" }}
        onCreated={onCreated}
      />,
    );

    await screen.findByRole("dialog");
    // AC: the action reads as a duplicate.
    expect(screen.getByText("Duplicate issue")).toBeInTheDocument();

    // AC: core fields are pre-filled from the source.
    const title = await screen.findByDisplayValue("Copy of Review vendor A codebase");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Full security review of the repo.",
    );
    expect(screen.getByLabelText("Labels")).toHaveValue("security, review");

    // AC: the user can edit any field before saving.
    await user.clear(title);
    await user.type(title, "Review vendor B codebase");

    await user.click(screen.getByRole("button", { name: "Create issue" }));

    await waitFor(() => expect(postBody()).not.toBeNull());
    const body = postBody();
    // AC: saving creates a distinct new issue seeded from the source's fields.
    expect(body.title).toBe("Review vendor B codebase");
    expect(body.priority).toBe("HIGH");
    expect(body.workItemTypeId).toBe("t2");
    expect(body.description).toBe("Full security review of the repo.");
    expect(body.tags).toEqual(["security", "review"]);
    expect(body.assigneeIds).toEqual(["u1"]);
    expect(body.storyPoints).toBe(5);
    expect(String(body.dueDate)).toContain("2026-08-01");
    // AC: instance-specific data is never part of the create payload.
    expect(body).not.toHaveProperty("comments");
    expect(body).not.toHaveProperty("activities");

    // It went through the normal create POST, NOT the immediate /duplicate clone.
    const hitDuplicateRoute = vi
      .mocked(jsonFetch)
      .mock.calls.some(([u]) => String(u).endsWith("/duplicate"));
    expect(hitDuplicateRoute).toBe(false);

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });
});
