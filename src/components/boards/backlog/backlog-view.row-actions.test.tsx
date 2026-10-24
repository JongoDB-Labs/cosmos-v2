// @vitest-environment jsdom
//
// COSMOS-29: the backlog row menu offered Move to sprint, Archive and Highlight
// to everyone, whatever their role, and had no Open or Delete. It now follows
// the Kanban card: Open and Copy link for anyone who can see the row, edits
// behind ITEM_UPDATE, and Delete (with a confirm) behind ITEM_DELETE.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
  // The board's query bar (boards/shared/use-board-query) reads the URL too.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => <button type="button">New issue</button>,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));

const BOARD = {
  id: "b1",
  columns: [
    { id: "c1", key: "todo", name: "To Do", sortOrder: 0, category: "TODO" },
    { id: "c2", key: "done", name: "Done", sortOrder: 1, category: "DONE" },
  ],
};
const ITEMS = [
  {
    id: "w1",
    ticketNumber: 7,
    title: "Rewire the telemetry",
    columnKey: "todo",
    priority: "MEDIUM" as const,
    assigneeId: null,
    intervalId: null,
    sortOrder: 0,
  },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, opts?: { method?: string }) => {
    if (opts?.method === "DELETE") return Promise.resolve(null);
    if (url === "/api/v1/me")
      return Promise.resolve({ id: "me", email: "me@x.com", displayName: "Me" });
    if (url.endsWith("/boards/b1")) return Promise.resolve(BOARD);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    // One interval, so "Move to sprint" has a target and the menu is non-empty.
    // ActionMenu renders NOTHING when every group is empty, which would make
    // this whole test vacuous.
    if (url.endsWith("/intervals"))
      return Promise.resolve([
        { id: "s1", name: "Sprint 1", status: "ACTIVE", intervalKind: "SPRINT" },
      ]);
    return Promise.resolve([]);
  }),
}));


const { perms } = vi.hoisted(() => ({ perms: { mask: 0n } }));
vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...real,
    usePermissions: () => ({
      orgId: "o1", orgSlug: "acme", role: "MEMBER", permissions: perms.mask,
      can: (p: bigint) => (perms.mask & p) === p,
    }),
  };
});

import { BacklogView } from "./backlog-view";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { Permission } from "@/lib/rbac/permissions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderBacklog = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BacklogView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );

async function openRowMenu(): Promise<string[]> {
  renderBacklog();
  await screen.findByText("Rewire the telemetry");
  fireEvent.click(screen.getByRole("button", { name: /open menu/i }));
  const menu = await screen.findByRole("menu");
  return within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim() ?? "");
}

const READ = Permission.ITEM_READ;
const UPDATE = Permission.ITEM_UPDATE;
const DELETE = Permission.ITEM_DELETE;

describe("BacklogView — row actions follow the viewer's permissions", () => {
  it("a viewer gets Open and Copy link, and nothing that changes the item", async () => {
    perms.mask = READ;
    const labels = await openRowMenu();

    expect(labels).toEqual(expect.arrayContaining(["Open", "Copy link"]));
    expect(labels).not.toContain("Sprint 1");
    expect(labels.some((l) => /Archive/.test(l))).toBe(false);
    expect(labels).not.toContain("Delete");
  });

  it("an editor also gets Move to sprint and Archive, but not Delete", async () => {
    perms.mask = READ | UPDATE;
    const labels = await openRowMenu();

    expect(labels).toEqual(expect.arrayContaining(["Open", "Sprint 1", "Archive"]));
    expect(labels).not.toContain("Delete");
  });

  it("Delete asks first, then deletes the item and drops the row", async () => {
    perms.mask = READ | UPDATE | DELETE;
    await openRowMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/permanently delete FSC-7/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/work-items\/w1$/),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Rewire the telemetry")).toBeNull());
  });
});
