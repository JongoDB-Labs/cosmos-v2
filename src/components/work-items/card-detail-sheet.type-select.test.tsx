// @vitest-environment jsdom
//
// Reported: changing the Type in the side drawer updates the type shown beside
// the ticket number, but the dropdown the user just clicked keeps showing the
// OLD type.
//
// `handleFieldChange` opens with an optimistic switch — "Update local state
// immediately for responsive UI" — covering priority, workCategory, assigneeId,
// intervalId, columnKey, storyPoints and parentId. workItemTypeId was missing
// from it, so nothing moved the state that drives the Type control. The header
// re-renders from the refreshed `item` prop and does change, which is why the
// two disagreed.
//
// The seeding effect cannot paper over this: it is keyed on `item.id` on
// purpose (depending on `item` re-seeds the form mid-typing and discards
// drafts — see card-detail-sheet.edit-preservation.test.tsx), so a same-item
// save never re-seeds.
//
// The workItemTypeId case that DID exist sat in the error/revert switch and set
// the NEW value there, where every sibling reverts to item.<field> — so a failed
// save left the dropdown showing the value that had just failed to save.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

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

/** The Type control — the only select offering the work-item type names. */
function typeSelect(): HTMLSelectElement {
  const all = Array.from(
    document.querySelectorAll<HTMLSelectElement>("select[data-options]")
  );
  const found = all.find((s) => s.dataset.options?.includes("Story"));
  if (!found) throw new Error("Type select not found");
  return found;
}

describe("changing the work-item Type", () => {
  it("updates the dropdown the user clicked, not only the header", async () => {
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify(itemFixture({ workItemTypeId: "wt2" })),
          { status: 200 }
        );
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    render(<CardDetailSheet {...SHEET_PROPS} item={itemFixture()} />);

    const select = typeSelect();
    expect(select.value).toBe("wt");

    fireEvent.change(select, { target: { value: "wt2" } });

    // The control must show Bug immediately. Before the fix it stayed on Story
    // while the header beside the ticket number changed to Bug.
    await waitFor(() => expect(typeSelect().value).toBe("wt2"));
  });

  it("sends the new type to the server", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify(itemFixture({ workItemTypeId: "wt2" })),
          { status: 200 }
        );
      }
      return new Response("[]", { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CardDetailSheet {...SHEET_PROPS} item={itemFixture()} />);
    fireEvent.change(typeSelect(), { target: { value: "wt2" } });

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(put).toBeDefined();
      expect(
        JSON.parse((put![1] as RequestInit).body as string)
      ).toEqual({ workItemTypeId: "wt2" });
    });
  });

  it("puts the dropdown BACK when the save fails", async () => {
    // The revert case used to set the NEW value here, leaving the control
    // showing a type the server had just rejected.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("nope", { status: 500 });
      return new Response("[]", { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CardDetailSheet {...SHEET_PROPS} item={itemFixture()} />);
    fireEvent.change(typeSelect(), { target: { value: "wt2" } });

    // It briefly SHOWS wt2 now (optimistic), so asserting "wt" straight away
    // would pass before the failure had even been handled — a vacuous green.
    // Wait for the rejected PUT first, then assert the revert.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
        )
      ).toBe(true)
    );
    await waitFor(() => expect(typeSelect().value).toBe("wt"));
  });
});
