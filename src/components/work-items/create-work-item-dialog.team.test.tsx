// @vitest-environment jsdom
// COSMOS-204, from a release train engineer: a story is handed to a TEAM
// before anyone on it picks it up, so "New issue" offers a Team picker that is
// separate from Assignees, and sends the choice with the create.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
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

const TEAMS = [
  { id: "team-cs", name: "Customer Success", members: [] },
  { id: "team-pl", name: "Platform", members: [] },
];

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

function mockApi(teams: unknown[]) {
  vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
    if (url.endsWith("/teams")) return Promise.resolve(teams);
    if (url.endsWith("/boards")) {
      return Promise.resolve([{ id: "b1", columns: [{ key: "todo", name: "To Do" }] }]);
    }
    if (url.endsWith("/work-items") && init?.method === "POST") {
      return Promise.resolve({ id: "wi1", ticketNumber: 9 });
    }
    return Promise.resolve([]);
  }) as never);
}

beforeEach(() => {
  vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  vi.mocked(useWorkItemTypes).mockReturnValue({
    types: [{ id: "t1", key: "software.task", name: "Task" }],
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Title"), "Onboard the new region");
  await user.type(screen.getByLabelText(/planned start/i), "2026-07-01");
  await user.type(screen.getByLabelText(/planned end/i), "2026-07-15");
}

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

describe("CreateWorkItemDialog — Team (COSMOS-204)", () => {
  it("creates an item for a team with nobody assigned", async () => {
    mockApi(TEAMS);
    const user = userEvent.setup();
    renderDialog();

    const team = await screen.findByRole("combobox", { name: "Team" });
    await fillRequired(user);
    await user.selectOptions(team, "Customer Success");
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody().teamId).toBe("team-cs");
    expect(postBody()).not.toHaveProperty("assigneeIds");
  });

  it("sends no team when none is picked", async () => {
    mockApi(TEAMS);
    const user = userEvent.setup();
    renderDialog();

    await screen.findByRole("combobox", { name: "Team" });
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Create issue" }));

    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody()).not.toHaveProperty("teamId");
  });

  it("hides the picker in a project with no teams", async () => {
    mockApi([]);
    renderDialog();

    await screen.findByLabelText("Title");
    await waitFor(() =>
      expect(vi.mocked(jsonFetch).mock.calls.some(([u]) => String(u).endsWith("/teams"))).toBe(true),
    );
    expect(screen.queryByRole("combobox", { name: "Team" })).toBeNull();
  });
});
