// @vitest-environment jsdom
// Task 5 — the Roles & Access page renders three sections (base org roles,
// built-in work roles, custom work roles), badges + hides edit/delete on
// built-ins, and clones any role into the create editor. A 409 on save from a
// name clash surfaces inline at the name field.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui needs these in jsdom (see docs: testing-base-ui-in-jsdom) ---
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

vi.mock("next/navigation", () => ({ usePathname: () => "/defcon-new/settings/roles" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
// Keep the real FetchError (RoleEditor checks `err instanceof FetchError` to
// route a 409 to the name field) and stub only the network call.
vi.mock("@/lib/query/json-fetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { RolesManager } from "./roles-manager";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";

const NAME_CLASH = "a role with this name already exists";

const ROLES = [
  {
    id: "r-analyst",
    orgId: "o1",
    key: "builtin.analyst",
    name: "Analyst",
    description: "Read-only analyst access",
    grants: ["PROJECT_READ", "ITEM_READ"],
    policies: [],
    isBuiltIn: true,
    memberCount: 0,
  },
  {
    id: "r-custom",
    orgId: "o1",
    key: "my_role",
    name: "My Role",
    description: "A custom role",
    grants: ["ITEM_READ"],
    policies: [],
    isBuiltIn: false,
    memberCount: 1,
  },
];

function mockFetch(
  postImpl?: (url: string, init?: RequestInit) => Promise<unknown>,
  rolesList: unknown[] = ROLES,
) {
  vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return postImpl ? postImpl(url, init) : Promise.resolve({});
    }
    if (String(url).endsWith("/work-roles")) return Promise.resolve(rolesList);
    if (String(url).includes("/members")) return Promise.resolve({ orgMemberIds: [] });
    return Promise.resolve([]);
  }) as never);
}

function renderManager() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RolesManager orgId="o1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => mockFetch());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RolesManager — base + built-in + custom sections", () => {
  it("renders three sections; the built-in row is badged and has no edit/delete; the custom row keeps them", async () => {
    renderManager();
    await screen.findByRole("button", { name: "Clone Analyst" });

    expect(screen.getByRole("heading", { name: "Base org roles" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Built-in roles" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Custom roles" })).toBeInTheDocument();

    // Built-in badge on the built-in row (distinct from its "builtin.analyst" key badge).
    expect(screen.getByText("Built-in")).toBeInTheDocument();

    // Built-in row: no edit/delete.
    expect(screen.queryByRole("button", { name: "Edit Analyst" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Analyst" })).toBeNull();

    // Custom row: edit/delete present.
    expect(screen.getByRole("button", { name: "Edit My Role" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete My Role" })).toBeInTheDocument();
  });

  it("shows six base-org-role cards and reveals a permission breakdown when one is expanded", async () => {
    const user = userEvent.setup();
    renderManager();
    await screen.findByRole("button", { name: "Clone Analyst" });

    for (const label of ["Owner", "Admin", "Billing admin", "Member", "Viewer", "Guest"]) {
      expect(screen.getByRole("button", { name: `Clone ${label}` })).toBeInTheDocument();
    }

    // Breakdown is collapsed until expanded.
    expect(screen.queryByText(/\d+ of \d+ permissions/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand Admin" }));
    expect(await screen.findByText(/\d+ of \d+ permissions/)).toBeInTheDocument();
  });

  it("clones the built-in into the editor prefilled with a copy name and the source grants", async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(await screen.findByRole("button", { name: "Clone Analyst" }));

    await screen.findByRole("dialog");
    expect(screen.getByLabelText("Name")).toHaveValue("Copy of Analyst");
    expect(
      document.querySelector('input[type="checkbox"][value="PROJECT_READ"]'),
    ).toBeChecked();
  });

  it("dedupes the prefilled name and key when a prior clone already took them", async () => {
    mockFetch(undefined, [
      ...ROLES,
      {
        id: "r-copy",
        orgId: "o1",
        key: "copy_of_analyst",
        name: "Copy of Analyst",
        description: "Read-only analyst access",
        grants: ["PROJECT_READ", "ITEM_READ"],
        policies: [],
        isBuiltIn: false,
        memberCount: 0,
      },
    ]);
    const user = userEvent.setup();
    renderManager();
    await user.click(await screen.findByRole("button", { name: "Clone Analyst" }));

    await screen.findByRole("dialog");
    expect(screen.getByLabelText("Name")).toHaveValue("Copy of Analyst 2");
    expect(screen.getByLabelText("Key")).not.toHaveValue("copy_of_analyst");
  });

  it("surfaces the server's 409 message inline when saving a clone whose name is taken", async () => {
    mockFetch(() => Promise.reject(new FetchError(409, { error: NAME_CLASH }, NAME_CLASH)));
    const user = userEvent.setup();
    renderManager();
    await user.click(await screen.findByRole("button", { name: "Clone Analyst" }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Save role" }));
    expect(await screen.findByText(NAME_CLASH)).toBeInTheDocument();
  });
});
