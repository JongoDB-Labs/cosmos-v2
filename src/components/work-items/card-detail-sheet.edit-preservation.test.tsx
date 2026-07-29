// @vitest-environment jsdom
//
// Reported by users: "every time i try to work on the description of a ticket it
// blanks out / resets / refreshes / and i lose my progress."
//
// The sheet seeds its form from the `item` prop. Every inline control sets its
// own local state and then calls patchField(), which PUTs the one field and
// feeds the server's FULL row back through onUpdate → the board's
// setDetailItem → a NEW `item` object. While the seeding effect depended on
// that object, it re-ran on every inline edit and overwrote `description` with
// the last SAVED value — so typing a description and then touching status,
// assignee or priority silently discarded the typing.
//
// The fix keys the effect on item.id. These lock both halves: a same-id update
// must NOT disturb in-progress edits, and switching to a genuinely different
// item MUST still re-seed (or the sheet would show the previous item's text).
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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
vi.mock("@/components/notes/editor/rich-text-editor", () => ({ NoteRichTextEditor: () => null }));
vi.mock("@/components/chat/markdown-content", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/mentions/mentioned-in", () => ({ MentionedIn: () => null }));
vi.mock("@/components/work-items/links-section", () => ({
  WorkItemLinksSection: () => null,
}));
// Stubbed as a controlled input so the test can drive the real description
// state the same way a user typing does.
vi.mock("@/components/roadmap/roadmap-description-field", () => ({
  RoadmapDescriptionField: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="Description"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("@/components/files/work-item-document-source", () => ({
  WorkItemDocumentSource: () => null,
}));
vi.mock("@/hooks/use-work-item-types", () => ({
  // Fixtures here contain no shadow types, so a passthrough matches the real
  // filter exactly; use-work-item-types.test.ts covers the filtering itself.
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
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem } from "@/types/models";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  global.fetch = vi.fn(
    async () => new Response("[]", { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
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
  members: [],
  intervals: [],
  columns: [{ key: "todo", name: "To Do" } as never],
  onUpdate: () => {},
};

function renderSheet(item: WorkItem) {
  return render(<CardDetailSheet item={item} {...SHEET_PROPS} />);
}

describe("CardDetailSheet — in-progress edits survive an inline save", () => {
  it("keeps typed description when the SAME item comes back from the server", () => {
    const item = itemFixture();
    const { rerender } = renderSheet(item);

    const description = screen.getByLabelText("Description") as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "half-written thought" } });
    expect(description.value).toBe("half-written thought");

    // What patchField does: a PUT for ONE field returns the whole row, and the
    // board hands that new object straight back down. Same id, new reference —
    // and crucially the server's description is still the OLD saved text,
    // because the user has not saved their typing yet.
    rerender(<CardDetailSheet item={itemFixture({ priority: "HIGH" })} {...SHEET_PROPS} />);

    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
      "an inline field save must not overwrite what the user is typing",
    ).toBe("half-written thought");
  });

  it("still re-seeds when a DIFFERENT item is opened", () => {
    const { rerender } = renderSheet(itemFixture());

    const description = screen.getByLabelText("Description") as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "draft for W1" } });

    rerender(
      <CardDetailSheet
        item={itemFixture({ id: "W2", description: "W2 saved description" })}
        {...SHEET_PROPS}
      />,
    );

    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
      "switching items must not carry the previous item's draft over",
    ).toBe("W2 saved description");
  });
});
