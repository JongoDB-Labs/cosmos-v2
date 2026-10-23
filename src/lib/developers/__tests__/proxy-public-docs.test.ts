import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: vi.fn() } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";

const anon = (path: string) => proxy(new NextRequest(new URL(path, "http://localhost:3000")));

afterEach(() => { delete process.env.COSMOS_PUBLIC_API_DOCS; });

describe("proxy: who may read /developers and the spec", () => {
  it.each(["/developers", "/developers/guides/errors", "/developers/llms.txt"])(
    "%s needs a session by default",
    async (path) => {
      const res = await anon(path);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
    },
  );

  it("the spec is a 401 by default", async () => {
    expect((await anon("/api/v1/openapi.json")).status).toBe(401);
  });

  it.each(["/developers", "/developers/reference", "/developers/changelog/rss.xml", "/api/v1/openapi.json"])(
    "%s is public with COSMOS_PUBLIC_API_DOCS=true",
    async (path) => {
      process.env.COSMOS_PUBLIC_API_DOCS = "true";
      const res = await anon(path);
      expect(res.status).toBe(200);
    },
  );

  it("the flag opens nothing else", async () => {
    process.env.COSMOS_PUBLIC_API_DOCS = "true";
    expect((await anon("/developers-not")).status).toBe(307);
    expect((await anon("/api/v1/orgs")).status).toBe(401);
    expect((await anon("/api/v1/openapi.jsonx")).status).toBe(401);
  });

  it("only the exact value turns it on", async () => {
    process.env.COSMOS_PUBLIC_API_DOCS = "1";
    expect((await anon("/developers")).status).toBe(307);
  });
});
