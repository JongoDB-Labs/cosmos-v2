import { describe, it, expect } from "vitest";
import { workItemToDetailRow } from "./detail-row";
import type { WorkItem, OrgMember } from "@/types/models";

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi_1",
    orgId: "org_1",
    projectId: "proj_1",
    workItemTypeId: "type_1",
    title: "Fix the login bug",
    description: "some description",
    columnKey: "IN_PROGRESS",
    assigneeId: null,
    priority: "HIGH",
    intervalId: null,
    parentId: null,
    ticketNumber: 42,
    storyPoints: 5,
    sortOrder: 0,
    dueDate: "2026-08-01T00:00:00.000Z",
    startDate: null,
    actualStart: null,
    completedAt: null,
    workCategory: "BUSINESS",
    tags: ["backend", "urgent"],
    customFields: {},
    createdById: "user_1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    workItemType: { id: "type_1", key: "BUG", name: "Bug", icon: "🐛", color: null },
    ...overrides,
  };
}

const member: OrgMember = {
  id: "m_1",
  orgId: "org_1",
  userId: "user_9",
  role: "MEMBER",
  user: {
    id: "user_9",
    displayName: "Ada Lovelace",
    avatarUrl: "https://example.com/ada.png",
    email: "ada@example.com",
  },
};

const ctx = {
  projectId: "proj_1",
  projectKey: "COS",
  projectName: "Cosmos",
  membersById: new Map<string, OrgMember>([[member.userId, member]]),
};

describe("workItemToDetailRow", () => {
  it("composes the ticket key from projectKey + ticketNumber", () => {
    const row = workItemToDetailRow(makeItem(), ctx);
    expect(row.ticketKey).toBe("COS-42");
  });

  it("carries core scalar fields through unchanged", () => {
    const row = workItemToDetailRow(makeItem(), ctx);
    expect(row).toMatchObject({
      id: "wi_1",
      title: "Fix the login bug",
      columnKey: "IN_PROGRESS",
      priority: "HIGH",
      storyPoints: 5,
      tags: ["backend", "urgent"],
      dueDate: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(row.type).toEqual({ name: "Bug", icon: "🐛" });
    expect(row.project).toEqual({ id: "proj_1", key: "COS", name: "Cosmos" });
  });

  it("resolves the assignee from the member map", () => {
    const row = workItemToDetailRow(makeItem({ assigneeId: "user_9" }), ctx);
    expect(row.assignee).toEqual({
      id: "user_9",
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
    });
  });

  it("returns a null assignee when unassigned", () => {
    const row = workItemToDetailRow(makeItem({ assigneeId: null }), ctx);
    expect(row.assignee).toBeNull();
  });

  it("falls back to Unknown when the assignee is not in the member map", () => {
    const row = workItemToDetailRow(makeItem({ assigneeId: "ghost" }), ctx);
    expect(row.assignee).toEqual({ id: "ghost", displayName: "Unknown", avatarUrl: null });
  });

  it("maps the parent reference with its own ticket key", () => {
    const row = workItemToDetailRow(
      makeItem({
        parent: { id: "wi_0", title: "Epic", ticketNumber: 7, workItemTypeId: "type_e" },
      }),
      ctx,
    );
    expect(row.parent).toEqual({ id: "wi_0", ticketKey: "COS-7", title: "Epic" });
  });

  it("has a null parent when the item has none", () => {
    const row = workItemToDetailRow(makeItem({ parent: null }), ctx);
    expect(row.parent).toBeNull();
  });

  it("falls back to the project key for a missing project name", () => {
    const row = workItemToDetailRow(makeItem(), { ...ctx, projectName: undefined });
    expect(row.project.name).toBe("COS");
  });
});
