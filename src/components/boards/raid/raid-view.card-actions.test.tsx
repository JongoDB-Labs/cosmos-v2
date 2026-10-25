// @vitest-environment jsdom
//
// COSMOS-210: the RAID card menu offered Categorize, Clear and Highlight to
// everyone, whatever their role, and had no way to open, link or delete the
// item. It now follows the Kanban card: Open and Copy link for anyone who can
// see the card, changes behind ITEM_UPDATE, and Delete (with a confirm) behind
// ITEM_DELETE.
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => <button type="button">New issue</button>,
}));
// The detail sheet loads its own data; what matters here is that Open asks for it.
const { sheetProps } = vi.hoisted(() => ({ sheetProps: vi.fn() }));
vi.mock("@/components/work-items/board-item-detail-sheet", () => ({
  BoardItemDetailSheet: (props: Record<string, unknown>) => {
    sheetProps(props);
    return null;
  },
}));

const ITEMS = [
  {
    id: "w1",
    orgId: "o1",
    projectId: "p1",
    ticketNumber: 7,
    title: "Vendor slips the delivery",
    tags: ["risk"],
    columnKey: "todo",
    priority: "MEDIUM" as const,
    assigneeId: null,
    archivedAt: null,
  },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, opts?: { method?: string }) => {
    if (opts?.method === "DELETE") return Promise.resolve(null);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
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

import { RaidView } from "./raid-view";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { Permission } from "@/lib/rbac/permissions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderRaid = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RaidView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );

async function openCardMenu(how: "button" | "right-click" = "button"): Promise<string[]> {
  renderRaid();
  const title = await screen.findByText("Vendor slips the delivery");
  if (how === "button") fireEvent.click(screen.getByRole("button", { name: /open menu/i }));
  else fireEvent.contextMenu(title);
  const menu = await screen.findByRole("menu");
  return within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim() ?? "");
}

const READ = Permission.ITEM_READ;
const UPDATE = Permission.ITEM_UPDATE;
const DELETE = Permission.ITEM_DELETE;
const WRITES = ["Assumption", "Issue", "Dependency", "Clear", "Archive", "Delete"];

describe("RaidView: card actions follow the viewer's permissions", () => {
  it("a viewer gets Open and Copy link, and nothing that changes the item", async () => {
    perms.mask = READ;
    const labels = await openCardMenu();

    expect(labels).toEqual(["Open", "Copy link"]);
    for (const w of WRITES) expect(labels).not.toContain(w);
  });

  it("an editor can recategorize, clear, highlight and archive, but not delete", async () => {
    perms.mask = READ | UPDATE;
    const labels = await openCardMenu();

    expect(labels).toEqual(
      expect.arrayContaining(["Open", "Risk", "Assumption", "Issue", "Dependency", "Clear", "Copy link", "Archive"]),
    );
    // The highlight palette is there too (its rows are colour names plus None).
    expect(labels.length).toBeGreaterThan(9);
    expect(labels).not.toContain("Delete");
  });

  it("right-clicking the card opens the same gated menu", async () => {
    perms.mask = READ;
    expect(await openCardMenu("right-click")).toEqual(["Open", "Copy link"]);
  });

  it("Open shows the item's detail", async () => {
    perms.mask = READ;
    await openCardMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    await waitFor(() =>
      expect(sheetProps).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "w1" })),
    );
  });

  it("Delete asks first, then deletes the item", async () => {
    perms.mask = READ | UPDATE | DELETE;
    await openCardMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/permanently delete FSC-7/)).toBeTruthy();
    expect(jsonFetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "DELETE" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(
        "/api/v1/orgs/o1/projects/p1/work-items/w1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
