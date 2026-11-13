// @vitest-environment node
//
// Whose calendar the Outlook overlay reads is the session's user, and nothing a
// request carries can change that. The service is mocked here so the route's
// own choice is what is tested: the person it asks for.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  ctx: { orgId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", orgRole: "MEMBER" },
  load: vi.fn<(orgId: string, userId: string, window: { from: Date; to: Date }) => Promise<unknown>>(async () => ({
    status: "connected", events: [], capped: false,
  })),
}));

vi.mock("@/lib/openapi/org-context", () => ({
  orgContext: vi.fn(async () => ({ org: { slug: "o" }, ctx: h.ctx })),
}));
vi.mock("@/lib/program-calendar/outlook.server", () => ({ loadOutlookOverlay: h.load }));

import { GET } from "./route";

const ORG = h.ctx.orgId;
const SOMEONE_ELSE = "33333333-3333-4333-8333-333333333333";
const req = (qs: string) => new NextRequest(`http://localhost/x?${qs}`);
const call = (qs: string) => GET(req(qs), { params: Promise.resolve({ orgId: ORG }) });
const WINDOW = "from=2027-03-01T00:00:00.000Z&to=2027-04-12T00:00:00.000Z";

beforeEach(() => h.load.mockClear());

describe("the Outlook overlay reads the caller's own calendar", () => {
  it("reads for the session's user, with the window asked for", async () => {
    const res = await call(WINDOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "connected", events: [], capped: false });
    expect(h.load).toHaveBeenCalledWith(ORG, h.ctx.userId, {
      from: new Date("2027-03-01T00:00:00.000Z"),
      to: new Date("2027-04-12T00:00:00.000Z"),
    });
  });

  it.each(["userId", "user", "memberId", "mailbox"])("a `%s` in the query is ignored", async (name) => {
    const res = await call(`${WINDOW}&${name}=${SOMEONE_ELSE}`);
    expect(res.status).toBe(200);
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.load.mock.calls[0][1]).toBe(h.ctx.userId);
    expect(JSON.stringify(h.load.mock.calls)).not.toContain(SOMEONE_ELSE);
  });
});

describe("the window is bounded", () => {
  it("refuses a window over 62 days, and one that ends before it starts", async () => {
    expect((await call("from=2027-03-01T00:00:00.000Z&to=2027-05-03T00:00:00.000Z")).status).toBe(400);
    expect((await call("from=2027-03-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z")).status).toBe(400);
    expect(h.load).not.toHaveBeenCalled();
  });

  it("control: exactly 62 days is answered", async () => {
    expect((await call("from=2027-03-01T00:00:00.000Z&to=2027-05-02T00:00:00.000Z")).status).toBe(200);
    expect(h.load).toHaveBeenCalledTimes(1);
  });
});
