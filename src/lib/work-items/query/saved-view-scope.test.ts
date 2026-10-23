// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    interval: { findMany: vi.fn() },
    workItem: { findMany: vi.fn() },
    customField: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { filterRefs, visibleSavedViews } from "./saved-view-scope";

const ORG = "00000000-0000-4000-8000-000000000000";
const ME = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const P_OPEN = "00000000-0000-4000-8000-000000000001";
const P_SECRET = "00000000-0000-4000-8000-000000000002";
const SPRINT_SECRET = "00000000-0000-4000-8000-000000000010";
const SPRINT_OPEN = "00000000-0000-4000-8000-000000000011";
const ITEM_SECRET = "00000000-0000-4000-8000-000000000020";
const GONE = "00000000-0000-4000-8000-000000000099";

const view = (id: string, ownerId: string, filter: unknown) => ({ id, ownerId, filter });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.interval.findMany.mockResolvedValue([
    { id: SPRINT_SECRET, projectId: P_SECRET },
    { id: SPRINT_OPEN, projectId: P_OPEN },
  ]);
  prisma.workItem.findMany.mockResolvedValue([{ id: ITEM_SECRET, projectId: P_SECRET }]);
  prisma.customField.findMany.mockResolvedValue([
    { key: "secret_cf", projectId: P_SECRET },
    { key: "org_cf", projectId: null },
  ]);
});

describe("filterRefs", () => {
  it("collects project-bound ids and ignores sentinels and junk", () => {
    expect(
      filterRefs({
        projectIds: [P_OPEN, "not-a-uuid", 7],
        intervalIds: ["none", SPRINT_OPEN],
        ids: [ITEM_SECRET],
        parent: { mode: "is", parentIds: [GONE] },
        customFields: [{ key: "secret_cf" }, { nope: 1 }],
      }),
    ).toEqual({
      projectIds: [P_OPEN],
      intervalIds: [SPRINT_OPEN],
      itemIds: [ITEM_SECRET, GONE],
      customFieldKeys: ["secret_cf"],
    });
  });
  it("tolerates a non-object filter", () => {
    expect(filterRefs(null)).toEqual({ projectIds: [], intervalIds: [], itemIds: [], customFieldKeys: [] });
  });
});

describe("visibleSavedViews", () => {
  const readable = [P_OPEN];

  it("withholds another member's shared view per kind of unreadable reference", async () => {
    const views = [
      view("project", OTHER, { projectIds: [P_SECRET] }),
      view("sprint", OTHER, { intervalIds: [SPRINT_SECRET] }),
      view("item", OTHER, { ids: [ITEM_SECRET] }),
      view("parent", OTHER, { parent: { mode: "is", parentIds: [ITEM_SECRET] } }),
      view("cf", OTHER, { customFields: [{ key: "secret_cf", kind: "TEXT", value: "x" }] }),
      view("mixed", OTHER, { projectIds: [P_OPEN, P_SECRET] }),
    ];
    expect(await visibleSavedViews(ORG, ME, readable, views)).toEqual([]);
  });

  it("keeps shared views whose references are readable, org-level or gone", async () => {
    const views = [
      view("open", OTHER, { projectIds: [P_OPEN], intervalIds: [SPRINT_OPEN, "none"] }),
      view("org-cf", OTHER, { customFields: [{ key: "org_cf", kind: "TEXT", value: "x" }] }),
      view("gone", OTHER, { ids: [GONE] }),
      view("plain", OTHER, { priorities: ["HIGH"], text: "login" }),
    ];
    const out = await visibleSavedViews(ORG, ME, readable, views);
    expect(out.map((v) => v.id)).toEqual(["open", "org-cf", "gone", "plain"]);
  });

  it("always keeps the viewer's own views, and skips the DB when there are no others", async () => {
    const views = [view("mine", ME, { projectIds: [P_SECRET] })];
    expect(await visibleSavedViews(ORG, ME, readable, views)).toEqual(views);
    expect(prisma.interval.findMany).not.toHaveBeenCalled();
  });

  it("scopes every lookup to the org", async () => {
    await visibleSavedViews(ORG, ME, readable, [
      view("v", OTHER, { intervalIds: [SPRINT_OPEN], ids: [GONE], customFields: [{ key: "org_cf" }] }),
    ]);
    for (const fn of [prisma.interval.findMany, prisma.workItem.findMany, prisma.customField.findMany]) {
      expect(fn.mock.calls[0][0].where.orgId).toBe(ORG);
    }
  });
});
