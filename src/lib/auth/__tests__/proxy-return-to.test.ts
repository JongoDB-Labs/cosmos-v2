// A signed-out visit to a page goes to the sign-in page with the page's
// address as `?next=`, so signing in lands back on it. It used to go to a bare
// /login, and every sign-in then landed on "/".
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";

const signedOut = (path: string, headers: Record<string, string> = { host: "localhost:3000" }) =>
  proxy(new NextRequest(new URL(path, "http://localhost:3000"), { headers }));

async function loginRedirect(path: string, headers?: Record<string, string>) {
  const res = await signedOut(path, headers);
  expect(res.status).toBe(307);
  const location = new URL(res.headers.get("location")!);
  expect(location.pathname).toBe("/login");
  return location;
}

describe("proxy: signed-out page visits keep their address", () => {
  it("sends the page's path and query along as ?next=", async () => {
    const location = await loginRedirect("/acme/issues?view=list&q=open");
    expect(location.searchParams.get("next")).toBe("/acme/issues?view=list&q=open");
  });

  it("adds nothing for the home page", async () => {
    const location = await loginRedirect("/");
    expect(location.search).toBe("");
  });

  it("adds nothing for a path the return rule refuses", async () => {
    // A request line can carry a host-relative path; it must not become a return address.
    const req = new NextRequest("http://localhost:3000//elsewhere.example/acme", { headers: { host: "localhost:3000" } });
    expect(req.nextUrl.pathname).toBe("//elsewhere.example/acme");
    const res = await proxy(req);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.has("next")).toBe(false);
  });

  it("builds the sign-in address on the public origin behind the edge", async () => {
    const location = await loginRedirect("/acme/issues", {
      host: "localhost:3000",
      "x-forwarded-host": "cosmos.example.dev",
      "x-forwarded-proto": "https",
    });
    expect(location.origin).toBe("https://cosmos.example.dev");
    expect(location.searchParams.get("next")).toBe("/acme/issues");
  });

  it("still answers an API call with 401, not a redirect", async () => {
    const res = await signedOut("/api/v1/orgs/o1/projects");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });
});
