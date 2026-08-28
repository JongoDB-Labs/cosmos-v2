// @vitest-environment jsdom
//
// COSMOS-186: an item can be assigned to a TEAM directly, without an individual
// assignee. This covers the surface that makes that reachable — the Team control
// in the item's detail sheet — and specifically the "without requiring an
// assignee" half of the acceptance criterion: the item under test has no
// assignee at all, and the save must still carry only `teamId`.
//
// The base-ui Select is stubbed as a native <select> for the same reason the
// sibling status-select / type-select suites do it: a portalled popup cannot be
// driven in jsdom, and the component's own state logic is what matters here.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function itemFixture(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "W1",
    ticketNumber: 1,
    title: "Retire the legacy ingest path",
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
    // Nobody owns this item. That is the point.
    assigneeId: null,
    assignees: [],
    teamId: null,
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

const TEAMS = [
  { id: "team-plat", name: "Platform" },
  { id: "team-apps", name: "Applications" },
];

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

/**
 * A fetch stub that answers the sheet's own on-open loads (comments, activity,
 * label catalogue, watch state) with an empty list, and the field PUT with the
 * saved row. Returning the row to every call breaks the sheet's `comments.map`.
 */
function stubFetch(saved: WorkItem) {
  return vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "PUT"
      ? new Response(JSON.stringify(saved), { status: 200 })
      : new Response("[]", { status: 200 }),
  );
}

/**
 * The Team control — found by its "No team" entry, NOT by a team name. Matching
 * on "Platform" would make the hidden-control test below vacuous: strip the
 * `teams.length > 0` guard and the control renders with only "No team" in it,
 * which a name-based lookup would still report as absent.
 */
function queryTeamSelect(): HTMLSelectElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLSelectElement>("select[data-options]"),
  ).find((s) => s.dataset.options?.includes("No team"));
}

function teamSelect(): HTMLSelectElement {
  const found = queryTeamSelect();
  if (!found) throw new Error("Team select not found");
  return found;
}

describe("assigning a work item to a team", () => {
  beforeEach(() => {
    global.fetch = vi.fn(
      async () => new Response("[]", { status: 200 }),
    ) as unknown as typeof fetch;
  });

  it("offers the project's teams plus an explicit 'No team'", () => {
    render(<CardDetailSheet {...SHEET_PROPS} teams={TEAMS} item={itemFixture()} />);
    expect(Array.from(teamSelect().options).map((o) => o.textContent)).toEqual([
      "No team",
      "Platform",
      "Applications",
    ]);
  });

  it("shows the team an item is already assigned to", () => {
    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        teams={TEAMS}
        item={itemFixture({ teamId: "team-apps" })}
      />,
    );
    expect(teamSelect().value).toBe("team-apps");
  });

  it("saves the team on an item with NO assignee, sending teamId alone", async () => {
    // The acceptance criterion, end to end through the component: an unassigned
    // item is given a team, and the PUT carries the team without inventing an
    // assignee or clearing anything else.
    const fetchMock = stubFetch(itemFixture({ teamId: "team-plat" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CardDetailSheet {...SHEET_PROPS} teams={TEAMS} item={itemFixture()} />);
    fireEvent.change(teamSelect(), { target: { value: "team-plat" } });

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeDefined();
      expect(String(put![0])).toBe(
        "/api/v1/orgs/org/projects/proj/work-items/W1",
      );
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        teamId: "team-plat",
      });
    });
    // And the control reflects the choice immediately, not after a refetch.
    expect(teamSelect().value).toBe("team-plat");
  });

  it("clears the team back to none", async () => {
    const fetchMock = stubFetch(itemFixture());
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
      <CardDetailSheet
        {...SHEET_PROPS}
        teams={TEAMS}
        item={itemFixture({ teamId: "team-plat" })}
      />,
    );
    fireEvent.change(teamSelect(), { target: { value: "__none__" } });

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeDefined();
      // null, not the "__none__" sentinel — that sentinel is a UI detail and
      // must never reach the API, which would reject it as a non-uuid.
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        teamId: null,
      });
    });
  });

  it("renders no Team control at all on a project with no teams", () => {
    // Matching the board's Team filter, which hides rather than offering a
    // dropdown with one dead entry. Every caller that does not pass `teams`
    // (Backlog, Roadmap, Issues) lands here.
    render(<CardDetailSheet {...SHEET_PROPS} item={itemFixture()} />);
    expect(queryTeamSelect()).toBeUndefined();
  });
});
