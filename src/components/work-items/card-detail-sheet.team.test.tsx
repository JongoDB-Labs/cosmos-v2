// @vitest-environment jsdom
//
// COSMOS-204: the drawer's Team picker sets which team owns the work,
// separately from its assignees, and behaves like its sibling fields: it
// moves when clicked, saves `teamId`, and moves back if the save fails.
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

/** The Team control: the only select offering the team names. */
function teamSelect(): HTMLSelectElement | undefined {
  return Array.from(document.querySelectorAll<HTMLSelectElement>("select[data-options]")).find(
    (s) => s.dataset.options?.includes("Customer Success"),
  );
}

const TEAMS = [
  { id: "team-cs", name: "Customer Success" },
  { id: "team-pl", name: "Platform" },
];

function putBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("the Team field", () => {
  it("saves the picked team and shows it", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify(itemFixture({ teamId: "team-cs" })), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CardDetailSheet {...SHEET_PROPS} teams={TEAMS} item={itemFixture()} />);
    expect(teamSelect()!.value).toBe("__none__");

    fireEvent.change(teamSelect()!, { target: { value: "team-cs" } });

    await waitFor(() => expect(putBodies(fetchMock)).toEqual([{ teamId: "team-cs" }]));
    expect(teamSelect()!.value).toBe("team-cs");
  });

  it("clears the team with None", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify(itemFixture({ teamId: null })), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
      <CardDetailSheet {...SHEET_PROPS} teams={TEAMS} item={itemFixture({ teamId: "team-pl" })} />,
    );
    expect(teamSelect()!.value).toBe("team-pl");

    fireEvent.change(teamSelect()!, { target: { value: "__none__" } });

    await waitFor(() => expect(putBodies(fetchMock)).toEqual([{ teamId: null }]));
  });

  it("puts the picker BACK when the save fails", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("nope", { status: 500 });
      return new Response("[]", { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CardDetailSheet {...SHEET_PROPS} teams={TEAMS} item={itemFixture()} />);
    fireEvent.change(teamSelect()!, { target: { value: "team-cs" } });

    // Optimistic first, so wait for the rejected PUT before asserting the revert.
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(teamSelect()!.value).toBe("__none__"));
  });

  it("is hidden in a project with no teams", () => {
    global.fetch = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    render(<CardDetailSheet {...SHEET_PROPS} item={itemFixture()} />);
    expect(teamSelect()).toBeUndefined();
  });
});
