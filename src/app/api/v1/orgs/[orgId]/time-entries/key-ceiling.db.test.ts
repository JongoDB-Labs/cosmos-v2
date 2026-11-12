// @vitest-environment node
//
// A key limited to one project reads time on that project only.
//
// Time is scoped by PERSON (your own entries, your reports', and TIME_READ_ALL
// for everyone's), and for a signed-in member that stays the whole rule -- see
// `time/scope.ts`. A project-scoped key is a narrower grant on top: whoever
// minted it said "this token is for project P". The list and by-id reads never
// asked it, so a key scoped to P read its owner's hours on every other project,
// and with TIME_READ_ALL everybody's.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { scopeMask } from "@/lib/auth/api-key";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as listEntries } from "./route";
import { GET as getEntry } from "./[entryId]/route";
import { GET as activityFeed } from "../activity/route";
import { GET as periodsOfYear } from "../timesheets/periods/route";
import { listTimeEntries as listTool } from "@/lib/ai/executors/time";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", owner = "", p1 = "", p2 = "";
const entry: Record<"p1" | "p2" | "none", string> = { p1: "", p2: "", none: "" };

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@time-ceiling.test`, displayName: "Owner" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `tc ${stamp}`, slug: `tc-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  p1 = (await prisma.project.create({ data: { orgId, name: "One", key: `TA${stamp.slice(0, 3).toUpperCase()}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId, name: "Two", key: `TB${stamp.slice(0, 3).toUpperCase()}` } })).id;
  const day = new Date("2026-10-07T00:00:00Z");
  const log = (projectId: string | null, description: string) =>
    // SUBMITTED, not DRAFT: the activity feed leaves drafts out.
    prisma.timeEntry.create({ data: { orgId, userId: owner, projectId, date: day, hours: 2, status: "SUBMITTED", description } });
  entry.p1 = (await log(p1, "on one")).id;
  entry.p2 = (await log(p2, "on two")).id;
  entry.none = (await log(null, "internal")).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: owner } }).catch(() => undefined);
});

const key = (projects?: string[]): AuthContext => ({
  userId: owner, orgId, orgRole: "OWNER", abacRules: [],
  permissions: scopeMask(["time:read"]), basePermissions: scopeMask(["time:read"]),
  isApiKey: true, scopes: ["time:read"], ...(projects && { projectScope: projects }),
});
const session = (): AuthContext => ({ userId: owner, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] });
const get = () => new NextRequest("http://localhost/x");
const listed = async () => {
  const res = await listEntries(get(), { params: Promise.resolve({ orgId }) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((e) => e.id).sort();
};
const byId = async (entryId: string) => (await getEntry(get(), { params: Promise.resolve({ orgId, entryId }) })).status;
const feedIds = async (query = "") => {
  const res = await activityFeed(new NextRequest(`http://localhost/x?sources=time${query}`), { params: Promise.resolve({ orgId }) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((e) => e.id).sort();
};
const toolIds = async (auth: AuthContext) => {
  const out = (await listTool({}, { orgId, userId: owner, auth })) as { entries?: { id: string }[]; error?: string };
  expect(out.error).toBeUndefined();
  return (out.entries ?? []).map((e) => e.id).sort();
};

describe("a key limited to P1 reads time on P1 only", () => {
  it("the list leaves out other projects' time, and time on no project", async () => {
    h.ctx = key([p1]);
    expect(await listed()).toEqual([entry.p1]);
  });

  it("by id: another project's entry reads as missing; its own project's does not", async () => {
    h.ctx = key([p1]);
    expect(await byId(entry.p2)).toBe(404);
    expect(await byId(entry.none)).toBe(404);
    expect(await byId(entry.p1)).toBe(200);
  });

  it("the assistant's tool, under the same key, is held to the same ceiling", async () => {
    expect(await toolIds(key([p1]))).toEqual([entry.p1]);
  });

  it("the activity feed's time rows: P1 only, and naming P2 yields nothing", async () => {
    h.ctx = key([p1]);
    expect(await feedIds()).toEqual([entry.p1]);
    expect(await feedIds(`&projectId=${p2}`)).toEqual([]);
  });
});

describe("the timesheet periods", () => {
  /** Hours in the pay period that holds the seeded day. */
  const periodHours = async () => {
    const res = await periodsOfYear(new NextRequest("http://localhost/x?year=2026"), { params: Promise.resolve({ orgId }) });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { start: string; end: string; hours: number }[];
    return rows.find((r) => r.start <= "2026-10-07" && "2026-10-07" <= r.end)?.hours;
  };

  it("a key limited to P1 totals P1's hours only", async () => {
    h.ctx = key([p1]);
    expect(await periodHours()).toBe(2);
  });

  it("control: an org-wide key totals all of them", async () => {
    h.ctx = key();
    expect(await periodHours()).toBe(6);
  });
});

describe("controls: no ceiling, no change", () => {
  it("an org-wide key still reads all of its owner's time", async () => {
    h.ctx = key();
    expect(await listed()).toEqual([entry.p1, entry.p2, entry.none].sort());
    expect(await byId(entry.p2)).toBe(200);
    expect(await toolIds(key())).toEqual([entry.p1, entry.p2, entry.none].sort());
    expect(await feedIds()).toEqual([entry.p1, entry.p2, entry.none].sort());
  });

  it("a signed-in member keeps the person-scoped rule", async () => {
    h.ctx = session();
    expect(await listed()).toEqual([entry.p1, entry.p2, entry.none].sort());
    expect(await byId(entry.none)).toBe(200);
  });
});
