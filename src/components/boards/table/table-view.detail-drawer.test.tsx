// @vitest-environment jsdom
// COSMOS-141/142 — clicking an item (its key affordance) in the TABLE view opens
// a detail sheet for that item. Phase 2 upgrades that sheet from the read-only
// IssueDetailSheet to the shared, fully-editable CardDetailSheet (the same panel
// the Kanban board uses), so description, status, assignee, priority and the
// other item properties are editable from the table too.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

// useOrgQueryKey derives the org namespace from the pathname.
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/COS/boards/b1",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
// The toolbar's create button loads its own data — irrelevant to the sheet.
vi.mock("@/components/boards/shared/create-issue-button", () => ({
  CreateIssueButton: () => null,
}));

// CardDetailSheet pulls in a stack of heavy editor/mention/plugin children that
// need providers we don't render here — stub them to null (they're not what this
// test asserts). Mirrors the mocking the other CardDetailSheet tests use.
vi.mock("@/components/chat/mention-typeahead", () => ({
  useOrgMembers: () => ({ data: [] }),
}));
vi.mock("@/components/mentions/hooks", () => ({ useRefResolver: () => new Map() }));
vi.mock("@/components/notes/editor/rich-text-editor", () => ({ NoteRichTextEditor: () => null }));
vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/mentions/mentioned-in", () => ({ MentionedIn: () => null }));
vi.mock("@/components/work-items/links-section", () => ({ WorkItemLinksSection: () => null }));
vi.mock("@/components/roadmap/roadmap-description-field", () => ({
  RoadmapDescriptionField: () => null,
}));
vi.mock("@/components/files/work-item-document-source", () => ({
  WorkItemDocumentSource: () => null,
}));
vi.mock("@/components/plugins/plugin-slot", () => ({ PluginSlot: () => null }));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));

vi.mock("@/components/providers/permissions-provider", async (importActual) => {
  const actual =
    await importActual<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...actual,
    usePermissions: () => ({
      orgId: "o1",
      orgSlug: "acme",
      role: "ADMIN",
      permissions: 0n,
      can: () => true,
    }),
  };
});

vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { TableView } from "./table-view";
import { jsonFetch } from "@/lib/query/json-fetcher";

const BOARD = {
  id: "b1",
  orgId: "o1",
  projectId: "p1",
  name: "Tasks",
  type: "TABLE",
  config: {},
  sortOrder: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  columns: [
    { id: "c1", boardId: "b1", name: "To Do", key: "todo", color: "#111", wipLimit: null, sortOrder: 0, category: "TODO" },
    { id: "c2", boardId: "b1", name: "In Progress", key: "in_progress", color: "#222", wipLimit: null, sortOrder: 1, category: "IN_PROGRESS" },
  ],
};

const ITEM = {
  id: "w1",
  orgId: "o1",
  projectId: "p1",
  workItemTypeId: "t1",
  title: "Wire up the widget",
  description: "",
  columnKey: "in_progress",
  assigneeId: "u1",
  priority: "HIGH",
  intervalId: null,
  parentId: null,
  ticketNumber: 7,
  storyPoints: 3,
  sortOrder: 0,
  dueDate: null,
  startDate: null,
  actualStart: null,
  completedAt: null,
  workCategory: "BUSINESS",
  tags: [],
  customFields: {},
  createdById: "u1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  workItemType: { id: "t1", key: "TASK", name: "Task", icon: null, color: null },
};

const MEMBERS = [
  {
    id: "m1",
    orgId: "o1",
    userId: "u1",
    role: "MEMBER",
    user: { id: "u1", displayName: "Ada Lovelace", avatarUrl: null, email: "ada@example.com" },
  },
];

function wire() {
  vi.mocked(jsonFetch).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/boards/b1")) return Promise.resolve(BOARD);
    if (url.includes("/work-items")) return Promise.resolve([ITEM]);
    if (url.includes("/members")) return Promise.resolve(MEMBERS);
    if (url.includes("/intervals")) return Promise.resolve([]);
    return Promise.resolve({});
  });
  // CardDetailSheet fetches comments/activity/watch/full-item via global fetch
  // on open. Return shape-appropriate empties so it renders without erroring.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/comments") || url.endsWith("/activity")
        ? []
        : url.endsWith("/watch")
          ? { watching: false }
          : ITEM;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    }),
  );
}

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TableView orgId="o1" projectId="p1" projectKey="COS" boardId="b1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  wire();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TableView — editable item detail sheet (COSMOS-141/142)", () => {
  it("opens the editable detail sheet when the item's key affordance is clicked", async () => {
    renderView();

    // Row loaded — the key affordance carries an explicit open label.
    const opener = await screen.findByRole("button", { name: "Open COS-7" });

    // Sheet is closed until the affordance is clicked: no editable Status yet.
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();

    fireEvent.click(opener);

    // Phase 2: the sheet exposes editable fields beyond the name — the title is
    // an editable input pre-filled with the item's title...
    const titleField = await screen.findByPlaceholderText("Title");
    expect((titleField as HTMLTextAreaElement).value).toBe("Wire up the widget");

    // ...and status / assignee / priority are all editable controls, consistent
    // with the Kanban view's detail panel.
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
    expect(screen.getByLabelText("Assignees")).toBeInTheDocument();
    expect(screen.getByLabelText("Priority")).toBeInTheDocument();
  });
});
