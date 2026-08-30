// @vitest-environment jsdom
//
// COSMOS-168. Reported from the Timeline / Gantt: the status "always defaults to
// backlog" and cannot be changed. Verified in a browser against main — on a
// project where no board defines a workflow, the Status control opens onto an
// empty list and the trigger renders the raw key ("backlog", lowercase, which is
// what base-ui shows when no item matches the value).
//
// Two holes, both landing in the same place:
//   1. the sheet resolved options with `statusColumns ?? columns`, but every
//      board view passes `useProjectStatuses(...)` — an ARRAY, empty while the
//      boards request is in flight and empty again when it fails, so `??` fired
//      on neither and the board's own columns were never consulted;
//   2. when neither source defines a workflow there was nothing left to fall
//      back TO.
//
// A separate file from `card-detail-sheet.status-select.test.tsx`: that suite is
// the record of the earlier board-vs-project fix and is left exactly as it
// shipped, so the mock harness below is deliberately duplicated rather than
// shared.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

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

// base-ui's Select renders a button + portalled popup, which cannot be driven in
// jsdom. Stubbed as a NATIVE select so the test exercises the component's real
// state logic; `data-options` makes each of the sheet's several selects findable.
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
    types: [{ id: "wt", key: "software.story", name: "Story" }],
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

beforeEach(() => {
  global.fetch = vi.fn(
    async () => new Response("[]", { status: 200 }),
  ) as unknown as typeof fetch;
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
    columnKey: "backlog",
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
  columns: [] as never[],
  onUpdate: () => {},
};

/** The Status control — the select offering the workflow column names. */
function statusSelect(): HTMLSelectElement {
  const all = Array.from(
    document.querySelectorAll<HTMLSelectElement>("select[data-options]"),
  );
  const found = all.find((s) => s.dataset.options?.includes("To Do"));
  if (!found) throw new Error("Status select not found");
  return found;
}

describe("Status on the Gantt when the project list is empty (COSMOS-168)", () => {
  it("falls back to the board's columns when the project list is EMPTY, not just absent", () => {
    // What every board view actually passes while its boards request is still
    // in flight: an empty array, which `??` will not fall through.
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        columns={[{ key: "todo", name: "To Do" } as never]}
        statusColumns={[]}
        item={itemFixture()}
      />,
    );
    expect(Array.from(statusSelect().options).map((o) => o.textContent)).toEqual([
      "To Do",
    ]);
  });

  it("still offers a workflow when the board and the project both define none", () => {
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        columns={[]}
        statusColumns={[]}
        item={itemFixture({ columnKey: "backlog" } as never)}
      />,
    );
    const select = statusSelect();
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "backlog",
      "todo",
      "in-progress",
      "review",
      "done",
    ]);
    // ...and the ticket's current status is one of them, so changing it is a
    // pick rather than a blank control that cannot be moved off Backlog.
    expect(select.value).toBe("backlog");
  });
});
