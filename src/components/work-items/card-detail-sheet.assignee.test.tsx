// @vitest-environment jsdom
//
// COSMOS-192: a ticket Cosmo had just assigned opened on "Unassigned".
//
// The row's `assigneeId` was set and correct the whole time — the sheet seeds its
// Assignees control from the multi-assign SET with
// `item.assignees?.map(...) ?? [item.assigneeId]`, and `??` only fires on
// null/undefined. The API always sends the array, so an item written with the
// primary scalar but NO `WorkItemAssignee` rows (every ticket the AI executors
// assigned before this fix, and any row predating multi-assign) seeded `[]` and
// showed nobody. The fallback has to key off EMPTINESS, not nullishness.
//
// SearchableMultiSelect is stubbed as a plain list of the selected labels: it is
// a base-ui Combobox with a portalled popup, which cannot be driven in jsdom, and
// what regressed is which ids this component seeds — not the dropdown.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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
vi.mock("@/components/ui/searchable-multi-select", () => ({
  SearchableMultiSelect: ({
    value,
    options,
    placeholder,
  }: {
    value: string[];
    options: { value: string; label: string }[];
    placeholder?: string;
  }) => (
    <div data-testid="assignees">
      {value.length === 0
        ? placeholder
        : value.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ")}
    </div>
  ),
}));
vi.mock("@/hooks/use-work-item-types", () => ({
  selectableTypes: <T,>(types: T[]) => types,
  useWorkItemTypes: () => ({ types: [{ id: "wt", key: "software.story", name: "Story" }] }),
}));
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { OrgMember, WorkItem } from "@/types/models";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RYAN = "4e62cb3e-fc39-4d1c-a899-46f98d58e19a";
const PARTH = "edc3c3c3-aa58-4f11-a1fc-338e90a6bbf0";

const MEMBERS = [
  { userId: RYAN, user: { id: RYAN, displayName: "Ryan Beatty", email: "ryan@acme.test" } },
  { userId: PARTH, user: { id: PARTH, displayName: "parth.bulusu", email: "parth@acme.test" } },
] as unknown as OrgMember[];

function itemFixture(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "W1",
    ticketNumber: 1,
    title: "Ticket",
    description: "",
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
    workItemType: { id: "wt", key: "software.story", name: "Story", icon: null, color: null },
    customFields: {},
    ...over,
  } as unknown as WorkItem;
}

const SHEET_PROPS = {
  open: true as const,
  onOpenChange: () => {},
  orgId: "org",
  projectId: "proj",
  members: MEMBERS,
  intervals: [],
  columns: [{ key: "todo", name: "To Do" } as never],
  onUpdate: () => {},
};

describe("the Assignees field on a ticket assigned by id alone", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
  });

  it("names the assignee when only the primary id was written (no set rows)", () => {
    // Exactly the shape the API returns for a ticket Cosmo assigned before the
    // executors learned to write the set: scalar set, `assignees` empty.
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        item={itemFixture({ assigneeId: RYAN, assignees: [] } as never)}
      />,
    );
    expect(screen.getByTestId("assignees")).toHaveTextContent("Ryan Beatty");
  });

  it("resolves a username-style display name the same way", () => {
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        item={itemFixture({ assigneeId: PARTH, assignees: [] } as never)}
      />,
    );
    expect(screen.getByTestId("assignees")).toHaveTextContent("parth.bulusu");
  });

  it("still prefers the set when the ticket has one (manual multi-assign)", () => {
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        item={
          itemFixture({
            assigneeId: RYAN,
            assignees: [{ userId: RYAN }, { userId: PARTH }],
          } as never)
        }
      />,
    );
    expect(screen.getByTestId("assignees")).toHaveTextContent("Ryan Beatty, parth.bulusu");
  });

  it("an unassigned ticket still reads as unassigned", () => {
    render(<CardDetailSheet {...SHEET_PROPS} item={itemFixture()} />);
    expect(screen.getByTestId("assignees")).toHaveTextContent("Unassigned");
  });
});
