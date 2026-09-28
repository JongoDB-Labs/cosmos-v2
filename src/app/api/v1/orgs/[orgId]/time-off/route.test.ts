import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, readableTimeUserIds } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    timeOffRequest: { findMany: vi.fn(), create: vi.fn() },
  },
  getAuthContext: vi.fn(),
  readableTimeUserIds: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/time/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/time/scope")>();
  return { ...actual, readableTimeUserIds: (...a: unknown[]) => readableTimeUserIds(...a) };
});

import { GET, POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const MY_REPORT = "33333333-3333-4333-8333-333333333333";
const A_STRANGER = "44444444-4444-4444-8444-444444444444";

const bits = (...keys: PermissionKey[]) => keys.reduce((a, k) => a | Permission[k], 0n);

function ctx(...keys: PermissionKey[]): AuthContext {
  const permissions = bits(...keys);
  return {
    userId: ME,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  } as AuthContext;
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  userId: ME,
  kind: "VACATION",
  status: "PENDING",
  startDate: new Date("2026-09-21T00:00:00.000Z"),
  endDate: new Date("2026-09-25T00:00:00.000Z"),
  hoursPerDay: 8,
  note: null,
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  ...over,
});

const req = (qs = "") => new NextRequest(`http://localhost/api/v1/orgs/o/time-off${qs}`);
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/orgs/o/time-off", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = Promise.resolve({ orgId: ORG_ID });

const whereSent = () => prisma.timeOffRequest.findMany.mock.calls[0][0].where;
const body = async (r: Response) => {
  const j = await r.json();
  return j.data ?? j;
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  getAuthContext.mockResolvedValue(ctx("TIME_READ", "TIME_CREATE"));
  readableTimeUserIds.mockResolvedValue([ME, MY_REPORT]);
  prisma.timeOffRequest.findMany.mockResolvedValue([]);
});

describe("GET /orgs/[orgId]/time-off", () => {
  it("shows me my own by default", async () => {
    await GET(req(), { params });
    expect(whereSent()).toMatchObject({ orgId: ORG_ID, userId: ME });
  });

  it("lets me read somebody who reports to me", async () => {
    await GET(req(`?userId=${MY_REPORT}`), { params });
    expect(whereSent()).toMatchObject({ userId: MY_REPORT });
  });

  it("refuses a stranger's rather than answering empty", async () => {
    // An empty list has to mean "nothing booked". If it could also mean "not
    // allowed to ask", a reader could not tell the two apart.
    const res = await GET(req(`?userId=${A_STRANGER}`), { params });
    expect(res.status).toBe(403);
    expect(prisma.timeOffRequest.findMany).not.toHaveBeenCalled();
  });

  it("scopes a team view to the people I may read", async () => {
    await GET(req("?scope=team"), { params });
    expect(whereSent()).toMatchObject({ userId: { in: [ME, MY_REPORT] } });
  });

  it("does not constrain the team view for someone who may read everybody", async () => {
    readableTimeUserIds.mockResolvedValue(null); // null = TIME_READ_ALL
    await GET(req("?scope=team"), { params });
    expect(whereSent().userId).toBeUndefined();
  });

  it("selects leave that OVERLAPS the window, not leave contained by it", async () => {
    await GET(req("?from=2026-09-21&to=2026-09-27"), { params });
    const w = whereSent();
    // Starts on or before the window's end AND ends on or after its start —
    // a fortnight off belongs to every week it touches.
    expect(w.startDate).toEqual({ lte: new Date("2026-09-27T00:00:00.000Z") });
    expect(w.endDate).toEqual({ gte: new Date("2026-09-21T00:00:00.000Z") });
  });

  it("derives the hours from the range rather than reading a stored total", async () => {
    prisma.timeOffRequest.findMany.mockResolvedValue([row()]);
    const [only] = await body(await GET(req(), { params }));
    expect(only.hours).toBe(40); // Mon-Fri at 8
  });

  it("does not count the weekend a long break spans", async () => {
    prisma.timeOffRequest.findMany.mockResolvedValue([
      row({ startDate: new Date("2026-09-25T00:00:00.000Z"), endDate: new Date("2026-09-28T00:00:00.000Z") }),
    ]);
    const [only] = await body(await GET(req(), { params }));
    expect(only.hours).toBe(16); // Friday and Monday, not four days
  });

  it("ignores a status filter that is not a status", async () => {
    await GET(req("?status=;DROP"), { params });
    expect(whereSent().status).toBeUndefined();
  });
});

describe("POST /orgs/[orgId]/time-off", () => {
  const ask = { kind: "VACATION", startDate: "2026-12-21", endDate: "2026-12-24" };

  it("files my own ask as pending", async () => {
    prisma.timeOffRequest.create.mockResolvedValue(row());
    const res = await POST(post(ask), { params });
    expect(res.status).toBe(201);
    expect(prisma.timeOffRequest.create.mock.calls[0][0].data).toMatchObject({
      orgId: ORG_ID,
      userId: ME,
      status: "PENDING",
    });
  });

  it("will not let me file against somebody else without the authority to decide", async () => {
    const res = await POST(post({ ...ask, userId: MY_REPORT }), { params });
    expect(res.status).toBe(403);
    expect(prisma.timeOffRequest.create).not.toHaveBeenCalled();
  });

  it("records a firm closure as already approved when an approver files it", async () => {
    // Nobody asked for the office to shut, so routing it to an approval queue
    // would be asking someone to consent to a decision already made.
    getAuthContext.mockResolvedValue(ctx("TIME_READ", "TIME_CREATE", "TIME_APPROVE"));
    prisma.timeOffRequest.create.mockResolvedValue(row({ kind: "HOLIDAY", status: "APPROVED" }));
    await POST(post({ ...ask, kind: "HOLIDAY", userId: MY_REPORT }), { params });
    const data = prisma.timeOffRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: MY_REPORT, status: "APPROVED", decidedById: ME });
  });

  it("still makes a holiday I file for MYSELF wait for a decision", async () => {
    prisma.timeOffRequest.create.mockResolvedValue(row());
    await POST(post({ ...ask, kind: "HOLIDAY" }), { params });
    expect(prisma.timeOffRequest.create.mock.calls[0][0].data.status).toBe("PENDING");
  });

  it("rejects a range that ends before it starts", async () => {
    const res = await POST(post({ ...ask, startDate: "2026-12-24", endDate: "2026-12-21" }), { params });
    expect(res.status).toBe(400);
    expect(prisma.timeOffRequest.create).not.toHaveBeenCalled();
  });

  it("refuses somebody who may not log time at all", async () => {
    getAuthContext.mockResolvedValue(ctx("TIME_READ"));
    expect((await POST(post(ask), { params })).status).toBe(403);
  });
});
