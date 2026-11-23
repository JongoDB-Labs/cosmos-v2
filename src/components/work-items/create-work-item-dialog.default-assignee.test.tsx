// @vitest-environment jsdom
// A new work item defaults its assignee to the person creating it.
//
// The signed-in user's id and the member list both arrive after the dialog
// opens, so the default is applied when they land — and never after the user
// has touched the picker: unticking yourself has to stick. A duplicate keeps
// its source's assignees, and nobody outside the member list is pre-picked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

const me = vi.hoisted(() => ({ id: "u2" as string | null }));
vi.mock("@/lib/hooks/use-current-user", () => ({ useCurrentUserId: () => me.id }));
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

const MEMBERS = [
  { userId: "u1", user: { id: "u1", displayName: "Ana Beltran", email: "ana@x.co" } },
  { userId: "u2", user: { id: "u2", displayName: "Bob Carr", email: "bob@x.co" } },
  { userId: "u3", user: { id: "u3", displayName: "Cy Dent", email: "cy@x.co" } },
];

function checkedNames() {
  const box = screen.getByLabelText("Search assignees").parentElement!;
  return within(box)
    .getAllByRole("checkbox")
    .filter((cb) => (cb as HTMLInputElement).checked)
    .map((cb) => cb.parentElement!.textContent!.trim());
}

function boxFor(name: string) {
  const box = screen.getByLabelText("Search assignees").parentElement!;
  return within(box)
    .getAllByRole("checkbox")
    .find((cb) => cb.parentElement!.textContent!.trim() === name)!;
}

let source: Record<string, unknown> = {};
beforeEach(() => {
  me.id = "u2";
  source = {};
  vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  vi.mocked(useWorkItemTypes).mockReturnValue({
    types: [{ id: "t1", key: "software.task", name: "Task" }],
  } as never);
  vi.mocked(jsonFetch).mockImplementation(((url: string) => {
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
    if (url.endsWith("/boards")) {
      return Promise.resolve([{ id: "b1", columns: [{ key: "todo", name: "To Do" }] }]);
    }
    if (url.includes("/work-items/src1")) return Promise.resolve(source);
    return Promise.resolve([]);
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PROJECTS = [{ id: "p1", key: "ENG", name: "Engineering" }];

function renderDialog(extra: Record<string, unknown> = {}) {
  return render(
    <CreateWorkItemDialog
      orgId="o1"
      open
      onOpenChange={vi.fn()}
      projects={PROJECTS}
      onCreated={vi.fn()}
      {...extra}
    />,
  );
}

describe("CreateWorkItemDialog — the creator is the default assignee", () => {
  it("ticks the signed-in user once the members load", async () => {
    renderDialog();
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));
  });

  it("applies the default when the user id arrives after the members", async () => {
    me.id = null;
    const view = renderDialog();
    await screen.findByText("Bob Carr");
    expect(checkedNames()).toEqual([]);

    me.id = "u2";
    view.rerender(
      <CreateWorkItemDialog orgId="o1" open onOpenChange={vi.fn()} projects={PROJECTS} onCreated={vi.fn()} />,
    );
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));
  });

  it("lets the user untick themselves, and it stays unticked", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));

    await user.click(boxFor("Bob Carr"));
    // Give any late effect a chance to re-tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(checkedNames()).toEqual([]);
  });

  it("does not pre-pick someone who is not in the member list", async () => {
    // Checked boxes can't show this: a non-member has no row to tick. The
    // create request is the evidence.
    me.id = "outsider";
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("Bob Carr");
    await user.type(screen.getByLabelText("Title"), "A task");
    await user.type(screen.getByLabelText(/planned start/i), "2026-07-01");
    await user.type(screen.getByLabelText(/planned end/i), "2026-07-15");
    await user.click(screen.getByRole("button", { name: "Create work item" }));

    await waitFor(() =>
      expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true),
    );
    const [, init] = vi.mocked(jsonFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty("assigneeIds");
  });

  it("keeps a duplicate's own assignees, even when it had none", async () => {
    source = {
      id: "src1", title: "Original", priority: "MEDIUM", workItemTypeId: "t1",
      assignees: [], assigneeId: null, storyPoints: null, description: "",
      tags: [], startDate: null, dueDate: null, intervalId: null, teamId: null,
    };
    renderDialog({ duplicateSource: { projectId: "p1", itemId: "src1" } });
    await screen.findByDisplayValue("Copy of Original");
    await screen.findByText("Bob Carr");
    await new Promise((r) => setTimeout(r, 50));
    expect(checkedNames()).toEqual([]);
  });
});
