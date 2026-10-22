// @vitest-environment node
//
// COSMOS-177: the assistant could not walk an epic's children. Neither work
// item tool filtered on `parentId` or returned it, and the egress projection
// dropped it, so "what is under this epic?" ended in the model paging through every
// item looking for a field that was never there.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import { projectStructural } from "@/lib/ai/egress/projection";

const { prisma, loadEffectivePermissions, getReadableProjectIds, requireProjectRead } =
  vi.hoisted(() => ({
    prisma: {
      workItem: { findMany: vi.fn() },
      orgMember: { findMany: vi.fn() },
    },
    loadEffectivePermissions: vi.fn(),
    getReadableProjectIds: vi.fn(),
    requireProjectRead: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));
vi.mock("@/lib/work-items/query/scope", () => ({ getReadableProjectIds }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead }));

import { executeTool } from "./tool-executor";

const ME = "11111111-1111-4111-a111-111111111111";
const PROJECT = "22222222-2222-4222-a222-222222222222";
const EPIC = "44444444-4444-4444-a444-444444444444";
const ctx = { orgId: "org-1", userId: ME };

const lastArgs = () =>
  prisma.workItem.findMany.mock.calls.at(-1)?.[0] as {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  };

beforeEach(() => {
  vi.clearAllMocks();
  loadEffectivePermissions.mockResolvedValue({
    orgRole: "MEMBER",
    permissions: Permission.ITEM_READ,
    basePermissions: Permission.ITEM_READ,
    abacRules: [],
  });
  getReadableProjectIds.mockResolvedValue([PROJECT]);
  requireProjectRead.mockResolvedValue(undefined);
  prisma.workItem.findMany.mockResolvedValue([]);
  prisma.orgMember.findMany.mockResolvedValue([]);
});

describe.each(["query_work_items", "list_work_items"])("%s — parentId", (tool) => {
  it("filters to the direct children of the given item", async () => {
    await executeTool(tool, { projectId: PROJECT, parentId: EPIC }, ctx);

    expect(lastArgs().where.parentId).toBe(EPIC);
  });

  it("returns each item's parentId", async () => {
    await executeTool(tool, { projectId: PROJECT }, ctx);

    expect(lastArgs().select.parentId).toBe(true);
    expect(lastArgs().where).not.toHaveProperty("parentId");
  });

  it("refuses a parentId that is not an id instead of querying with it", async () => {
    const res = (await executeTool(tool, { projectId: PROJECT, parentId: "EPIC-7" }, ctx)) as {
      error?: string;
    };

    expect(res.error).toBeTruthy();
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });
});

describe("work_item egress projection", () => {
  it("keeps parentId, a structural id, while still dropping free text", () => {
    const out = projectStructural(
      { id: "a", parentId: EPIC, title: "CUI//SP title" },
      "work_item",
    ) as Record<string, unknown>;

    expect(out).toEqual({ id: "a", parentId: EPIC });
  });
});
