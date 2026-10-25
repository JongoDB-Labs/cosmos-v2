// @vitest-environment jsdom
//
// COSMOS-211: the shared work-item menu the calendar, roadmap and Gantt now
// offer. Gated like the Kanban and RAID cards (COSMOS-210); every write
// refreshes the items the views read (COSMOS-212).
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn(() => Promise.resolve(null)) }));

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

import { WorkItemMenu, WorkItemMenuAt } from "./work-item-menu";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { Permission } from "@/lib/rbac/permissions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ITEM = {
  id: "w1",
  orgId: "o1",
  projectId: "p1",
  title: "Ship the export",
  highlight: null,
  archivedAt: null,
};
const READ = Permission.ITEM_READ;
const UPDATE = Permission.ITEM_UPDATE;
const DELETE = Permission.ITEM_DELETE;
const ITEM_PATH = "/api/v1/orgs/o1/projects/p1/work-items/w1";

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWrapped(qc = client(), onOpen = vi.fn()) {
  render(
    <QueryClientProvider client={qc}>
      <WorkItemMenu item={ITEM} onOpen={onOpen} ticketLabel="FSC-7">
        <button type="button">Ship the export</button>
      </WorkItemMenu>
    </QueryClientProvider>,
  );
  return { qc, onOpen };
}

async function menuLabels(): Promise<string[]> {
  const menu = await screen.findByRole("menu");
  return within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim() ?? "");
}

describe("WorkItemMenu: gated like the Kanban and RAID cards", () => {
  it("a viewer gets Open and Copy link only", async () => {
    perms.mask = READ;
    renderWrapped();
    fireEvent.contextMenu(screen.getByText("Ship the export"));
    expect(await menuLabels()).toEqual(["Open", "Copy link"]);
  });

  it("an editor also gets Highlight and Archive, but not Delete", async () => {
    perms.mask = READ | UPDATE;
    renderWrapped();
    fireEvent.contextMenu(screen.getByText("Ship the export"));
    const labels = await menuLabels();
    expect(labels).toEqual(expect.arrayContaining(["Open", "Copy link", "Archive"]));
    expect(screen.getByText("Highlight")).toBeTruthy();
    expect(labels).not.toContain("Delete");
  });

  it("the ⋯ button names the item and opens the same menu from the keyboard", async () => {
    perms.mask = READ;
    renderWrapped();
    fireEvent.click(screen.getByRole("button", { name: "Actions for FSC-7" }));
    expect(await menuLabels()).toEqual(["Open", "Copy link"]);
  });

  it("Open opens the item", async () => {
    perms.mask = READ;
    const { onOpen } = renderWrapped();
    fireEvent.contextMenu(screen.getByText("Ship the export"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("w1");
  });

  it("Archive saves archivedAt and refreshes the project's items", async () => {
    perms.mask = READ | UPDATE;
    const qc = client();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderWrapped(qc);
    fireEvent.contextMenu(screen.getByText("Ship the export"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(
        ITEM_PATH,
        expect.objectContaining({ method: "PUT", body: expect.stringContaining('"archivedAt":"') }),
      ),
    );
    // The key every one of the three views reads its items from.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["org", "acme", "work-items", "p1"] }),
    );
  });

  it("Delete asks first, and only Delete in the confirm deletes", async () => {
    perms.mask = READ | UPDATE | DELETE;
    renderWrapped();
    fireEvent.contextMenu(screen.getByText("Ship the export"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain('FSC-7 "Ship the export"');
    expect(jsonFetch).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(ITEM_PATH, { method: "DELETE" }),
    );
  });
});

describe("WorkItemMenuAt: the same menu at a point, for SVG bars", () => {
  function renderAt(onClose = vi.fn(), onOpen = vi.fn()) {
    render(
      <QueryClientProvider client={client()}>
        <WorkItemMenuAt
          item={ITEM}
          at={{ x: 40, y: 60 }}
          onOpen={onOpen}
          ticketLabel="FSC-7"
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    return { onClose, onOpen };
  }

  it("opens at once, gated the same way", async () => {
    perms.mask = READ;
    renderAt();
    expect(await menuLabels()).toEqual(["Open", "Copy link"]);
  });

  it("closes when a row is chosen", async () => {
    perms.mask = READ;
    const { onClose, onOpen } = renderAt();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("w1");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the delete confirm open after the menu closes, and closes after it", async () => {
    perms.mask = READ | DELETE;
    const { onClose } = renderAt();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(jsonFetch).not.toHaveBeenCalled();
  });
});
