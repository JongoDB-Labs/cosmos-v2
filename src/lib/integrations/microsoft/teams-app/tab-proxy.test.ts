// COSMOS-202 T1 d: only /teams/tab pages may be framed, and only by Microsoft
// Teams' hosts; everything else keeps frame-ancestors 'none' and
// X-Frame-Options DENY. The tab cookie authenticates nothing outside the tab:
// on its own it gets a 401 from /api/v1.
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";

const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(new URL(path, "http://localhost:3000"), { method: init.method ?? "GET", headers: { host: "localhost:3000", ...init.headers } });
const frameAncestors = (res: Response) => /frame-ancestors ([^;]*)/.exec(res.headers.get("content-security-policy") ?? "")?.[1];

describe("proxy: Teams tabs", () => {
  it("lets Microsoft Teams' hosts, and only them, frame a tab page (not Outlook/Office: no tokens from those clients)", async () => {
    for (const path of ["/teams/tab", "/teams/tab/my-work", "/teams/tab/view?project=X", "/teams/tab/configure"]) {
      const res = await proxy(req(path));
      expect(res.status, path).toBe(200);
      expect(frameAncestors(res), path).toBe(
        "'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.cloud.microsoft",
      );
      expect(res.headers.get("x-frame-options"), path).toBeNull();
      // Everything else in the policy is unchanged.
      expect(res.headers.get("content-security-policy"), path).toContain("default-src 'self'");
    }
  });

  it("everything else, a longer name included, still refuses framing", async () => {
    for (const path of ["/teams/tabX", "/teams/tabs", "/teams", "/api/health", "/login", "/acme/issues"]) {
      const res = await proxy(req(path));
      expect(frameAncestors(res), path).toBe("'none'");
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
    }
  });

  it("the tab cookie on its own authenticates nothing under /api/v1", async () => {
    for (const path of ["/api/v1/me", "/api/v1/orgs/x/work-items"]) {
      const res = await proxy(req(path, { headers: { cookie: "teams_tab=v2.k.iv.tag.ct" } }));
      expect(res.status, path).toBe(401);
    }
  });

  it("the tab sign-in route is public but not CSRF-exempt: a cross-origin POST is refused, a same-origin one goes through", async () => {
    const cross = await proxy(req("/api/teams/tab/session", { method: "POST", headers: { origin: "https://evil-teams-app.example" } }));
    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ error: "csrf_blocked" });
    const same = await proxy(req("/api/teams/tab/session", { method: "POST", headers: { origin: "http://localhost:3000" } }));
    expect(same.status).toBe(200);
    expect(same.headers.get("x-middleware-next")).toBe("1");
  });

  it("tab pages take GET only: any other method is refused before it reaches them", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await proxy(req("/teams/tab/my-work", { method, headers: { cookie: "teams_tab=x", origin: "https://teams.microsoft.com" } }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    expect((await proxy(req("/teams/tab/my-work", { method: "HEAD" }))).status).toBe(200);
  });
});
