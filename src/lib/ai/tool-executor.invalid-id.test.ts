// @vitest-environment node
//
// Regression lock (COSMOS-176): a model-invented id must not crash the chat.
//
// Asked to prep a retro, the assistant reached for the sprint-data tools with a
// readable-looking but non-uuid project id ("f9s8d7f9-demo-proj-id") it had
// never resolved. That went straight into a `uuid` column, Prisma raised P2007
// (`invalid input syntax for type uuid`), and because `executeTool` had no
// catch the throw escaped the agent loop — the user got a raw
// "Invalid `prisma.interval.findFirst()` invocation" instead of an answer.
//
// Uses the REAL Prisma client (so the uuid rejection is the database's own
// rule, not a mock's) and mocks only the permission lookup.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { loadEffectivePermissions, listIntervals } = vi.hoisted(() => ({
  loadEffectivePermissions: vi.fn(),
  listIntervals: vi.fn(),
}));

vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));
// Only to prove the LAST-RESORT catch: an executor that throws anyway must come
// back as a tool error, never as an escaped exception.
vi.mock("./executors/projects", () => ({
  listProjects: vi.fn(),
  listIntervals,
  createInterval: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  updateInterval: vi.fn(),
  completeInterval: vi.fn(),
}));

import { executeTool } from "./tool-executor";

const CTX = { orgId: "11111111-1111-1111-1111-111111111111", userId: "22222222-2222-2222-2222-222222222222" };
const HALLUCINATED_ID = "f9s8d7f9-demo-proj-id";
const WELL_FORMED_ID = "33333333-3333-3333-3333-333333333333";

function withBits(...keys: PermissionKey[]) {
  const permissions = keys.reduce((acc, k) => acc | Permission[k], 0n);
  loadEffectivePermissions.mockResolvedValue({
    orgRole: "MEMBER",
    permissions,
    basePermissions: permissions,
    abacRules: [],
  });
}

describe("executeTool — malformed ids are refused, not thrown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withBits("CHAT_USE", "SPRINT_READ", "ITEM_READ");
  });

  it("generate_interval_brief refuses a non-uuid projectId with an actionable message", async () => {
    const res = (await executeTool("generate_interval_brief", { projectId: HALLUCINATED_ID }, CTX)) as {
      error: string;
    };
    expect(res.error).toMatch(/projectId is not a valid id/);
    expect(res.error).toMatch(/list_projects/);
    // Never the database's own words.
    expect(res.error).not.toMatch(/prisma|uuid syntax|invocation/i);
  });

  it("generate_interval_brief refuses a non-uuid intervalId", async () => {
    const res = (await executeTool(
      "generate_interval_brief",
      { projectId: WELL_FORMED_ID, intervalId: HALLUCINATED_ID },
      CTX,
    )) as { error: string };
    expect(res.error).toMatch(/intervalId is not a valid id/);
  });

  it("still queries for a well-formed projectId (no over-rejection)", async () => {
    const res = await executeTool("generate_interval_brief", { projectId: WELL_FORMED_ID }, CTX);
    // The uuid is real enough for Postgres; the project simply has no interval.
    expect(res).toEqual({ error: "No active interval found" });
  });

  it("query_intervals refuses a non-uuid projectId", async () => {
    const res = (await executeTool("query_intervals", { projectId: HALLUCINATED_ID }, CTX)) as { error: string };
    expect(res.error).toMatch(/projectId is not a valid id/);
  });

  it("query_work_items refuses a non-uuid intervalId", async () => {
    const res = (await executeTool("query_work_items", { intervalId: HALLUCINATED_ID }, CTX)) as { error: string };
    expect(res.error).toMatch(/intervalId is not a valid id/);
  });

  it("converts a Prisma P2007 that escapes an executor into a tool error", async () => {
    listIntervals.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Invalid `prisma.interval.findFirst()` invocation:\nInvalid input value: invalid input syntax for type uuid: "f9s8d7f9-demo-proj-id"',
        { code: "P2007", clientVersion: "7.9.1" },
      ),
    );

    const res = (await executeTool("list_intervals", { projectId: HALLUCINATED_ID }, CTX)) as { error: string };

    expect(res.error).toMatch(/isn't a valid record id/);
    expect(res.error).not.toMatch(/prisma|invocation|uuid:/i);
  });

  it("converts any other escaped executor error into a tool error", async () => {
    listIntervals.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const res = (await executeTool("list_intervals", { projectId: WELL_FORMED_ID }, CTX)) as { error: string };

    expect(res.error).toMatch(/list_intervals tool failed/);
    expect(res.error).not.toMatch(/connection terminated/);
  });
});
