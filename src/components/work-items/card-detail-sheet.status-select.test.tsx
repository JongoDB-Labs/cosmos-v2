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
import { render, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

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
  // Options come from the SelectItem children, as in the real component; the
  // `items` map is only its label lookup.
  Select: ({
    items,
    value,
    onValueChange,
    children,
  }: {
    items: Record<string, string>;
    value: string;
    onValueChange: (v: string) => void;
    children?: React.ReactNode;
  }) => (
    <select
      data-options={Object.values(items).join(",")}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
    <option value={value}>{children}</option>
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
// The workflow's transitions: unknown (null) unless a test sets them.
const transitions = vi.hoisted(() => ({ value: null as null | Map<string, unknown> }));
vi.mock("@/hooks/use-item-transitions", () => ({ useItemTransitions: () => transitions.value }));
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
  transitions.value = null;
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

describe("the Status dropdown under a workflow", () => {
  const STATUSES = [
    { key: "todo", name: "To Do" },
    { key: "doing", name: "Doing" },
    { key: "done", name: "Done" },
    { key: "cancelled", name: "Cancelled" },
  ];
  const reachable = (entries: [string, boolean][]) =>
    new Map(
      entries.map(([to, needsInput]) => [
        to,
        {
          id: to === "done" ? "resolve" : `open:${to}`,
          name: to === "done" ? "Resolve" : to,
          to,
          toCategory: "TODO",
          input: needsInput ? [{ field: { system: "resolution" }, required: true }] : [],
        },
      ]),
    );

  it("offers only the statuses this person can move it to, and marks the ones that ask for details", () => {
    transitions.value = reachable([["doing", false], ["done", true]]);
    global.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    render(<CardDetailSheet {...SHEET_PROPS} statusColumns={STATUSES} item={itemFixture()} />);
    expect(Array.from(statusSelect().options).map((o) => o.textContent)).toEqual(["To Do", "Doing", "Done…"]);
  });

  it("asks for what the transition needs and saves the move with it", async () => {
    transitions.value = reachable([["doing", false], ["done", true]]);
    const refusal = {
      error: "Resolve needs Resolution.",
      code: "transition_input_required",
      transition: { id: "resolve", name: "Resolve", to: "done" },
      fields: [{ field: { system: "resolution" }, required: true, options: [{ value: "Fixed", label: "Fixed" }] }],
    };
    const puts: unknown[] = [];
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return new Response("[]", { status: 200 });
      const body = JSON.parse(init.body as string);
      puts.push(body);
      return body.transition
        ? new Response(JSON.stringify(itemFixture({ columnKey: "done" })), { status: 200 })
        : new Response(JSON.stringify(refusal), { status: 422 });
    }) as unknown as typeof fetch;
    const onUpdate = vi.fn();
    render(<CardDetailSheet {...SHEET_PROPS} onUpdate={onUpdate} statusColumns={STATUSES} item={itemFixture()} />);

    fireEvent.change(statusSelect(), { target: { value: "done" } });
    const dlg = await screen.findByRole("dialog", { name: "Resolve" });
    const resolution = within(dlg).getByRole("combobox");
    fireEvent.change(resolution, { target: { value: "Fixed" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(puts).toEqual([
      { columnKey: "done" },
      { columnKey: "done", transition: { id: "resolve", input: { "system:resolution": "Fixed" } } },
    ]);
  });

  it("never saves an emptied status (the select resets its value when the options change)", async () => {
    const puts: unknown[] = [];
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") puts.push(JSON.parse(init.body as string));
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    render(<CardDetailSheet {...SHEET_PROPS} statusColumns={STATUSES} item={itemFixture()} />);
    const select = statusSelect();
    const empty = document.createElement("option");
    empty.value = "";
    select.appendChild(empty);
    fireEvent.change(select, { target: { value: "" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(puts).toEqual([]);
  });

  it("puts the status back, without an error, when the person backs out", async () => {
    transitions.value = reachable([["done", true]]);
    const refusal = {
      error: "Resolve needs Resolution.",
      code: "transition_input_required",
      transition: { id: "resolve", name: "Resolve", to: "done" },
      fields: [{ field: { system: "resolution" }, required: true }],
    };
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? new Response(JSON.stringify(refusal), { status: 422 }) : new Response("[]", { status: 200 }),
    ) as unknown as typeof fetch;
    const { notifyError } = await import("@/lib/errors/notify");
    render(<CardDetailSheet {...SHEET_PROPS} statusColumns={STATUSES} item={itemFixture()} />);

    fireEvent.change(statusSelect(), { target: { value: "done" } });
    const dlg = await screen.findByRole("dialog", { name: "Resolve" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(statusSelect().value).toBe("todo"));
    expect(notifyError).not.toHaveBeenCalled();
  });
});
