// @vitest-environment node
//
// `includeOrgEvents` reaches the service only when asked for, so `projectId`
// alone keeps its meaning ("only this project") for every existing caller.
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  ctx: { orgId: "11111111-1111-4111-8111-111111111111", userId: "u", orgRole: "ADMIN" },
}));

vi.mock("@/lib/openapi/org-context", () => ({
  orgContext: vi.fn(async () => ({ org: { slug: "o" }, ctx: h.ctx })),
}));
vi.mock("@/lib/rbac/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rbac/check")>()),
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/program-calendar/service", () => ({
  listProgramEvents: vi.fn(async () => []),
  createProgramEvent: vi.fn(),
}));

import { GET } from "./route";
import { listProgramEvents } from "@/lib/program-calendar/service";

const ORG = h.ctx.orgId;
const PROJECT = "22222222-2222-4222-8222-222222222222";
const WINDOW = "from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z";
const get = (qs: string) =>
  GET(new NextRequest(`http://localhost/x?${WINDOW}&${qs}`), { params: Promise.resolve({ orgId: ORG }) });
const filters = () => vi.mocked(listProgramEvents).mock.calls[0][3]!;

afterEach(() => vi.clearAllMocks());

describe("the events list's project filter", () => {
  it("passes includeOrgEvents to the service when asked", async () => {
    expect((await get(`projectId=${PROJECT}&includeOrgEvents=true`)).status).toBe(200);
    expect(filters()).toMatchObject({ projectId: PROJECT, includeOrgEvents: true });
  });

  it("control: projectId alone does not include org events", async () => {
    expect((await get(`projectId=${PROJECT}`)).status).toBe(200);
    expect(filters()).toMatchObject({ projectId: PROJECT, includeOrgEvents: false });
  });

  it("refuses a value that is not true or false", async () => {
    expect((await get(`projectId=${PROJECT}&includeOrgEvents=yes`)).status).toBe(400);
    expect(listProgramEvents).not.toHaveBeenCalled();
  });
});
