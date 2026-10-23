// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ userContext: vi.fn() }));
vi.mock("@/lib/openapi/user-context", () => ({ userContext: h.userContext }));
vi.mock("@/lib/telemetry/server", () => ({ serverReportError: vi.fn() }));

import { GET } from "../route";
import { ProblemError } from "@/lib/openapi/problem";

const get = (q = "") => GET(new NextRequest(`http://localhost/api/v1/openapi.json${q}`));
type Doc = { info: { title: string }; paths: Record<string, unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  h.userContext.mockResolvedValue({ userId: "u1", apiVersion: "2026-11-01" });
});
afterEach(() => { delete process.env.COSMOS_PUBLIC_API_DOCS; });

describe("GET /api/v1/openapi.json", () => {
  it("serves exactly the committed public spec", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const committed = JSON.parse(readFileSync(join(process.cwd(), "openapi/cosmos-v1.json"), "utf8"));
    expect(await res.json()).toEqual(committed);
  });

  it("verifies the caller unless the docs are public", async () => {
    h.userContext.mockRejectedValue(new ProblemError(401, "unauthorized"));
    expect((await get()).status).toBe(401);
    process.env.COSMOS_PUBLIC_API_DOCS = "true";
    expect((await get()).status).toBe(200);
  });

  it("never serves the internal surface, whatever is asked", async () => {
    const doc = (await (await get("?audience=internal")).json()) as Doc;
    expect(doc.info.title).not.toContain("internal");
    expect(doc.paths["/openapi.json"]).toBeUndefined();
  });
});
