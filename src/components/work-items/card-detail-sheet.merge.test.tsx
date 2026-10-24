// @vitest-environment jsdom
//
// COSMOS-207, from a release train engineer: a duplicate is merged into the
// item that survives, from the item drawer, and afterwards says where it went.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen, within } from "@testing-library/react";

vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("@/components/chat/mention-typeahead", () => ({
  useOrgMembers: () => ({ data: [] }),
}));
vi.mock("@/components/mentions/entity-mention-picker", () => ({
  EntityMentionPicker: () => null,
}));
vi.mock("@/components/mentions/hooks", () => ({ useRefResolver: () => new Map() }));
vi.mock("@/components/notes/editor/rich-text-editor", () => ({
  NoteRichTextEditor: () => null,
}));
vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/mentions/mentioned-in", () => ({ MentionedIn: () => null }));
vi.mock("@/components/work-items/links-section", () => ({
  WorkItemLinksSection: () => null,
}));
vi.mock("@/components/roadmap/roadmap-description-field", () => ({
  RoadmapDescriptionField: () => null,
}));
vi.mock("@/components/files/work-item-document-source", () => ({
  WorkItemDocumentSource: () => null,
}));
// Stubbed for the same reason as the source chip above: it is a react-query
// consumer, and this suite renders the sheet without a QueryClientProvider.
vi.mock("@/components/files/work-item-attachments", () => ({
  WorkItemAttachments: () => null,
}));

// base-ui's Select renders a button + portalled popup, which cannot be driven
// in jsdom. Stubbed as a NATIVE select so the test exercises the component's
// real state logic — the same reason this suite already stubs the description
// field as a controlled input. `data-options` makes the Type control findable
// among the sheet's several selects.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    items,
    value,
    onValueChange,
  }: {
    items: Record<string, string>;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <select
      data-options={Object.values(items).join(",")}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {Object.entries(items).map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({
    options,
    value,
    onValueChange,
    "aria-label": label,
  }: {
    options: { value: string; label: string }[];
    value: string | null;
    onValueChange: (v: string | null) => void;
    "aria-label"?: string;
  }) => (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onValueChange(e.target.value || null)}>
      <option value="">-</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/hooks/use-work-item-types", () => ({
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => ({
    types: [
      { id: "wt", key: "software.story", name: "Story" },
      { id: "wt2", key: "software.bug", name: "Bug" },
    ],
  }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
// The workflow's transitions: unknown here, so every status is offered.
vi.mock("@/hooks/use-item-transitions", () => ({ useItemTransitions: () => null }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem } from "@/types/models";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView =
    Element.prototype.scrollIntoView || (() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function itemFixture(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "W1",
    ticketNumber: 1,
    title: "Original title",
    description: "saved description",
    columnKey: "todo",
    priority: "MEDIUM",
    workCategory: "BUSINESS",
    parentId: null,
    children: [],
    storyPoints: null,
    startDate: null,
    dueDate: null,
    intervalId: null,
    assigneeId: null,
    assignees: [],
    workItemTypeId: "wt",
    workItemType: {
      id: "wt",
      key: "software.story",
      name: "Story",
      icon: null,
      color: null,
    },
    customFields: {},
    ...over,
  } as unknown as WorkItem;
}

const SHEET_PROPS = {
  open: true as const,
  onOpenChange: () => {},
  orgId: "org",
  projectId: "proj",
  members: [],
  intervals: [],
  columns: [{ key: "todo", name: "To Do" } as never],
  onUpdate: () => {},
};

const COLUMNS = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
] as never[];

describe("merging a duplicate", () => {
  it("merges into the chosen item and hands both results back", async () => {
    const merged = itemFixture({ id: "W1", columnKey: "cancelled", cancelReason: "MERGED", cancelNote: "Merged into ALPHA-2", mergedIntoId: "W2" });
    const into = itemFixture({ id: "W2", ticketNumber: 2, title: "Keeper" });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ merged, into, moved: {} }), { status: 200 });
      return new Response("[]", { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onUpdate = vi.fn();
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        statusColumns={COLUMNS}
        onUpdate={onUpdate}
        projectItems={[itemFixture(), into, itemFixture({ id: "W3", ticketNumber: 3, cancelReason: "OBE" })]}
        item={itemFixture()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Merge into…" }));
    const dlg = await screen.findByRole("dialog", { name: /Merge #1 into another item/ });
    const pick = within(dlg).getByLabelText("Merge into") as HTMLSelectElement;
    // Only open items are offered: not this one, not a cancelled one.
    expect(Array.from(pick.options).map((o) => o.text)).toEqual(["-", "#2 Keeper"]);
    expect(within(dlg).getByRole("button", { name: "Merge" })).toBeDisabled();
    fireEvent.change(pick, { target: { value: "W2" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(String(post[0])).toMatch(/\/work-items\/W1\/merge$/);
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ intoId: "W2" });
    expect(onUpdate.mock.calls.map(([w]) => w.id)).toEqual(["W2", "W1"]);
  });

  it("says where a merged item went, with a way to open it", () => {
    global.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    const onOpenItem = vi.fn();
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        statusColumns={COLUMNS}
        onOpenItem={onOpenItem}
        item={itemFixture({ columnKey: "cancelled", cancelReason: "MERGED", cancelNote: "Merged into ALPHA-2", mergedIntoId: "W2" })}
      />,
    );
    const banner = screen.getByRole("status", { name: "Cancelled" });
    expect(banner.textContent).toMatch(/Cancelled · Merged/);
    expect(banner.textContent).toMatch(/Merged into ALPHA-2/);
    expect(within(banner).queryByRole("button", { name: /reason/ })).toBeNull();
    fireEvent.click(within(banner).getByRole("button", { name: "Open it" }));
    expect(onOpenItem).toHaveBeenCalledWith("W2");
    expect(screen.queryByRole("button", { name: "Merge into…" })).toBeNull();
  });
});
