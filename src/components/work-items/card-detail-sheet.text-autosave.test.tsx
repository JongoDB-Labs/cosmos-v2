// @vitest-environment jsdom
//
// COSMOS-195: "Title and description can be edited and silently lost."
//
// Every metadata field in this sheet auto-saves, but title and description used
// to wait on a "Save changes" button rendered at the BOTTOM of a long scrolling
// panel — below the metadata grid, the labels, the sub-items and the links. On a
// normal viewport the only thing that could tell you an edit was unsaved was off
// screen, so editing a title and closing the panel discarded the change with the
// new text still on display. It happened twice in one session on 2026-09-14.
//
// The fix: both fields commit on blur (and on ⌘/Ctrl+Enter), the button is gone,
// and each field carries its own inline state chip. These lock the three things
// that made the loss silent — no save on blur, no save on close, no indicator
// anywhere near the field.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

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
// Stubbed as a controlled textarea, like the other sheet specs do, so the test
// drives the real description state the way a user typing does. The blur and
// ⌘-Enter handling under test lives on the WRAPPER in the sheet, not in this
// component, so the stub exercises the same code path the real editor does.
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
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

/** Every PUT the sheet fired, in order. */
let puts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  puts = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      puts.push({ url, body });
      return new Response(JSON.stringify({ ...itemFixture(), ...body }), {
        status: 200,
      });
    }
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function itemFixture(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "W1",
    ticketNumber: 194,
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
    tags: [],
    ...over,
  } as unknown as WorkItem;
}

const SHEET_PROPS = {
  onOpenChange: () => {},
  orgId: "org",
  projectId: "proj",
  members: [],
  intervals: [],
  columns: [{ key: "todo", name: "To Do" } as never],
  onUpdate: () => {},
};

describe("CardDetailSheet — title/description never save silently into nothing", () => {
  it("persists a title edit when the field loses focus", async () => {
    render(<CardDetailSheet item={itemFixture()} open {...SHEET_PROPS} />);

    const title = screen.getByLabelText("Title") as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "A title that must survive" } });
    fireEvent.blur(title);

    await waitFor(() =>
      expect(
        puts,
        "blurring an edited title must PUT it — the old panel saved only from a button far below the field",
      ).toEqual([
        { url: expect.stringContaining("/work-items/W1"), body: { title: "A title that must survive" } },
      ]),
    );
    expect(await screen.findByTestId("save-state-title")).toHaveTextContent("Saved");
  });

  it("persists a description edit when focus leaves the field", async () => {
    render(<CardDetailSheet item={itemFixture()} open {...SHEET_PROPS} />);

    const description = screen.getByLabelText("Description") as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "a real description" } });
    fireEvent.blur(description);

    await waitFor(() =>
      expect(puts.map((p) => p.body)).toEqual([{ description: "a real description" }]),
    );
  });

  it("marks the title Unsaved, beside the field, while the edit is uncommitted", () => {
    render(<CardDetailSheet item={itemFixture()} open {...SHEET_PROPS} />);

    expect(screen.queryByTestId("save-state-title")).toBeNull();

    const title = screen.getByLabelText("Title") as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "half-typed" } });

    const chip = screen.getByTestId("save-state-title");
    expect(chip, "an unsaved title must SAY so").toHaveTextContent("Unsaved");
    // "visible without scrolling while the field is focused" — the only way to
    // guarantee that from a unit test is proximity in the tree: the indicator
    // and the field it governs share a parent, rather than sitting a whole
    // scrolling panel apart.
    expect(
      chip.parentElement?.contains(title),
      "the indicator must be rendered next to the field it describes",
    ).toBe(true);
  });

  it("flushes an uncommitted title when the sheet closes without a blur", async () => {
    // Escape-to-close (and board navigation) closes the sheet with the field
    // still focused, so no blur ever fires. This is the exact path that lost
    // the edit twice while COSMOS-194 was being written.
    const { rerender } = render(
      <CardDetailSheet item={itemFixture()} open {...SHEET_PROPS} />,
    );

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "typed then closed" },
    });
    rerender(<CardDetailSheet item={itemFixture()} open={false} {...SHEET_PROPS} />);

    await waitFor(() =>
      expect(
        puts.map((p) => p.body),
        "closing the panel must not throw the edit away",
      ).toEqual([{ title: "typed then closed" }]),
    );
  });

  it("does not PUT when a field is blurred without being changed", async () => {
    render(<CardDetailSheet item={itemFixture()} open {...SHEET_PROPS} />);

    fireEvent.blur(screen.getByLabelText("Title"));
    fireEvent.blur(screen.getByLabelText("Description"));

    await Promise.resolve();
    expect(puts).toEqual([]);
  });
});
