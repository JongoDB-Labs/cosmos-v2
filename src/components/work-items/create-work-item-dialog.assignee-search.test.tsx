// @vitest-environment jsdom
// COSMOS-171 — the Assignees list in "New issue" rendered the members in
// whatever order the API returned them, with no way to narrow it. Once an org
// grew past a screenful, picking someone meant scrolling a 28px-high box hunting
// for a name. This locks the two affordances that fixed it: alphabetical order,
// and a search box that matches the display name OR the email.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
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

// Deliberately NOT alphabetical, and "zoe" is lowercase so a naive sort that
// compares raw code units would push it behind the capitalised names.
const MEMBERS = [
  { userId: "u1", user: { id: "u1", displayName: "Ivan Petrov", email: "ivan@x.co" } },
  { userId: "u2", user: { id: "u2", displayName: "zoe adams", email: "zoe@x.co" } },
  { userId: "u3", user: { id: "u3", displayName: "Ana Beltran", email: "ana@x.co" } },
  { userId: "u4", user: { id: "u4", displayName: "Bob Carr", email: "robert@x.co" } },
];

function assigneeNames() {
  const box = screen.getByLabelText("Search assignees").parentElement!;
  return within(box)
    .getAllByRole("checkbox")
    .map((cb) => cb.parentElement!.textContent!.trim());
}

beforeEach(() => {
  vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  vi.mocked(useWorkItemTypes).mockReturnValue({
    types: [{ id: "t1", key: "software.task", name: "Task" }],
  } as never);
  vi.mocked(jsonFetch).mockImplementation(((url: string) => {
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
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

function renderDialog() {
  render(
    <CreateWorkItemDialog
      orgId="o1"
      open
      onOpenChange={vi.fn()}
      projects={[{ id: "p1", key: "ENG", name: "Engineering" }]}
      onCreated={vi.fn()}
    />,
  );
}

describe("CreateWorkItemDialog — assignee sort + search (COSMOS-171)", () => {
  it("lists members alphabetically by name regardless of the API's order", async () => {
    renderDialog();

    await screen.findByLabelText("Search assignees");
    await screen.findByText("Ana Beltran");
    expect(assigneeNames()).toEqual([
      "Ana Beltran",
      "Bob Carr",
      "Ivan Petrov",
      "zoe adams",
    ]);
  });

  it("narrows the list to a case-insensitive substring of the name", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("Ana Beltran");

    await user.type(screen.getByLabelText("Search assignees"), "aN");

    // "Ana Beltran" and "Ivan Petrov" both contain "an"; Bob and zoe do not.
    expect(assigneeNames()).toEqual(["Ana Beltran", "Ivan Petrov"]);
  });

  it("matches the email too, even when the row shows a display name", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("Bob Carr");

    await user.type(screen.getByLabelText("Search assignees"), "robert@");

    expect(assigneeNames()).toEqual(["Bob Carr"]);
  });

  it("says so when nobody matches, and restores the list when cleared", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("Ana Beltran");

    const search = screen.getByLabelText("Search assignees");
    await user.type(search, "nobody here");
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText("Ana Beltran")).not.toBeInTheDocument();

    await user.clear(search);
    expect(assigneeNames()).toHaveLength(4);
  });

  it("still checks the right member after filtering", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("Ana Beltran");

    await user.type(screen.getByLabelText("Search assignees"), "zoe");
    const [box] = within(
      screen.getByLabelText("Search assignees").parentElement!,
    ).getAllByRole("checkbox");
    await user.click(box);

    expect(box).toBeChecked();
    // And it is still checked once the filter is lifted — the checkbox is bound
    // to the member's id, not to its position in the filtered list.
    await user.clear(screen.getByLabelText("Search assignees"));
    const checked = within(screen.getByLabelText("Search assignees").parentElement!)
      .getAllByRole("checkbox")
      .filter((cb) => (cb as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect(checked[0].parentElement!.textContent!.trim()).toBe("zoe adams");
  });
});
