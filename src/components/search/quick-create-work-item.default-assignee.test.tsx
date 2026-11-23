// @vitest-environment jsdom
// Cmd+K "Create work item…" defaults its Assignee to the person creating it,
// once the user id and member list have loaded — and a pick the user makes,
// including "Unassigned", is never overwritten.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const me = vi.hoisted(() => ({ id: "u2" as string | null }));
vi.mock("@/lib/hooks/use-current-user", () => ({ useCurrentUserId: () => me.id }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-work-item-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-work-item-types")>()),
  useWorkItemTypes: () => ({ types: [{ id: "t1", key: "software.task", name: "Task" }] }),
}));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { QuickCreateWorkItem } from "./quick-create-work-item";
import { jsonFetch } from "@/lib/query/json-fetcher";

const MEMBERS = [
  { userId: "u1", user: { id: "u1", displayName: "Ana Beltran", email: "ana@x.co" } },
  { userId: "u2", user: { id: "u2", displayName: "Bob Carr", email: "bob@x.co" } },
];

beforeEach(() => {
  me.id = "u2";
  vi.mocked(jsonFetch).mockImplementation(((url: string) =>
    Promise.resolve(url.endsWith("/members") ? MEMBERS : [])) as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderIt() {
  return render(
    <QuickCreateWorkItem
      orgId="o1"
      orgSlug="acme"
      title="Something"
      prefilledProject={{ id: "p1", key: "ENG", name: "Engineering" } as never}
      projects={[{ id: "p1", key: "ENG", name: "Engineering" }] as never}
      projectsLoading={false}
      onClose={vi.fn()}
    />,
  );
}

function assigneeSelect() {
  return screen
    .getAllByRole("combobox")
    .find((el) => Array.from((el as HTMLSelectElement).options).some((o) => o.text === "Unassigned")) as HTMLSelectElement;
}

describe("QuickCreateWorkItem — the creator is the default assignee", () => {
  it("selects the signed-in user once the members load", async () => {
    renderIt();
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(assigneeSelect().value).toBe("u2"));
  });

  it("keeps 'Unassigned' once the user picks it", async () => {
    const user = userEvent.setup();
    renderIt();
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(assigneeSelect().value).toBe("u2"));

    await user.selectOptions(assigneeSelect(), "");
    await new Promise((r) => setTimeout(r, 50));
    expect(assigneeSelect().value).toBe("");
  });

  it("keeps an explicit 'Unassigned' even if the user id arrives afterwards", async () => {
    me.id = null;
    const user = userEvent.setup();
    const view = renderIt();
    await screen.findByText("Bob Carr");
    await user.selectOptions(assigneeSelect(), "u1");
    await user.selectOptions(assigneeSelect(), "");

    me.id = "u2";
    view.rerender(
      <QuickCreateWorkItem
        orgId="o1"
        orgSlug="acme"
        title="Something"
        prefilledProject={{ id: "p1", key: "ENG", name: "Engineering" } as never}
        projects={[{ id: "p1", key: "ENG", name: "Engineering" }] as never}
        projectsLoading={false}
        onClose={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(assigneeSelect().value).toBe("");
  });

  it("does not pre-pick someone who is not in the member list", async () => {
    me.id = "outsider";
    renderIt();
    await screen.findByText("Bob Carr");
    await new Promise((r) => setTimeout(r, 50));
    expect(assigneeSelect().value).toBe("");
  });
});
