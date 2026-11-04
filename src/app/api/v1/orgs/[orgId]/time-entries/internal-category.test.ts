// @vitest-environment node
//
// Internal time categories on the write paths: a category must be one of the
// org's own, never sits on a project (it would be counted as both project and
// internal time), and makes the entry INTERNAL whatever else was sent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, TS_ID } = vi.hoisted(() => ({
  TS_ID: "99999999-9999-4999-8999-999999999999",
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    timeEntry: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    timeEntryRevision: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/time/timesheet", () => ({
  timesheetIdForEntry: vi.fn(async () => TS_ID),
  isTimesheetOpen: vi.fn(async () => true),
}));
vi.mock("@/lib/rbac/require-project-read", () => ({
  requireProjectVisibleIf: vi.fn(async () => undefined),
  requireProjectRead: vi.fn(async () => undefined),
  inVisibleProject: vi.fn(async () => true),
}));

import { POST } from "./route";
import { PUT } from "./[entryId]/route";
import { timeEntryRow } from "@/lib/openapi/testing/rows";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const ENTRY_ID = "77777777-7777-4777-8777-777777777777";
const PROJECT_ID = "88888888-8888-4888-8888-888888888888";

const ctx: AuthContext = {
  userId: ACTOR_ID,
  orgId: ORG_ID,
  orgRole: OrgRole.MEMBER,
  permissions: RolePermissions.MEMBER,
  basePermissions: RolePermissions.MEMBER,
  abacRules: [],
};

const req = (method: string, body: unknown) =>
  new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/time-entries`, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(ctx);
  prisma.organization.findUnique.mockResolvedValue({
    id: ORG_ID,
    slug: "acme",
    settings: { time: { internalCategories: ["Overhead", "Business development"] } },
  });
  prisma.timeEntry.create.mockImplementation(async ({ data }) => timeEntryRow({ id: ENTRY_ID, ...data }));
  prisma.timeEntry.update.mockImplementation(async ({ data }) =>
    timeEntryRow({ id: ENTRY_ID, userId: ACTOR_ID, ...data }),
  );
});

describe("POST /time-entries — internal category", () => {
  const post = (extra: Record<string, unknown>) =>
    POST(req("POST", { date: "2026-10-20", hours: 2, ...extra }), { params: Promise.resolve({ orgId: ORG_ID }) });

  it("records a configured category and makes the entry INTERNAL", async () => {
    const res = await post({ internalCategory: "Overhead", billableType: "BILLABLE" });
    expect(res.status).toBe(201);
    const data = prisma.timeEntry.create.mock.calls[0][0].data;
    expect(data.internalCategory).toBe("Overhead");
    expect(data.billableType).toBe("INTERNAL");
    expect((await res.json()).internalCategory).toBe("Overhead");
  });

  it("refuses a category the org doesn't have", async () => {
    const res = await post({ internalCategory: "Golf" });
    expect(res.status).toBe(400);
    expect(prisma.timeEntry.create).not.toHaveBeenCalled();
  });

  it("refuses a category on an entry with a project", async () => {
    const res = await post({ internalCategory: "Overhead", projectId: PROJECT_ID });
    expect(res.status).toBe(400);
    expect(prisma.timeEntry.create).not.toHaveBeenCalled();
  });

  it("an ordinary entry is untouched: no category, the billable type it was sent", async () => {
    const res = await post({ projectId: PROJECT_ID, billableType: "NON_BILLABLE" });
    expect(res.status).toBe(201);
    const data = prisma.timeEntry.create.mock.calls[0][0].data;
    expect(data.internalCategory).toBeNull();
    expect(data.billableType).toBe("NON_BILLABLE");
  });
});

describe("PUT /time-entries/[entryId] — internal category", () => {
  const put = (body: Record<string, unknown>) =>
    PUT(req("PUT", body), { params: Promise.resolve({ orgId: ORG_ID, entryId: ENTRY_ID }) });
  const existing = (over: Record<string, unknown>) =>
    prisma.timeEntry.findFirst.mockResolvedValue(
      timeEntryRow({ id: ENTRY_ID, userId: ACTOR_ID, orgId: ORG_ID, timesheetId: TS_ID, ...over }),
    );

  it("sets a category on an existing project-less entry, and makes it INTERNAL", async () => {
    existing({});
    const res = await put({ internalCategory: "Business development" });
    expect(res.status).toBe(200);
    const data = prisma.timeEntry.update.mock.calls[0][0].data;
    expect(data.internalCategory).toBe("Business development");
    expect(data.billableType).toBe("INTERNAL");
  });

  it("refuses moving a categorised entry onto a project without clearing the category", async () => {
    existing({ internalCategory: "Overhead", billableType: "INTERNAL" });
    const res = await put({ projectId: PROJECT_ID });
    expect(res.status).toBe(400);
    expect(prisma.timeEntry.update).not.toHaveBeenCalled();
  });

  it("refuses categorising an entry that is already on a project", async () => {
    existing({ projectId: PROJECT_ID });
    const res = await put({ internalCategory: "Overhead" });
    expect(res.status).toBe(400);
    expect(prisma.timeEntry.update).not.toHaveBeenCalled();
  });

  it("allows the move when the category is cleared in the same edit", async () => {
    existing({ internalCategory: "Overhead", billableType: "INTERNAL" });
    const res = await put({ projectId: PROJECT_ID, internalCategory: null });
    expect(res.status).toBe(200);
    expect(prisma.timeEntry.update.mock.calls[0][0].data.internalCategory).toBeNull();
  });

  it("an entry whose category the org has since removed can still have its hours edited", async () => {
    existing({ internalCategory: "Retired category", billableType: "INTERNAL" });
    const res = await put({ hours: 3 });
    expect(res.status).toBe(200);
  });

  it("refuses switching to a category the org doesn't have", async () => {
    existing({ internalCategory: "Overhead", billableType: "INTERNAL" });
    const res = await put({ internalCategory: "Golf" });
    expect(res.status).toBe(400);
  });
});
