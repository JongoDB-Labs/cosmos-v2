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
vi.mock("@/lib/query/json-fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/query/json-fetcher")>()),
  jsonFetch: vi.fn(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

import { QuickCreateWorkItem } from "./quick-create-work-item";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { toast } from "sonner";

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
    // A controlled <select> whose value matches no option still SHOWS
    // "Unassigned", so the request is the evidence, not the select.
    me.id = "outsider";
    const user = userEvent.setup();
    renderIt();
    await screen.findByText("Bob Carr");
    await new Promise((r) => setTimeout(r, 50));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(vi.mocked(jsonFetch).mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "POST")).toBe(true),
    );
    const [, init] = vi.mocked(jsonFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((init as RequestInit).body)).assigneeId).toBeNull();
  });
});

describe("QuickCreateWorkItem — submit and fallback", () => {
  function posts() {
    return vi.mocked(jsonFetch).mock.calls
      .filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")
      .map(([, i]) => JSON.parse(String((i as RequestInit).body)));
  }

  it("creates it unassigned, and says so, when a rule refuses the creator", async () => {
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return JSON.parse(String(init.body)).assigneeId
          ? Promise.reject(new FetchError(403, {}, "forbidden"))
          : Promise.resolve({ id: "new" });
      }
      return Promise.resolve(url.endsWith("/members") ? MEMBERS : []);
    }) as never);
    const user = userEvent.setup();
    renderIt();
    await screen.findByText("Bob Carr");
    await waitFor(() => expect(assigneeSelect().value).toBe("u2"));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].assigneeId).toBe("u2");
    expect(posts()[1].assigneeId).toBeNull();
    expect(toast.warning).toHaveBeenCalled();
  });

  it("does not show the creator as assignee mid-submit when the request is unassigned", async () => {
    // Create pressed before the member list lands: the request captures
    // "unassigned"; the picker must not then switch to the creator.
    let releaseMembers!: (v: unknown) => void;
    let releaseBoards!: (v: unknown) => void;
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise(() => {});
      if (url.endsWith("/members")) return new Promise((r) => (releaseMembers = r));
      if (url.endsWith("/boards")) return new Promise((r) => (releaseBoards = r));
      return Promise.resolve([]);
    }) as never);
    const user = userEvent.setup();
    renderIt();
    await user.click(screen.getByRole("button", { name: "Create" }));
    releaseMembers(MEMBERS);
    await screen.findByText("Bob Carr");
    await new Promise((r) => setTimeout(r, 50));
    expect(assigneeSelect().value).toBe("");
    releaseBoards([]);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].assigneeId).toBeNull();
  });
});
