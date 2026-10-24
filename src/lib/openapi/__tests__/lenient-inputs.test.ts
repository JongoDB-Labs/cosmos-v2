// @vitest-environment node
//
// Inputs these routes accepted before they had contracts keep working (ops'
// review of #1128): audit-log paging clamps instead of refusing, a KPI data
// point's recordedAt is coerced, and date filters take anything Date.parse
// reads. Driven through parseRequest with the real contracts.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { parseRequest } from "../respond";
import { handleApiError } from "@/lib/api-helpers";
import { listAuditLogs } from "@/app/api/v1/orgs/[orgId]/audit-logs/route.contract";
import { listTimeEntries } from "@/app/api/v1/orgs/[orgId]/time-entries/route.contract";
import { createKpiDataPoint } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/kpis/[kpiId]/data-points/route.contract";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

const get = (path: string) => new NextRequest(`http://localhost/api/v1/orgs/${ORG}${path}`);
const audit = (qs: string) => parseRequest(listAuditLogs, get(`/audit-logs?${qs}`), Promise.resolve({ orgId: ORG }));
/** The status a route's catch would answer with. */
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => handleApiError(e).status);

describe("audit-log paging clamps, as before contracts", () => {
  it.each([
    ["limit=1000", { limit: 200, page: 1 }],
    ["limit=0", { limit: 1, page: 1 }],
    ["limit=-5&page=-3", { limit: 1, page: 1 }],
    ["limit=2.7&page=3.9", { limit: 2, page: 3 }],
    ["", { limit: 50, page: 1 }],
  ])("?%s reads as %o", async (qs, want) => {
    expect((await audit(qs)).query).toMatchObject(want);
  });

  it("a limit that isn't a number is a 400 (it used to reach Prisma as NaN)", async () => {
    expect(await status(audit("limit=abc"))).toBe(400);
  });
});

describe("date filters take anything Date.parse reads", () => {
  it.each(["2026-11-01", "2026-11-01T10:00:00", "2026-11-01T10:00:00Z", "2026-11-01T10:00:00+02:00", "Nov 1, 2026"])(
    "startDate=%s is accepted on both lists",
    async (d) => {
      const q = `startDate=${encodeURIComponent(d)}&endDate=${encodeURIComponent(d)}`;
      expect((await audit(q)).query.startDate).toBe(d);
      const t = await parseRequest(listTimeEntries, get(`/time-entries?${q}`), Promise.resolve({ orgId: ORG }));
      expect(t.query.endDate).toBe(d);
    },
  );

  it("a string Date.parse can't read is a 400", async () => {
    expect(await status(audit("startDate=nope"))).toBe(400);
  });
});

describe("a KPI data point's recordedAt is coerced", () => {
  const post = (body: unknown) =>
    parseRequest(
      createKpiDataPoint,
      new NextRequest(`http://localhost/x`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
      Promise.resolve({ orgId: ORG, projectId: ID, kpiId: ID }),
    );

  it("epoch milliseconds work", async () => {
    const { body } = await post({ value: 3, recordedAt: Date.UTC(2026, 10, 1) });
    expect(body.recordedAt).toEqual(new Date(Date.UTC(2026, 10, 1)));
  });

  it("an offset-less datetime works", async () => {
    const { body } = await post({ value: 3, recordedAt: "2026-11-01T10:00:00" });
    expect(body.recordedAt).toBeInstanceOf(Date);
  });

  it("omitted is still fine, and garbage is a 400", async () => {
    expect((await post({ value: 3 })).body.recordedAt).toBeUndefined();
    expect(await status(post({ value: 3, recordedAt: "nope" }))).toBe(400);
  });
});
