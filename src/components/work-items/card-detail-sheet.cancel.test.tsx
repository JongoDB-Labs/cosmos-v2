// @vitest-environment jsdom
//
// COSMOS-206, from a release train engineer: work that's no longer needed is
// marked Cancelled with a reason (Overcome by events, or Other with a note),
// and the drawer says so, rather than the item being deleted or left in Done.
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

const CANCEL_COLUMNS = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
] as never[];

function putBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

function mockPut(reply: Partial<WorkItem>) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return new Response(JSON.stringify(itemFixture(reply)), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("cancelling an item", () => {
  it("cancels as overcome by events and says so in the drawer", async () => {
    const fetchMock = mockPut({ columnKey: "cancelled", cancelReason: "OBE", cancelNote: null });
    const onUpdate = vi.fn();
    const { rerender } = render(
      <CardDetailSheet {...SHEET_PROPS} statusColumns={CANCEL_COLUMNS} onUpdate={onUpdate} item={itemFixture()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark cancelled" }));
    const dlg = await screen.findByRole("dialog", { name: "Cancel this work?" });
    expect(within(dlg).getByRole("radio", { name: /Overcome by events/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(dlg).getByRole("button", { name: "Mark cancelled" }));

    await waitFor(() => expect(putBodies(fetchMock)).toEqual([{ cancelReason: "OBE", cancelNote: null }]));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    rerender(
      <CardDetailSheet
        {...SHEET_PROPS}
        statusColumns={CANCEL_COLUMNS}
        onUpdate={onUpdate}
        item={onUpdate.mock.calls[0][0]}
      />,
    );
    expect(screen.getByRole("status", { name: "Cancelled" }).textContent).toMatch(/Cancelled · Overcome by events \(OBE\)/);
    expect(screen.queryByRole("button", { name: "Mark cancelled" })).toBeNull();
  });

  it("won't cancel as Other without a note, then sends the note", async () => {
    const fetchMock = mockPut({ columnKey: "cancelled", cancelReason: "OTHER", cancelNote: "Customer withdrew" });
    render(<CardDetailSheet {...SHEET_PROPS} statusColumns={CANCEL_COLUMNS} item={itemFixture()} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark cancelled" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("radio", { name: /Other/ }));
    const confirm = within(dlg).getByRole("button", { name: "Mark cancelled" });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dlg).getByLabelText(/Note/), { target: { value: "  Customer withdrew " } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(putBodies(fetchMock)).toEqual([{ cancelReason: "OTHER", cancelNote: "Customer withdrew" }]),
    );
  });

  it("shows the reason and note on a cancelled item, and lets it be edited", () => {
    global.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        statusColumns={CANCEL_COLUMNS}
        item={itemFixture({ columnKey: "cancelled", cancelReason: "OTHER", cancelNote: "Customer withdrew" })}
      />,
    );
    const banner = screen.getByRole("status", { name: "Cancelled" });
    expect(banner.textContent).toMatch(/Cancelled · Other/);
    expect(banner.textContent).toMatch(/Customer withdrew/);
    expect(within(banner).getByRole("button", { name: "Edit reason" })).toBeTruthy();
  });

  it("asks for a reason when an item was dragged to Cancelled without one", () => {
    global.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    render(
      <CardDetailSheet {...SHEET_PROPS} statusColumns={CANCEL_COLUMNS} item={itemFixture({ columnKey: "cancelled" })} />,
    );
    const banner = screen.getByRole("status", { name: "Cancelled" });
    expect(banner.textContent).toMatch(/no reason given/);
    expect(within(banner).getByRole("button", { name: "Add reason" })).toBeTruthy();
  });

  it("reloads the board's statuses when the cancel created the Cancelled column", async () => {
    mockPut({ columnKey: "cancelled", cancelReason: "OBE" });
    const onStatusesChanged = vi.fn();
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        statusColumns={[{ key: "todo", name: "To Do", category: "TODO" }] as never[]}
        onStatusesChanged={onStatusesChanged}
        item={itemFixture()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark cancelled" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Mark cancelled" }));
    await waitFor(() => expect(onStatusesChanged).toHaveBeenCalledTimes(1));
  });
});
