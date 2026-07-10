import { describe, it, expect, vi } from "vitest";
import { buildBacklogItemMenu, type BacklogItemMenuHandlers } from "./item-menu";
import {
  Permission,
  RolePermissions,
  hasPermission,
} from "@/lib/rbac/permissions";
import type { Cycle, WorkItem } from "@/types/models";

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi1",
    orgId: "o1",
    projectId: "p1",
    workItemTypeId: "t1",
    title: "Ship it",
    description: "",
    columnKey: "todo",
    assigneeId: null,
    priority: "MEDIUM",
    cycleId: null,
    parentId: null,
    ticketNumber: 42,
    storyPoints: null,
    sortOrder: 0,
    dueDate: null,
    startDate: null,
    baselineStart: null,
    baselineEnd: null,
    completedAt: null,
    workCategory: "BUSINESS",
    tags: [],
    customFields: {},
    createdById: "u1",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function makeCycle(id: string, name: string): Cycle {
  return {
    id,
    orgId: "o1",
    projectId: "p1",
    cycleKind: "SPRINT",
    number: 1,
    name,
    goal: "",
    startDate: "",
    endDate: "",
    status: "PLANNED",
    report: null,
  };
}

/** A `can` derived from a real role mask — same bitfield check the app runs. */
function canForRole(role: keyof typeof RolePermissions) {
  return (perm: bigint) => hasPermission(RolePermissions[role], perm);
}

function makeHandlers(): BacklogItemMenuHandlers {
  return {
    onOpen: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onMoveToCycle: vi.fn(),
  };
}

/** Flat list of every action label the menu exposes. */
function labelsOf(groups: ReturnType<typeof buildBacklogItemMenu>): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.label));
}

describe("buildBacklogItemMenu — RBAC-gated backlog item CRUD (COSMOS-29)", () => {
  const cycles = [makeCycle("c1", "Sprint 1"), makeCycle("c2", "Sprint 2")];

  it("exposes the full CRUD set for an ADMIN", () => {
    const groups = buildBacklogItemMenu(
      makeItem(),
      cycles,
      canForRole("ADMIN"),
      makeHandlers(),
    );
    const labels = labelsOf(groups);
    expect(labels).toContain("Edit details"); // read + update
    expect(labels).toContain("Duplicate"); // create
    expect(labels).toContain("Delete"); // delete
    expect(labels).toContain("Sprint 1"); // move-to-sprint (update)
    expect(labels).toContain("Sprint 2");
  });

  it("hides Delete for a MEMBER (has create/update, not ITEM_DELETE)", () => {
    // Guards the exact role that motivated the ticket: a MEMBER may edit and
    // duplicate but must NOT see a Delete action they can't perform.
    expect(hasPermission(RolePermissions.MEMBER, Permission.ITEM_DELETE)).toBe(
      false,
    );
    const groups = buildBacklogItemMenu(
      makeItem(),
      cycles,
      canForRole("MEMBER"),
      makeHandlers(),
    );
    const labels = labelsOf(groups);
    expect(labels).toContain("Edit details");
    expect(labels).toContain("Duplicate");
    expect(labels).toContain("Sprint 1");
    expect(labels).not.toContain("Delete");
  });

  it("gives a VIEWER read-only access — only the View entry, no mutations", () => {
    const groups = buildBacklogItemMenu(
      makeItem({ cycleId: "c1" }),
      cycles,
      canForRole("VIEWER"),
      makeHandlers(),
    );
    const labels = labelsOf(groups);
    expect(labels).toEqual(["View details"]);
    expect(labels).not.toContain("Edit details");
    expect(labels).not.toContain("Duplicate");
    expect(labels).not.toContain("Delete");
    // A read-only actor must not be offered the "Move to sprint" update either.
    expect(labels).not.toContain("Backlog");
    expect(labels).not.toContain("Sprint 2");
  });

  it("renders no menu items at all when the actor lacks even ITEM_READ", () => {
    const groups = buildBacklogItemMenu(
      makeItem(),
      cycles,
      () => false,
      makeHandlers(),
    );
    expect(groups.every((g) => g.items.length === 0)).toBe(true);
  });

  it("marks Delete as a destructive action", () => {
    const groups = buildBacklogItemMenu(
      makeItem(),
      cycles,
      canForRole("ADMIN"),
      makeHandlers(),
    );
    const del = groups.flatMap((g) => g.items).find((i) => i.label === "Delete");
    expect(del?.variant).toBe("destructive");
  });

  it("wires each CRUD action to its handler", () => {
    const handlers = makeHandlers();
    const groups = buildBacklogItemMenu(
      makeItem(),
      cycles,
      canForRole("ADMIN"),
      handlers,
    );
    const byLabel = (label: string) =>
      groups.flatMap((g) => g.items).find((i) => i.label === label);

    byLabel("Edit details")!.onClick();
    expect(handlers.onOpen).toHaveBeenCalledOnce();

    byLabel("Duplicate")!.onClick();
    expect(handlers.onDuplicate).toHaveBeenCalledOnce();

    byLabel("Delete")!.onClick();
    expect(handlers.onDelete).toHaveBeenCalledOnce();

    byLabel("Sprint 1")!.onClick();
    expect(handlers.onMoveToCycle).toHaveBeenCalledWith("c1");
  });

  describe("Move to sprint targets", () => {
    it("excludes the item's current cycle and offers Backlog when in a cycle", () => {
      const handlers = makeHandlers();
      const groups = buildBacklogItemMenu(
        makeItem({ cycleId: "c1" }),
        cycles,
        canForRole("ADMIN"),
        handlers,
      );
      const labels = labelsOf(groups);
      expect(labels).toContain("Backlog"); // move back out of the sprint
      expect(labels).toContain("Sprint 2"); // the other sprint
      expect(labels).not.toContain("Sprint 1"); // the current one is omitted

      groups.flatMap((g) => g.items).find((i) => i.label === "Backlog")!.onClick();
      expect(handlers.onMoveToCycle).toHaveBeenCalledWith(null);
    });

    it("omits the Backlog target when the item is already in the backlog", () => {
      const groups = buildBacklogItemMenu(
        makeItem({ cycleId: null }),
        cycles,
        canForRole("ADMIN"),
        makeHandlers(),
      );
      expect(labelsOf(groups)).not.toContain("Backlog");
    });
  });
});
