// @vitest-environment jsdom
//
// The ⌘K palette offered Chat to every role, though every chat route needs
// CHAT_USE, so a viewer picked it and landed on the drawer's no-access state.
// It now asks the topbar's own gate (topbar-nav.ts), through `can()`, which
// follows the keys the server sends: a work role can grant CHAT_USE to a
// viewer, and then Chat is offered.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const nav = vi.hoisted(() => ({ path: "/acme", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  usePathname: () => nav.path,
}));

// The create dialog needs a query client; these specs only look at the rows.
vi.mock("@/components/work-items/create-work-item-dialog", () => ({ CreateWorkItemDialog: () => null }));

import { CommandPalette } from "./command-palette";
import { DrawerProvider } from "@/components/drawers/drawer-provider";
import { PermissionsProvider } from "@/components/providers/permissions-provider";
import { RolePermissions, permissionNames } from "@/lib/rbac/permissions";
import { setNewWorkItemContext } from "@/lib/boards/new-work-item-context";

function renderPalette(role: keyof typeof RolePermissions, extra: string[] = []) {
  render(
    <PermissionsProvider
      orgs={[{ id: "org-1", slug: "acme", role, permissions: [...permissionNames(RolePermissions[role]), ...extra] }]}
    >
      <DrawerProvider>
        <CommandPalette orgs={[{ id: "org-1", slug: "acme" }]} />
      </DrawerProvider>
    </PermissionsProvider>,
  );
  fireEvent.keyDown(document, { key: "k", metaKey: true });
}

async function openPalette(role: keyof typeof RolePermissions, extra: string[] = []) {
  renderPalette(role, extra);
  // Positive control: the "Go to" list rendered (Work Items needs no permission here).
  await screen.findByText("Work Items");
}

function type(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/Search everything/), { target: { value: text } });
}

afterEach(() => {
  cleanup();
  nav.path = "/acme";
  nav.push.mockClear();
  vi.unstubAllGlobals();
  setNewWorkItemContext(null);
});

describe("CommandPalette offers only what the person may use", () => {
  it("does not offer Chat to a viewer", async () => {
    await openPalette("VIEWER");
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.queryByText("Chat")).toBeNull();
  });

  it("offers Chat to a viewer whose work role grants CHAT_USE", async () => {
    await openPalette("VIEWER", ["CHAT_USE"]);
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("offers Chat to a member", async () => {
    await openPalette("MEMBER");
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("hides Notes and Meetings from a guest, as the topbar does", async () => {
    await openPalette("GUEST");
    expect(screen.queryByText("Notes")).toBeNull();
    expect(screen.queryByText("Meetings")).toBeNull();
    expect(screen.queryByText("Chat")).toBeNull();
  });
});

describe("CommandPalette reaches every page the person may open", () => {
  it("finds a Settings page by name without \">\"", async () => {
    await openPalette("MEMBER");
    type("api keys");
    fireEvent.click(await screen.findByText("Settings › API Keys"));
    expect(nav.push).toHaveBeenCalledWith("/acme/settings/api-keys");
  });

  it("matches each typed word anywhere in the label", async () => {
    await openPalette("MEMBER");
    type(">settings api");
    expect(await screen.findByText("Settings › API Keys")).toBeInTheDocument();
  });

  it("does not offer Finance to a member", async () => {
    await openPalette("MEMBER");
    // Wait for a row that does match, so the list has certainly rendered.
    type(">fe");
    await screen.findByText("Feedback");
    type(">finance");
    expect(await screen.findByText(/No actions match/)).toBeInTheDocument();
    expect(screen.queryByText(/Finance/)).toBeNull();
  });

  it("offers nothing to jump to off an org route", async () => {
    nav.path = "/admin";
    renderPalette("OWNER");
    // No org here, so no "Go to" list: wait for an action row instead.
    await screen.findByText("Open Assistant");
    type("api keys");
    await screen.findByText("No results found.");
    expect(screen.queryByText("Settings › API Keys")).toBeNull();
  });

  it("finds a page by several words in the Pages group too", async () => {
    await openPalette("MEMBER");
    type("settings api");
    const pages = (await screen.findByText("Pages")).closest("[cmdk-group]") as HTMLElement;
    expect(within(pages).getByText("Settings › API Keys")).toBeInTheDocument();
  });

  it("puts at most five pages above the results, and Enter opens the top one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [{ id: "p1", type: "project", name: "Settings revamp", url: "/acme/projects/SR" }],
      })),
    );
    await openPalette("OWNER");
    type("settings");
    // Wait for the search result, so Enter is pressed with both groups shown.
    await screen.findByText("Settings revamp");
    const pages = screen.getByText("Pages").closest("[cmdk-group]") as HTMLElement;
    expect(within(pages).getAllByRole("option")).toHaveLength(5);
    // Pages sit above the search results.
    const result = screen.getByText("Settings revamp");
    expect(pages.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText(/Search everything/), { key: "Enter" });
    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1));
    expect(nav.push).toHaveBeenCalledWith("/acme/settings");
  });
});

describe("CommandPalette offers only the actions the person may use", () => {
  it("hides the create actions from a viewer", async () => {
    await openPalette("VIEWER");
    expect(screen.getByText("Open Assistant")).toBeInTheDocument();
    expect(screen.queryByText("New project…")).toBeNull();
    expect(screen.queryByText(/Create work item/)).toBeNull();
  });

  it("leaves no empty Actions heading when the only match is hidden", async () => {
    await openPalette("VIEWER");
    type(">new project");
    expect(await screen.findByText(/No actions match/)).toBeInTheDocument();
    expect(screen.queryByText("Actions")).toBeNull();
  });

  it("hides Go to project from a guest", async () => {
    await openPalette("GUEST");
    expect(screen.getByText("Open Assistant")).toBeInTheDocument();
    expect(screen.queryByText("Go to project…")).toBeNull();
  });

  it("offers Create work item but not New project to a member", async () => {
    await openPalette("MEMBER");
    expect(screen.getByText("Create work item…")).toBeInTheDocument();
    expect(screen.queryByText("New project…")).toBeNull();
  });

  it("offers New project to an admin", async () => {
    await openPalette("ADMIN");
    expect(screen.getByText("New project…")).toBeInTheDocument();
  });

  const SCOPE = { scopeLabel: "FSC timeline", orgId: "org-1", projectId: "p1", projectKey: "FSC" };

  it("hides New work item in <board> from a viewer", async () => {
    setNewWorkItemContext(SCOPE);
    await openPalette("VIEWER");
    expect(screen.getByText("Open Assistant")).toBeInTheDocument();
    expect(screen.queryByText("New work item in FSC timeline…")).toBeNull();
  });

  it("offers New work item in <board> to a member", async () => {
    setNewWorkItemContext(SCOPE);
    await openPalette("MEMBER");
    expect(await screen.findByText("New work item in FSC timeline…")).toBeInTheDocument();
  });

  it("hides New board from a guest off a project page", async () => {
    await openPalette("GUEST");
    expect(screen.getByText("Open Assistant")).toBeInTheDocument();
    expect(screen.queryByText("New board")).toBeNull();
  });

  it("offers New board to a member off a project page", async () => {
    await openPalette("MEMBER");
    expect(screen.getByText("New board")).toBeInTheDocument();
  });

  it("offers New board to a guest on a project page (a project lead may add boards)", async () => {
    nav.path = "/acme/projects/FSC";
    await openPalette("GUEST");
    expect(screen.getByText("New board")).toBeInTheDocument();
  });
});
