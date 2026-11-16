// @vitest-environment node
//
// The Agile overlay says what it returns, and returns only that. The loader is
// mocked here so the route's own job is what is tested: the declared shape
// passes, and anything beside it fails loudly outside production instead of
// reaching the calendar unannounced. That the real loader's rows fit this shape
// is pinned in agile.db.test.ts.
import { describe, it, expect, vi, beforeEach, expectTypeOf } from "vitest";
import { NextRequest } from "next/server";
import type { z } from "zod";
import type { AgilePayload as Payload } from "@/lib/program-calendar/overlays";
import type { AgilePayload as PayloadSchema } from "@/lib/openapi/schemas/program-calendar";

const h = vi.hoisted(() => ({
  ctx: { orgId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", orgRole: "MEMBER" },
  load: vi.fn<(ctx: unknown, window: { from: Date; to: Date; projectId?: string }) => Promise<unknown>>(),
}));

vi.mock("@/lib/openapi/org-context", () => ({
  orgContext: vi.fn(async () => ({ org: { slug: "o" }, ctx: h.ctx })),
}));
vi.mock("@/lib/program-calendar/agile.server", () => ({ loadAgileOverlay: h.load }));

import { GET } from "./route";
import { listAgileOverlay } from "./route.contract";

const ORG = h.ctx.orgId;
const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/x?${qs}`), { params: Promise.resolve({ orgId: ORG }) });
const WINDOW = "from=2027-03-01T00:00:00.000Z&to=2027-04-12T00:00:00.000Z";

const PAYLOAD: Payload = {
  intervals: [{
    id: "i1", name: "Increment 1", kind: "PROGRAM_INCREMENT",
    startDate: "2027-03-01T00:00:00.000Z", endDate: "2027-03-26T00:00:00.000Z",
    projectKey: "WEB", projectName: "Web",
  }],
  due: [{ id: "w1", key: "WEB-12", title: "Ship it", dueDate: "2027-03-10T00:00:00.000Z", resolved: false }],
  dueCapped: false,
};

beforeEach(() => {
  h.load.mockReset();
  h.load.mockResolvedValue(PAYLOAD);
});

describe("the Agile overlay answers with the shape it declares", () => {
  it("declares the payload, not a placeholder", () => {
    const schema = listAgileOverlay.responses[200];
    expect(schema.safeParse(PAYLOAD).success).toBe(true);
    expect(schema.safeParse("a string").success).toBe(false);
  });

  it("the declared shape and the type the calendar reads are the same type", () => {
    expectTypeOf<z.infer<typeof PayloadSchema>>().toEqualTypeOf<Payload>();
  });

  it("answers 200 with the loader's payload, unchanged", async () => {
    const res = await call(WINDOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PAYLOAD);
  });

  it("a field the contract does not declare is a 500, not a silent extra", async () => {
    h.load.mockResolvedValue({ ...PAYLOAD, due: [{ ...PAYLOAD.due[0], assigneeEmail: "someone" }] });
    const res = await call(WINDOW);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("someone");
  });

  it("a declared field gone missing is a 500 too", async () => {
    const without: Partial<Payload> = { ...PAYLOAD };
    delete without.dueCapped;
    h.load.mockResolvedValue(without);
    expect((await call(WINDOW)).status).toBe(500);
  });

  it("control: a window it refuses never reaches the loader", async () => {
    expect((await call("from=2027-03-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z")).status).toBe(400);
    expect(h.load).not.toHaveBeenCalled();
  });
});
