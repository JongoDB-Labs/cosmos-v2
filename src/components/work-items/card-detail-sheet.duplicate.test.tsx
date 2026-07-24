// @vitest-environment jsdom
// COSMOS-56: the Duplicate action must be safe against rapid/repeated clicks.
// Reported symptom (feedback c7b77295): clicking Duplicate more than once left
// behavior inconsistent — only the first invocation prompted to copy sub-items,
// and overlapping clicks could kick off more than one duplicate. The action is
// now idempotent while a duplication is in flight, and the sub-item copy prompt
// appears consistently for every duplicate (including of a freshly-made copy).
import { useState } from "react";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

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
vi.mock("@/hooks/use-custom-fields", () => ({
  useCustomFields: () => ({ fields: [] }),
  fieldAppliesToType: () => false,
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import type { WorkItem, WorkItemRef } from "@/types/models";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture =
    Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture =
    Element.prototype.releasePointerCapture || (() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const childRef = (id: string, ticketNumber: number): WorkItemRef =>
  ({ id, title: `Child ${id}`, ticketNumber, workItemTypeId: "wt", columnKey: "todo" } as WorkItemRef);

function makeItem(id: string, ticketNumber: number, children: WorkItemRef[] = []): WorkItem {
  return {
    id,
    ticketNumber,
    title: `Item ${id}`,
    description: "",
    columnKey: "todo",
    priority: "MEDIUM",
    workCategory: "BUSINESS",
    parentId: null,
    children,
    storyPoints: null,
    startDate: null,
    dueDate: null,
    intervalId: null,
    assigneeId: null,
    assignees: [],
    workItemTypeId: "wt",
    workItemType: { id: "wt", key: "software.story", name: "Story", icon: null, color: null },
    customFields: {},
  } as unknown as WorkItem;
}

const baseProps = {
  open: true as const,
  onOpenChange: () => {},
  orgId: "o1",
  projectId: "pr1",
  members: [] as never[],
  intervals: [] as never[],
  columns: [{ key: "todo", name: "To Do" } as never],
  onUpdate: () => {},
};

describe("CardDetailSheet — duplicate is safe against repeated clicks (COSMOS-56)", () => {
  it("dedupes overlapping duplicate operations to a single POST", async () => {
    const posts: string[] = [];
    let releasePost: () => void = () => {};
    global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.includes("/duplicate")) {
        posts.push(u);
        // Hold the first duplicate in flight so a second click can race it.
        return new Promise<Response>((resolve) => {
          releasePost = () =>
            resolve(new Response(JSON.stringify(makeItem("copy", 2)), { status: 201 }));
        });
      }
      return Promise.resolve(new Response("[]", { status: 200 }));
    }) as unknown as typeof fetch;

    const { rerender } = render(
      <CardDetailSheet {...baseProps} item={makeItem("A", 1)} onDuplicate={() => {}} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^duplicate$/i }));
    await waitFor(() => expect(posts).toHaveLength(1));

    // A parent re-render hands a NEW item object (same id) while the first POST
    // is still in flight — the on-item effect clears `actionPending`, which
    // re-enables the trigger. A second click must NOT start a second, overlapping
    // duplicate (would leave an orphaned/partial copy — BR c7b77295).
    rerender(<CardDetailSheet {...baseProps} item={makeItem("A", 1)} onDuplicate={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^duplicate$/i }));

    // Give any second POST a tick to land, then assert it never happened.
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toHaveLength(1);

    releasePost();
  });

  it("prompts to copy sub-items for every duplicate, including a freshly-made copy", async () => {
    global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.includes("/duplicate")) {
        // The server returns the copy WITH its cloned sub-items (v2.128.2) so the
        // sheet, which switches to the copy, knows the copy has children.
        return Promise.resolve(
          new Response(JSON.stringify(makeItem("copy", 2, [childRef("c2", 21)])), {
            status: 201,
          }),
        );
      }
      // Single-item reconcile GET returns authoritative children per item.
      if (init?.method === undefined && /\/work-items\/[^/]+$/.test(u)) {
        const id = u.split("/").pop();
        const children = id === "copy" ? [childRef("c2", 21)] : [childRef("c1", 11)];
        return Promise.resolve(new Response(JSON.stringify({ children }), { status: 200 }));
      }
      return Promise.resolve(new Response("[]", { status: 200 }));
    }) as unknown as typeof fetch;

    function Harness() {
      const [it, setIt] = useState<WorkItem>(makeItem("A", 1, [childRef("c1", 11)]));
      return <CardDetailSheet {...baseProps} item={it} onDuplicate={(d) => setIt(d)} />;
    }
    render(<Harness />);

    // First duplicate of the parent → sub-item prompt appears; include children.
    fireEvent.click(await screen.findByRole("button", { name: /^duplicate$/i }));
    expect(await screen.findByText(/Duplicate sub-items too/i)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /include/i }));

    // The sheet switches to the copy (#2), which itself has a sub-item.
    await screen.findByText("#2");

    // Duplicating the copy must ALSO prompt — the reported bug was that only the
    // first duplicate asked to copy sub-items.
    fireEvent.click(screen.getByRole("button", { name: /^duplicate$/i }));
    expect(await screen.findByText(/Duplicate sub-items too/i)).toBeTruthy();
  });
});
