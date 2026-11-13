// @vitest-environment node
//
// A Program Increment is always top-level. Creating one with a parent, or
// moving one under another interval, is refused with a message that says why.
//
// Before: create dropped the parent without a word (the PI was made at the
// top level, not where the caller asked), and update accepted a PI under a PI
// (it only checked that the PARENT was a PI). The board's interval tree lists
// such a PI as a PI of its own, while the `pi` query field took its work into
// the outer PI, so two screens counted the same rows differently.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { intervalRow } from "@/lib/openapi/testing/rows";

const h = vi.hoisted(() => ({
  intervalFindFirst: vi.fn(),
  intervalCreate: vi.fn(),
  intervalUpdate: vi.fn(),
  intervalAggregate: vi.fn(),
  projectFindFirst: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    interval: { findFirst: h.intervalFindFirst, create: h.intervalCreate, update: h.intervalUpdate, aggregate: h.intervalAggregate },
    project: { findFirst: h.projectFindFirst },
  },
}));
vi.mock("@/lib/openapi/org-context", () => ({ orgContext: vi.fn(async () => ({ org: {}, ctx: { userId: "u1" } })) }));
vi.mock("@/lib/rbac/require-project-read", () => ({
  requireProjectRead: vi.fn(async () => undefined),
  requireProjectVisible: vi.fn(async () => undefined),
}));
vi.mock("@/lib/rbac/require-project-manage", () => ({ requireProjectManage: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

import { POST } from "./route";
import { PUT } from "./[intervalId]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OUTER_PI = "33333333-3333-4333-8333-333333333333";
const INNER_PI = "44444444-4444-4444-8444-444444444444";
const SPRINT = "55555555-5555-4555-8555-555555555555";

const rows: Record<string, ReturnType<typeof intervalRow>> = {
  [OUTER_PI]: intervalRow({ id: OUTER_PI, orgId: ORG, projectId: PROJECT, intervalKind: "PROGRAM_INCREMENT", name: "PI 1" }),
  [INNER_PI]: intervalRow({ id: INNER_PI, orgId: ORG, projectId: PROJECT, intervalKind: "PROGRAM_INCREMENT", name: "PI 2", number: 2 }),
  [SPRINT]: intervalRow({ id: SPRINT, orgId: ORG, projectId: PROJECT, name: "Sprint 1", number: 3 }),
};

const body = (b: unknown) => ({ method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
const create = (b: unknown) =>
  POST(new NextRequest(`http://localhost/api/v1/orgs/${ORG}/projects/${PROJECT}/intervals`, body(b)), {
    params: Promise.resolve({ orgId: ORG, projectId: PROJECT }),
  });
const update = (id: string, b: unknown) =>
  PUT(new NextRequest(`http://localhost/api/v1/orgs/${ORG}/projects/${PROJECT}/intervals/${id}`, { ...body(b), method: "PUT" }), {
    params: Promise.resolve({ orgId: ORG, projectId: PROJECT, intervalId: id }),
  });
const DATES = { startDate: "2026-11-01T00:00:00.000Z", endDate: "2026-11-14T00:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  h.projectFindFirst.mockResolvedValue({ id: PROJECT, orgId: ORG });
  h.intervalFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null);
  h.intervalAggregate.mockResolvedValue({ _max: { number: 3 } });
  h.intervalCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...intervalRow({ id: "66666666-6666-4666-8666-666666666666", orgId: ORG, projectId: PROJECT }),
    ...data,
    _count: { workItems: 0 },
  }));
  h.intervalUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    ...rows[where.id],
    ...data,
    _count: { workItems: 0 },
  }));
});

describe("update: a Program Increment can't be given a parent", () => {
  it("refuses a PI under a PI, says why, and writes nothing", async () => {
    const res = await update(INNER_PI, { parentId: OUTER_PI });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe(
      "A Program Increment can't go inside another Program Increment. Only sprints and other iterations can be nested in one.",
    );
    expect(h.intervalUpdate).not.toHaveBeenCalled();
  });

  it("refuses a PI under a sprint", async () => {
    const res = await update(INNER_PI, { parentId: SPRINT });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe("A Program Increment can't go inside another interval. It is always top-level.");
    expect(h.intervalUpdate).not.toHaveBeenCalled();
  });

  it("still nests a sprint under a PI (the positive control)", async () => {
    const res = await update(SPRINT, { parentId: OUTER_PI });
    expect(res.status).toBe(200);
    expect(h.intervalUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentId: OUTER_PI }) }));
  });

  it("still lets a PI be detached, which leaves it top-level", async () => {
    const res = await update(INNER_PI, { parentId: null });
    expect(res.status).toBe(200);
  });
});

describe("create: a Program Increment sent with a parent is refused, not quietly made top-level", () => {
  it("refuses a new PI under a PI", async () => {
    const res = await create({ name: "PI 3", intervalKind: "PROGRAM_INCREMENT", parentId: OUTER_PI, ...DATES });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe(
      "A Program Increment can't go inside another Program Increment. Only sprints and other iterations can be nested in one.",
    );
    expect(h.intervalCreate).not.toHaveBeenCalled();
  });

  it("creates a top-level PI and a sprint inside one (the positive controls)", async () => {
    expect((await create({ name: "PI 3", intervalKind: "PROGRAM_INCREMENT", ...DATES })).status).toBe(201);
    expect(h.intervalCreate).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentId: null }) }));
    expect((await create({ name: "Sprint 9", intervalKind: "SPRINT", parentId: OUTER_PI, ...DATES })).status).toBe(201);
    expect(h.intervalCreate).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentId: OUTER_PI }) }));
  });
});
