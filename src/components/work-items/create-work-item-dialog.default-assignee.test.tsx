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
vi.mock("@/lib/query/json-fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/query/json-fetcher")>()),
  jsonFetch: vi.fn(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { CreateWorkItemDialog } from "./create-work-item-dialog";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { toast } from "sonner";
import { notifyError } from "@/lib/errors/notify";

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

  it("gives the default back when the dialog is reopened after unticking", async () => {
    const user = userEvent.setup();
    const props = { orgId: "o1", onOpenChange: vi.fn(), projects: PROJECTS, onCreated: vi.fn() };
    const view = render(<CreateWorkItemDialog {...props} open />);
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));
    await user.click(boxFor("Bob Carr"));
    expect(checkedNames()).toEqual([]);

    view.rerender(<CreateWorkItemDialog {...props} open={false} />);
    view.rerender(<CreateWorkItemDialog {...props} open />);
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));
  });

  it("re-applies the default when a late project list resets the form", async () => {
    // NewWorkItemButton loads its projects lazily: the dialog opens with none,
    // then the list lands, `firstProjectId` changes and the reset runs again,
    // emptying the picker the default had just filled.
    const props = { orgId: "o1", open: true, onOpenChange: vi.fn(), onCreated: vi.fn() };
    const view = render(<CreateWorkItemDialog {...props} projects={[]} />);
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));

    view.rerender(<CreateWorkItemDialog {...props} projects={PROJECTS} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(checkedNames()).toEqual(["Bob Carr"]);
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

describe("CreateWorkItemDialog — a refused default falls back to unassigned", () => {
  function posts() {
    return vi.mocked(jsonFetch).mock.calls
      .filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")
      .map(([, i]) => JSON.parse(String((i as RequestInit).body)));
  }
  function refuseAssigned() {
    const base = vi.mocked(jsonFetch).getMockImplementation()!;
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return body.assigneeIds
          ? Promise.reject(new FetchError(403, {}, "forbidden"))
          : Promise.resolve({ id: "new" });
      }
      return base(url, init as never);
    }) as never);
  }
  async function fillAndCreate(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Title"), "A task");
    await user.type(screen.getByLabelText(/planned start/i), "2026-07-01");
    await user.type(screen.getByLabelText(/planned end/i), "2026-07-15");
    await user.click(screen.getByRole("button", { name: "Create work item" }));
  }

  it("creates it unassigned, and says so, when a rule refuses the creator", async () => {
    refuseAssigned();
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));
    await fillAndCreate(user);

    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].assigneeIds).toEqual(["u2"]);
    expect(posts()[1]).not.toHaveProperty("assigneeIds");
    expect(toast.warning).toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("does not drop a duplicate's own assignee, even when it is the creator", async () => {
    source = {
      id: "src1", title: "Original", priority: "MEDIUM", workItemTypeId: "t1",
      assignees: [{ userId: "u2" }], assigneeId: "u2", storyPoints: null, description: "",
      tags: [], startDate: "2026-07-01T00:00:00.000Z", dueDate: "2026-07-15T00:00:00.000Z",
      intervalId: null, teamId: null,
    };
    refuseAssigned();
    const user = userEvent.setup();
    renderDialog({ duplicateSource: { projectId: "p1", itemId: "src1" } });
    await screen.findByDisplayValue("Copy of Original");
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));
    await user.click(screen.getByRole("button", { name: "Create work item" }));

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(posts()).toHaveLength(1);
  });

  it("does not tick the creator mid-submit when the request is unassigned", async () => {
    // Submitted before the user id arrived: the request carries nobody, so
    // the picker must not then show the creator.
    me.id = null;
    const base = vi.mocked(jsonFetch).getMockImplementation()!;
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) =>
      init?.method === "POST" ? new Promise(() => {}) : base(url, init as never)) as never);
    const user = userEvent.setup();
    const view = renderDialog();
    await screen.findByText("Bob Carr");
    await fillAndCreate(user);
    await waitFor(() => expect(posts()).toHaveLength(1));

    me.id = "u2";
    view.rerender(
      <CreateWorkItemDialog orgId="o1" open onOpenChange={vi.fn()} projects={PROJECTS} onCreated={vi.fn()} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(checkedNames()).toEqual([]);
    expect(posts()[0]).not.toHaveProperty("assigneeIds");
  });

  it("does not second-guess an assignee the user chose", async () => {
    refuseAssigned();
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(checkedNames()).toEqual(["Bob Carr"]));
    await user.click(boxFor("Ana Beltran"));
    await fillAndCreate(user);

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(posts()).toHaveLength(1);
  });
});
