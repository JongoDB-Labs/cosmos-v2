// @vitest-environment node
//
// These routes answer with a BARE array, and the calendar client reads it as
// one.
//
// `success()` sends whatever it is given — some routes in this codebase
// deliberately wrap (`success({ data, total })`) and their clients read
// `.data`. Both shapes are legitimate, so there is no codebase-wide rule to
// lean on; what matters is that each route and its client agree.
//
// This pair did not. The client declared `jsonFetch<{ data: ApiEvent[] }>` and
// read `.data` from a bare array, so every query resolved to `undefined`. The
// generic on `jsonFetch<T>` is an ASSERTION, not a check — it type-checked
// cleanly, the route returned a correct 200 with ten events in it, and the
// calendar rendered empty. Only loading the page in a browser showed it.
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  ctx: { orgId: "11111111-1111-4111-8111-111111111111", userId: "u", orgRole: "ADMIN" },
  rows: [{ id: "e1", title: "An event" }],
  cats: [{ id: "c1", name: "Cat" }],
}));

vi.mock("@/lib/openapi/org-context", () => ({
  orgContext: vi.fn(async () => ({ org: { slug: "o" }, ctx: h.ctx })),
}));
vi.mock("@/lib/rbac/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rbac/check")>()),
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/program-calendar/service", () => ({
  listProgramEvents: vi.fn(async () => h.rows),
  createProgramEvent: vi.fn(),
  listCategories: vi.fn(async () => h.cats),
  categoryCounts: vi.fn(async () => ({ c1: 3 })),
}));

import { GET as listEvents } from "./route";
import { GET as listCategoriesRoute } from "../event-categories/route";

const ORG = h.ctx.orgId;
const req = (qs: string) => new NextRequest(`http://localhost/x?${qs}`);
const WINDOW = "from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z";

describe("the program-calendar routes answer with a bare array", () => {
  it("events is an array, not an object carrying `data`", async () => {
    const res = await listEvents(req(WINDOW), { params: Promise.resolve({ orgId: ORG }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // The specific mistake, stated as a negative so it cannot creep back: a
    // `data` key here means the client's `.data` read would be the correct one
    // and THIS test is what is out of date.
    expect(body).not.toHaveProperty("data");
    expect(body[0].id).toBe("e1");
  });

  it("categories is an array too, and carries its counts inline", async () => {
    const res = await listCategoriesRoute(req(WINDOW), { params: Promise.resolve({ orgId: ORG }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).not.toHaveProperty("data");
    expect(body[0]).toMatchObject({ id: "c1", count: 3 });
  });
});
