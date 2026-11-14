// @vitest-environment node
//
// The @-mention typeahead runs the same entity search as the ⌘K palette, the
// fan-out over every entity type, and it had no rate limit, so it was a way
// around the palette's. Both now draw from one budget per person.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { getAuthContext, requirePermission, searchEntities, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requirePermission: vi.fn(),
  searchEntities: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rbac/check", () => ({ requirePermission }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/mentions/registry.server", () => ({ searchEntities }));

import { GET } from "./route";
import { GET as palette } from "../../search/route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

const mention = (q = "road") =>
  GET(new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/mentions/search?q=${q}&perType=15`), { params });
const paletteSearch = () =>
  palette(new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/search?q=road`), { params });
/** Each test is its own person, so no other test's requests are in its bucket. */
const as = (userId: string) => getAuthContext.mockResolvedValue({ userId, orgId: ORG_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  searchEntities.mockResolvedValue([]);
  // The bucket refills with Date.now(); a slow run would earn tokens back
  // mid-test. Frozen, 31 requests are 31 requests.
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /mentions/search is rate-limited", () => {
  it("control: typing that stays under the limit is answered, every time", async () => {
    as("typist");
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await mention()).status);
    expect(statuses).toEqual(Array(20).fill(200));
    expect(searchEntities).toHaveBeenCalledTimes(20);
  });

  it("a burst of 30, then 429 before the search runs; a second later, three more", async () => {
    as("burst");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await mention()).status);
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(200));
    expect(statuses[30]).toBe(429);
    expect(searchEntities).toHaveBeenCalledTimes(30);
    const limited = await mention();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1");

    vi.setSystemTime(Date.now() + 1000);
    const after: number[] = [];
    for (let i = 0; i < 4; i++) after.push((await mention()).status);
    expect(after).toEqual([200, 200, 200, 429]);

    // Another person's bucket is their own.
    as("someone-else");
    expect((await mention()).status).toBe(200);
  });

  it("shares the palette's budget: 20 palette searches and 10 mentions spend it, then both are refused", async () => {
    as("both-doors");
    for (let i = 0; i < 20; i++) expect((await paletteSearch()).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await mention()).status).toBe(200);
    expect((await mention()).status).toBe(429);
    expect((await paletteSearch()).status).toBe(429);
    expect(searchEntities).toHaveBeenCalledTimes(30);
  });

  it("an empty query costs nothing and is not counted", async () => {
    as("empty");
    for (let i = 0; i < 40; i++) expect((await mention("%20")).status).toBe(200);
    expect(searchEntities).not.toHaveBeenCalled();
    expect((await mention()).status).toBe(200);
  });
});
