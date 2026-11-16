// Routes that serve a stored file choose its Content-Security-Policy
// themselves: src/lib/files/serve.ts sandboxes HTML, SVG and XML, and the org
// logo is always sandboxed. The proxy sets the app's page CSP on every
// response, and a header the proxy sets REPLACES the route's. So those routes'
// sandbox never reached a browser, and an HTML file opened from the library ran
// its script on the app's origin, under the page CSP's 'unsafe-inline'.
//
// On those paths the proxy now leaves the CSP to the route. Everywhere else
// the page CSP is unchanged, and the other security headers stay everywhere.
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

vi.mock("@/lib/db/client", () => ({
  prisma: {
    session: { findUnique: vi.fn(async () => ({ expiresAt: new Date(Date.now() + 60_000) })) },
    // No org: each stored-file route's first refusal.
    organization: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";
import { routeSetsOwnCsp } from "@/lib/security/headers";

const signedIn = (path: string, method = "GET") =>
  proxy(
    new NextRequest(new URL(path, "http://localhost:3000"), {
      method,
      headers: { host: "localhost:3000", origin: "http://localhost:3000", cookie: "session=s" },
    }),
  );

const STORED_FILES = [
  "/api/v1/orgs/o1/logo",
  "/api/v1/orgs/o1/documents/d1/original",
  "/api/v1/orgs/o1/projects/p1/documents/d1/original",
];

describe("the proxy and stored files", () => {
  // A header the proxy sets wins over the route's (Next adds a route header
  // only when the proxy has not set it), so the proxy must leave out whatever
  // the route decides: the CSP, and on a GET the framing (a PDF is previewed
  // in a frame on this site; see serveHeaders).
  it.each(STORED_FILES)("leaves %s's CSP and framing to the route, and keeps the other headers", async (path) => {
    const res = await signedIn(path);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps DENY on anything else sent to a stored-file path", async () => {
    // A write is not a file being served.
    expect((await signedIn("/api/v1/orgs/o1/logo", "POST")).headers.get("x-frame-options")).toBe("DENY");
    // The proxy's own refusal never reaches the route.
    const signedOut = await proxy(
      new NextRequest(new URL(STORED_FILES[1], "http://localhost:3000"), { headers: { host: "localhost:3000" } }),
    );
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("x-frame-options")).toBe("DENY");
  });

  it.each(["/acme/issues", "/acme/files", "/login", "/api/v1/orgs/o1/documents", "/api/v1/orgs/o1/documents/d1"])(
    "keeps DENY on %s",
    async (path) => {
      expect((await signedIn(path)).headers.get("x-frame-options")).toBe("DENY");
    },
  );

  it.each([
    "/acme/issues",
    "/api/v1/orgs/o1/documents",
    "/api/v1/orgs/o1/documents/d1",
    "/api/v1/orgs/o1/logo/extra",
    "/api/v1/orgs/o1/chat/attachments/a1",
  ])("positive control: %s still gets the page CSP", async (path) => {
    const res = await signedIn(path);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});

/** URL path for a route file, with each dynamic segment as `x`. */
function urlOf(file: string): string {
  const rel = relative(join(process.cwd(), "src", "app"), file).split(sep).slice(0, -1);
  return "/" + rel.filter((s) => !/^\(.*\)$/.test(s)).map((s) => (/^\[.*\]$/.test(s) ? "x" : s)).join("/");
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("every route that sets its own CSP is one the proxy leaves alone", () => {
  // A new route that serves stored files with serveHeaders, or sets a CSP of
  // its own, would otherwise have it silently replaced.
  const own = routeFiles(join(process.cwd(), "src", "app")).filter((f) =>
    /serveHeaders\(|Content-Security-Policy|LOGO_CSP/.test(readFileSync(f, "utf8")),
  );

  it("finds the known ones (positive control)", () => {
    expect(own.map(urlOf)).toEqual(
      expect.arrayContaining(["/api/v1/orgs/x/logo", "/api/v1/orgs/x/documents/x/original"]),
    );
  });

  it("each is covered", () => {
    expect(own.map(urlOf).filter((u) => !routeSetsOwnCsp(u))).toEqual([]);
  });

  // The proxy leaves a GET's framing to these routes, so each must state it on
  // every answer, not only on a file: a refusal still says DENY.
  it("each answers a GET it refuses with DENY", async () => {
    expect(own.length).toBeGreaterThanOrEqual(3);
    for (const file of own) {
      const route = (await import(file)) as {
        GET: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
      };
      const res = await route.GET(new NextRequest(new URL(urlOf(file), "http://localhost:3000")), {
        params: Promise.resolve({ orgId: "o1", projectId: "p1", docId: "d1" }),
      });
      expect(res.status, urlOf(file)).toBe(404);
      expect(res.headers.get("x-frame-options"), urlOf(file)).toBe("DENY");
    }
  });
});
