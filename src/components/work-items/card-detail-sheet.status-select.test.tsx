// @vitest-environment jsdom
//
// Reported: on Timeline / Gantt, clicking a ticket's Status dropdown shows no
// options to pick.
//
// NOT the Gantt pointer-capture bug fixed in #416 — the Type control in the SAME
// sheet opens fine, which is what ruled that out. The sheet sourced Status from
// the CURRENT board's columns, and board creation seeds none, so a Timeline,
// Roadmap or Calendar board owns zero columns and the menu had nothing in it.
// `columnKey` is a PROJECT-level value; that is the same modelling error the
// Status FILTER had in #670, and this is the surface that fix did not reach.
//
// The base-ui Select is stubbed as a native <select> for the same reason the
// sibling type-select suite does it: a portalled popup cannot be driven in jsdom,
// and the component's own state logic is what matters here.
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


/** The Status control — the select offering the workflow column names. */
function statusSelect(): HTMLSelectElement {
  const all = Array.from(
    document.querySelectorAll<HTMLSelectElement>("select[data-options]")
  );
  const found = all.find((s) => s.dataset.options?.includes("To Do"));
  if (!found) throw new Error("Status select not found");
  return found;
}

describe("the Status dropdown on a board that owns no columns", () => {
  const PROJECT_STATUSES = [
    { key: "todo", name: "To Do" },
    { key: "in-progress", name: "In Progress" },
    { key: "done", name: "Done" },
  ];

  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
  });

  it("offers the project's statuses even when the board passes none", () => {
    // A Timeline/Gantt board: columns === [] is the real shape, not a contrivance.
    render(
      <CardDetailSheet {...SHEET_PROPS} columns={[]} statusColumns={PROJECT_STATUSES} item={itemFixture()} />
    );

    const select = statusSelect();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "To Do",
      "In Progress",
      "Done",
    ]);
  });

  it("still renders the current status as selected, not blank", () => {
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        columns={[]}
        statusColumns={PROJECT_STATUSES}
        item={itemFixture({ columnKey: "in-progress" } as never)}
      />
    );
    expect(statusSelect().value).toBe("in-progress");
  });

  it("falls back to the board's own columns when no project statuses are passed", () => {
    // Kanban owns real columns and need not pass the prop; it must still work.
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        columns={[{ key: "todo", name: "To Do" } as never]}
        item={itemFixture()}
      />
    );
    expect(Array.from(statusSelect().options).map((o) => o.textContent)).toEqual(["To Do"]);
  });
});
