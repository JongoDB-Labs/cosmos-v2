// @vitest-environment jsdom
// COSMOS-166 — "⌘K New Issue (via anywhere)".
//
// Reported from the Timeline/Gantt: hit ⌘K on the Program section and file a
// new issue. Three things had to be true and weren't:
//
//   1. The top action was labelled "Create work item…" and opened a palette-local
//      mini form (title, type, assignee, due date). The board's own "New issue"
//      button — the single affordance COSMOS-40/63 established — opens the full
//      dialog with description, priority, status, labels and custom fields. ⌘K
//      handed you the weaker of the two creates.
//   2. ⌘K fired even while you were typing in a field, stealing the keystroke
//      from the editors that bind it themselves.
//   3. (already true, locked here) the project you're standing on is prefilled.
//
// ASSUMED, and stated on the PR: ⌘K surfaces New issue THROUGH the existing
// command palette as its top action rather than opening the dialog directly,
// and carries the current route's project as context.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- base-ui / cmdk need these in jsdom ---
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

const { push, route } = vi.hoisted(() => ({
  push: vi.fn(),
  // Mutable so each test can stand somewhere different in the app.
  route: { pathname: "/acme" },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => route.pathname,
}));

const { invalidateQueries } = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock("@/lib/query/keys", () => ({
  useOrgQueryKey: (...parts: unknown[]) => ["org", "acme", ...parts],
}));
vi.mock("@/hooks/use-work-item-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-work-item-types")>()),
  useWorkItemTypes: vi.fn(() => ({ types: [{ id: "t1", key: "task", name: "Task" }] })),
}));
vi.mock("@/hooks/use-custom-fields", () => ({ useCustomFields: () => ({ fields: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PROJECTS = [
  { id: "p-fsc", key: "FSC", name: "Falcon Support", sector: "defense" },
  { id: "p-ops", key: "OPS", name: "Operations", sector: null },
];

// One URL-aware stub behind both the palette's project fetch and everything the
// create dialog loads for itself (boards, members, intervals).
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/projects")) return PROJECTS;
    return [];
  }),
}));

import { CommandPalette } from "./command-palette";
import { DrawerProvider } from "@/components/drawers/drawer-provider";

function renderPalette() {
  return render(
    <DrawerProvider>
      {/* A field on the page, so "focus is in a text input" is a real state. */}
      <input aria-label="page field" />
      <CommandPalette orgs={[{ id: "org-1", slug: "acme" }]} />
    </DrawerProvider>,
  );
}

beforeEach(() => {
  route.pathname = "/acme";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("CommandPalette — ⌘K files a new issue from anywhere (COSMOS-166)", () => {
  it("offers New issue as the FIRST action and opens the full create dialog", async () => {
    // An org-level surface with no project in the URL — ⌘K still has to work.
    route.pathname = "/acme/pm-dashboard";
    const user = userEvent.setup();
    renderPalette();

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    const actions = await screen.findAllByRole("option");
    expect(actions[0]).toHaveTextContent("New issue…");

    await user.click(actions[0]);

    // The board's dialog, not the palette's old mini form: these four fields
    // are exactly what the cut-down create never had.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("New issue");
    expect(await screen.findByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("Labels")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();
  });

  it("carries the project you're standing on — the Timeline/Gantt board route", async () => {
    route.pathname = "/acme/projects/FSC/boards/timeline-gantt";
    const user = userEvent.setup();
    renderPalette();

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    // The action names the project before you commit to it.
    const action = await screen.findByText("New issue in FSC…");
    await user.click(action);

    await screen.findByRole("dialog");
    // Project is prefilled to FSC and locked — the context came with you.
    const project = screen.getByDisplayValue("FSC · Falcon Support");
    expect(project).toBeDisabled();
  });

  it("leaves ⌘K alone while you're typing in a field, but still closes itself", async () => {
    const user = userEvent.setup();
    renderPalette();

    const field = screen.getByLabelText("page field");
    await user.click(field);
    fireEvent.keyDown(field, { key: "k", metaKey: true });

    expect(screen.queryByPlaceholderText(/Search everything/i)).toBeNull();

    // From the page itself it opens…
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search everything/i);

    // …and ⌘K in the palette's OWN input (also a text field) closes it again.
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Search everything/i)).toBeNull(),
    );
  });
});
