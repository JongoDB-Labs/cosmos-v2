// @vitest-environment jsdom
//
// COSMOS-201: the Kanban card's Delete now goes through the shared
// DeleteWorkItemDialog. It must still ask first and send the DELETE.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { WorkItem, OrgMember } from "@/types/models";

// --- base-ui / dnd-kit need these in jsdom (see memory: testing-base-ui-in-jsdom) ---
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// useOrgMutation → useOrgSlug reads the pathname; give it a stable org URL.
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w1",
    orgId: "o1",
    projectId: "p1",
    workItemTypeId: "t1",
    title: "Test card",
    description: "",
    columnKey: "todo",
    assigneeId: null,
    priority: "MEDIUM",
    intervalId: null,
    parentId: null,
    ticketNumber: 42,
    storyPoints: null,
    sortOrder: 0,
    dueDate: null,
    startDate: null,
    actualStart: null,
    completedAt: null,
    workCategory: "BUSINESS",
    tags: [],
    customFields: {},
    createdById: "u1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

type CardProps = Parameters<typeof KanbanCard>[0];

function renderCard(props: Partial<CardProps> = {}) {
  const item = props.item ?? makeItem();
  const members: OrgMember[] = props.members ?? [];
  const handlers = {
    onClick: vi.fn(),
    onToggleSelect: vi.fn(),
    onCtrlSelect: vi.fn(),
    onRangeSelect: vi.fn(),
    ...props,
  } as CardProps;

  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <DndContext>
        <SortableContext items={[item.id]}>
          <KanbanCard {...handlers} item={item} members={members} />
        </SortableContext>
      </DndContext>
    </QueryClientProvider>,
  );

  return handlers;
}


const { jsonFetch } = vi.hoisted(() => ({ jsonFetch: vi.fn(async () => null) }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch }));
vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return { ...real, usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: ~0n, can: () => true }) };
});

import { KanbanCard } from "./kanban-card";

describe("KanbanCard — Delete", () => {
  afterEach(cleanup);

  it("asks first, then deletes the item", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /open menu/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete work item?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(
        "/api/v1/orgs/o1/projects/p1/work-items/w1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
