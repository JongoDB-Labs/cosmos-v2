// @vitest-environment jsdom
// COSMOS-171 — "the list of users is growing and it is hard to find people you
// want to assign because there is no search and the user names are not sorted".
// The "New issue" dialog's Assignees field was a bare checkbox list rendered in
// the members route's `joinedAt` order inside a 7rem scroll box: no filter, no
// order. These lock the two things that fixed it, plus the multi-assign
// semantics that had to survive the swap (first pick = primary assignee).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
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

// Deliberately NOT alphabetical — this is join order, which is what the members
// route returns and what the picker used to show verbatim.
const MEMBERS = [
  { userId: "u1", user: { id: "u1", displayName: "Zoe Chen", email: "zoe@x.co" } },
  { userId: "u2", user: { id: "u2", displayName: "ada lovelace", email: "ada@x.co" } },
  { userId: "u3", user: { id: "u3", displayName: "Grace Hopper", email: "grace@x.co" } },
];

beforeEach(() => {
  vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  vi.mocked(useWorkItemTypes).mockReturnValue({
    types: [{ id: "t1", key: "software.task", name: "Task" }],
  } as never);
  vi.mocked(jsonFetch).mockImplementation(((url: string) => {
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
    if (url.endsWith("/intervals")) return Promise.resolve([]);
    if (url.endsWith("/boards")) {
      return Promise.resolve([{ id: "b1", columns: [{ key: "todo", name: "To Do" }] }]);
    }
    return Promise.resolve([]);
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Open the dialog and its Assignees dropdown; returns the search input. */
async function openAssignees() {
  const user = userEvent.setup();
  render(
    <CreateWorkItemDialog
      orgId="o1"
      open
      onOpenChange={vi.fn()}
      projects={[{ id: "p1", key: "ENG", name: "Engineering" }]}
    />,
  );
  await screen.findByRole("dialog");
  // The members fetch resolves after mount; wait for the field to be populated.
  const trigger = screen.getByLabelText("Assignees");
  await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.length).toBeGreaterThan(0));
  await user.click(trigger);
  // Scoped to the popup's listbox: the dialog's other pickers are native
  // <select>s, whose <option> children also carry role="option".
  const listbox = await screen.findByRole("listbox");
  return {
    user,
    input: screen.getByPlaceholderText("Search members…"),
    options: () => within(listbox).getAllByRole("option"),
  };
}

describe("CreateWorkItemDialog — Assignees (COSMOS-171)", () => {
  it("lists members alphabetically by display name, not in join order", async () => {
    const { options } = await openAssignees();

    // Case-insensitive: "ada lovelace" leads, it does not trail the capitalised
    // names the way a raw string sort would put it.
    expect(options().map((o) => o.textContent)).toEqual([
      "ada lovelace",
      "Grace Hopper",
      "Zoe Chen",
    ]);
  });

  it("filters the list from a search box as the user types", async () => {
    const { user, input, options } = await openAssignees();

    // Lowercase query against a mixed-case name, matching mid-label.
    await user.type(input, "hopper");

    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent("Grace Hopper");
  });

  it("still assigns several people, first pick first (primary assignee)", async () => {
    const { user, input } = await openAssignees();

    await user.type(input, "zoe");
    await user.keyboard("{ArrowDown}{Enter}");
    await user.type(input, "ada");
    await user.keyboard("{ArrowDown}{Enter}");

    // The trigger summarises the selection in pick order — Zoe stays primary
    // even though she sorts last.
    expect(screen.getByLabelText("Assignees")).toHaveTextContent(
      "Zoe Chen, ada lovelace",
    );
  });
});
