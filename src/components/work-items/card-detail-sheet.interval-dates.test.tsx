// @vitest-environment jsdom
//
// COSMOS-223: picking an interval in the issue sheet fills the planned start
// and end from the interval, only where they are still empty, in the SAME save
// as the interval itself.
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

const SPRINT = {
  id: "i1",
  name: "Sprint 26.4.1",
  startDate: "2026-11-02T00:00:00.000Z",
  endDate: "2026-11-13T00:00:00.000Z",
};

function intervalSelect(): HTMLSelectElement | undefined {
  return Array.from(document.querySelectorAll<HTMLSelectElement>("select[data-options]")).find(
    (s) => s.dataset.options?.includes("Sprint 26.4.1"),
  );
}

function putBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

function mockFetch(status = 200) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      if (status !== 200) return new Response("nope", { status });
      return new Response(JSON.stringify(itemFixture(JSON.parse(init.body as string))), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("CardDetailSheet: an interval fills empty planned dates (COSMOS-223)", () => {
  it("saves the interval and both dates in one request when neither date is set", async () => {
    const fetchMock = mockFetch();
    render(<CardDetailSheet {...SHEET_PROPS} intervals={[SPRINT as never]} item={itemFixture()} />);

    fireEvent.change(intervalSelect()!, { target: { value: "i1" } });

    await waitFor(() =>
      expect(putBodies(fetchMock)).toEqual([
        { intervalId: "i1", startDate: "2026-11-02T00:00:00.000Z", dueDate: "2026-11-13T00:00:00.000Z" },
      ]),
    );
  });

  it("leaves a planned date that is already set alone", async () => {
    const fetchMock = mockFetch();
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        intervals={[SPRINT as never]}
        item={itemFixture({ startDate: "2026-10-30T00:00:00.000Z" })}
      />,
    );

    fireEvent.change(intervalSelect()!, { target: { value: "i1" } });

    await waitFor(() =>
      expect(putBodies(fetchMock)).toEqual([{ intervalId: "i1", dueDate: "2026-11-13T00:00:00.000Z" }]),
    );
  });

  it("puts the dates back as they were if the save fails", async () => {
    const fetchMock = mockFetch(500);
    render(<CardDetailSheet {...SHEET_PROPS} intervals={[SPRINT as never]} item={itemFixture()} />);
    // The picker is a button showing the date (or its placeholder when empty).
    const start = () => document.querySelector('[aria-label="Planned start"]')!.textContent;
    const emptyStart = start();

    fireEvent.change(intervalSelect()!, { target: { value: "i1" } });
    // Optimistic first: the date shows before the save comes back.
    expect(start()).not.toBe(emptyStart);

    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(intervalSelect()!.value).toBe("__none__"));
    expect(start()).toBe(emptyStart);
  });
});
