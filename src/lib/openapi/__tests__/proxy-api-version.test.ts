import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique } } }));
vi.mock("@/lib/cutover/freeze", () => ({
  isMutatingMethod: () => false,
  isPathOrgFrozen: async () => false,
}));

import { proxy } from "@/proxy";
import { API_VERSION, API_VERSION_HEADER, SUPPORTED_API_VERSIONS } from "../version";

const signedIn = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, "http://localhost:3000"), { headers: { cookie: "session=s1", ...headers } });

const OLD = "2026-01-01";
const RETIRED = "2025-01-01";

beforeEach(() => {
  findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000) });
  SUPPORTED_API_VERSIONS[OLD] = { deprecatedAt: "2026-11-01", sunsetAt: "2099-01-01" };
  SUPPORTED_API_VERSIONS[RETIRED] = { deprecatedAt: "2025-06-01", sunsetAt: "2026-06-01" };
});
afterEach(() => {
  delete SUPPORTED_API_VERSIONS[OLD];
  delete SUPPORTED_API_VERSIONS[RETIRED];
});

describe("proxy: Cosmos-API-Version", () => {
  it("echoes a current version and lets the request through", async () => {
    const res = await proxy(signedIn("/api/v1/me", { [API_VERSION_HEADER]: API_VERSION }));
    expect(res.status).toBe(200);
    expect(res.headers.get(API_VERSION_HEADER)).toBe(API_VERSION);
    expect(res.headers.get("deprecation")).toBeNull();
  });

  it("announces a deprecated version's retirement", async () => {
    const res = await proxy(signedIn("/api/v1/me", { [API_VERSION_HEADER]: OLD }));
    expect(res.status).toBe(200);
    expect(res.headers.get("deprecation")).toMatch(/^@\d+$/);
    expect(res.headers.get("sunset")).toContain("2099");
    expect(res.headers.get("link")).toContain(`/developers/changelog#${OLD}`);
  });

  it.each([
    ["a retired version", RETIRED, 410],
    ["a date that was never a version", "2024-02-30", 400],
    ["garbage", "latest", 400],
  ])("refuses %s with a problem, before auth", async (_n, v, status) => {
    const res = await proxy(signedIn("/api/v1/me", { [API_VERSION_HEADER]: v }));
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ code: "unsupported_api_version" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("only applies to /api/v1", async () => {
    const res = await proxy(signedIn("/api/health", { [API_VERSION_HEADER]: "latest" }));
    expect(res.status).toBe(200);
    expect(res.headers.get(API_VERSION_HEADER)).toBeNull();
  });

  it("a request naming no version gets no echo (its token's pin is the route's to resolve)", async () => {
    const res = await proxy(signedIn("/api/v1/me"));
    expect(res.headers.get(API_VERSION_HEADER)).toBeNull();
  });
});
