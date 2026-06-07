// scripts/cutover/lib/proxy-control.test.ts
//
// Pure unit tests for the cutover reverse-proxy control:
//   - the config-patch BUILDERS (the freeze/flip route JSON) against a captured Caddy shape
//   - the state codec (buildRoutes ⇄ decodeState round-trip — the idempotency backbone)
//   - the pure state transitions (freeze/unfreeze/setUpstream are idempotent + independent)
//   - the ProxyControl client driving a MOCKED admin HTTP (no live Caddy): freeze/flip/rollback
//     each read→transform→POST /load the FULL config with exactly the expected routes.
// These encode the HARD INVARIANTS: freeze routes precede upstream routes; reads never 405;
// a frozen org's writes 405 with the Allow header; an un-flipped org always lands on v1.

import { describe, it, expect } from "vitest";
import {
  buildFreezeRoute,
  buildUpstreamRoute,
  buildFallbackRoute,
  buildRoutes,
  buildCaddyConfig,
  decodeState,
  orgPathPatterns,
  frozenBody,
  applyFreeze,
  applyUnfreeze,
  applySetUpstream,
  ProxyControl,
  type ProxyState,
  type Upstreams,
  type CaddyRoute,
} from "./proxy-control";

const UPSTREAMS: Upstreams = { v1: "v1-stub:80", v2: "v2-stub:80" };

/** Typed accessor for the cutover http server out of a config object (avoids `any` in tests). */
function cutoverServer(config: Record<string, unknown>): { listen: unknown; routes: CaddyRoute[] } {
  const apps = config.apps as Record<string, unknown>;
  const http = apps.http as Record<string, unknown>;
  const servers = http.servers as Record<string, unknown>;
  const server = servers.cutover as { listen: unknown; routes: CaddyRoute[] };
  return server;
}

describe("orgPathPatterns — the slug path matcher", () => {
  it("matches the bare /slug AND everything under /slug/", () => {
    expect(orgPathPatterns("tenant")).toEqual(["/tenant", "/tenant/*"]);
  });
});

describe("buildFreezeRoute — the 405 write-freeze route", () => {
  const r = buildFreezeRoute("tenant");

  it("matches ONLY mutating methods on the org's path (reads fall through)", () => {
    expect(r.match).toEqual([
      { path: ["/tenant", "/tenant/*"], method: ["POST", "PUT", "PATCH", "DELETE"] },
    ]);
    // GET/HEAD/OPTIONS are deliberately absent ⇒ a read never matches the freeze route.
    const methods = (r.match?.[0] as { method: string[] }).method;
    for (const read of ["GET", "HEAD", "OPTIONS"]) expect(methods).not.toContain(read);
  });

  it("responds 405 with an Allow header advertising reads + a JSON org_frozen body", () => {
    const h = r.handle[0] as Record<string, unknown>;
    expect(h.handler).toBe("static_response");
    expect(h.status_code).toBe(405);
    expect((h.headers as Record<string, string[]>).Allow).toEqual(["GET, HEAD, OPTIONS"]);
    expect((h.headers as Record<string, string[]>)["Content-Type"]).toEqual(["application/json"]);
    expect(JSON.parse(h.body as string)).toMatchObject({ error: "org_frozen", org: "tenant" });
  });

  it("is terminal (short-circuits before any upstream route)", () => {
    expect(r.terminal).toBe(true);
  });
});

describe("buildUpstreamRoute — the per-org flip route", () => {
  it("routes the org's path to the given dial + records the logical upstream", () => {
    const r = buildUpstreamRoute("tenant", "v2-stub:80", "v2");
    expect(r.match).toEqual([{ path: ["/tenant", "/tenant/*"] }]);
    const h = r.handle[0] as Record<string, unknown>;
    expect(h.handler).toBe("reverse_proxy");
    expect(h.upstreams).toEqual([{ dial: "v2-stub:80" }]);
    expect(r.terminal).toBe(true);
    expect((r as Record<string, unknown>)._cutover_upstream).toBe("v2");
  });
});

describe("buildFallbackRoute — the catch-all → v1", () => {
  it("has NO matcher and proxies to the default dial", () => {
    const r = buildFallbackRoute("v1-stub:80");
    expect(r.match).toBeUndefined();
    expect((r.handle[0] as Record<string, unknown>).upstreams).toEqual([{ dial: "v1-stub:80" }]);
  });
});

describe("buildRoutes — ordering + minimality invariants", () => {
  it("empty state ⇒ ONLY the fallback (everyone on v1)", () => {
    const routes = buildRoutes({}, UPSTREAMS);
    expect(routes).toHaveLength(1);
    expect(routes[0]["@id"]).toBe("fallback_v1");
  });

  it("an org on the default v1 upstream needs NO upstream route (fallback serves it)", () => {
    const state: ProxyState = { tenant: { upstream: "v1", frozen: false } };
    const ids = buildRoutes(state, UPSTREAMS).map((r) => r["@id"]);
    expect(ids).toEqual(["fallback_v1"]);
  });

  it("FREEZE routes always precede UPSTREAM routes precede the FALLBACK", () => {
    const state: ProxyState = {
      tenant: { upstream: "v2", frozen: true },
      beta: { upstream: "v2", frozen: false },
    };
    const ids = buildRoutes(state, UPSTREAMS).map((r) => r["@id"]);
    // freeze first (only tenant is frozen), then both v2 upstream routes (sorted), then fallback.
    expect(ids).toEqual(["freeze_tenant", "upstream_beta", "upstream_tenant", "fallback_v1"]);
  });

  it("is deterministic (slug-sorted) so POST /load is idempotent", () => {
    const a: ProxyState = { zeta: { upstream: "v2", frozen: true }, alpha: { upstream: "v2", frozen: true } };
    const ids = buildRoutes(a, UPSTREAMS).map((r) => r["@id"]);
    expect(ids).toEqual(["freeze_alpha", "freeze_zeta", "upstream_alpha", "upstream_zeta", "fallback_v1"]);
  });
});

describe("buildCaddyConfig / decodeState — the FULL config round-trip", () => {
  it("builds admin + one cutover http server with the derived routes", () => {
    const cfg = buildCaddyConfig({
      state: { tenant: { upstream: "v2", frozen: true } },
      upstreams: UPSTREAMS,
      adminListen: "0.0.0.0:2019",
    });
    expect((cfg.admin as Record<string, unknown>).listen).toBe("0.0.0.0:2019");
    const server = cutoverServer(cfg);
    expect(server.listen).toEqual([":80"]);
    expect(server.routes.length).toBe(3); // freeze + upstream + fallback
  });

  it("decodeState is the exact inverse of buildRoutes (frozen + flipped survive a round-trip)", () => {
    const state: ProxyState = {
      tenant: { upstream: "v2", frozen: true },
      beta: { upstream: "v1", frozen: true },
      gamma: { upstream: "v2", frozen: false },
    };
    const cfg = buildCaddyConfig({ state, upstreams: UPSTREAMS, adminListen: "localhost:2019" });
    const decoded = decodeState(cfg);
    expect(decoded).toEqual({
      tenant: { upstream: "v2", frozen: true },
      beta: { upstream: "v1", frozen: true },
      gamma: { upstream: "v2", frozen: false },
    });
  });

  it("an org with no routes decodes to the default (v1, unfrozen)", () => {
    const cfg = buildCaddyConfig({ state: {}, upstreams: UPSTREAMS, adminListen: "localhost:2019" });
    expect(decodeState(cfg)).toEqual({});
  });
});

describe("pure state transitions — idempotent + independent", () => {
  it("freeze/unfreeze preserve the upstream", () => {
    let s: ProxyState = {};
    s = applySetUpstream(s, "tenant", "v2");
    s = applyFreeze(s, "tenant");
    expect(s.tenant).toEqual({ upstream: "v2", frozen: true });
    s = applyUnfreeze(s, "tenant");
    expect(s.tenant).toEqual({ upstream: "v2", frozen: false });
  });

  it("setUpstream preserves the frozen flag", () => {
    let s: ProxyState = applyFreeze({}, "tenant");
    s = applySetUpstream(s, "tenant", "v2");
    expect(s.tenant).toEqual({ upstream: "v2", frozen: true });
  });

  it("re-applying the same transition is a no-op (idempotent)", () => {
    const s1 = applyFreeze({}, "tenant");
    const s2 = applyFreeze(s1, "tenant");
    expect(s2.tenant).toEqual(s1.tenant);
  });

  it("transitions touch only the named org (other orgs untouched)", () => {
    let s: ProxyState = { other: { upstream: "v1", frozen: false } };
    s = applyFreeze(s, "tenant");
    s = applySetUpstream(s, "tenant", "v2");
    expect(s.other).toEqual({ upstream: "v1", frozen: false });
  });
});

describe("frozenBody", () => {
  it("is stable parseable JSON naming the org + the org_frozen error", () => {
    expect(JSON.parse(frozenBody("tenant"))).toMatchObject({ error: "org_frozen", org: "tenant" });
  });
});

// ── ProxyControl client over a MOCKED admin HTTP (no live Caddy) ─────────────────────────

/**
 * A tiny in-memory Caddy admin mock: serves GET /config/ from a held config and applies
 * POST /load by replacing it. Returns { control, getState, calls } so a test can drive the
 * client and assert both the resulting state AND that each op did exactly one read + one load.
 */
function mockCaddy(initial: Record<string, unknown>) {
  let config = initial;
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url: u });
    if (u.endsWith("/config/") && method === "GET") {
      return new Response(JSON.stringify(config), { status: 200 });
    }
    if (u.endsWith("/load") && method === "POST") {
      config = JSON.parse(init!.body as string);
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const control = new ProxyControl({ adminUrl: "http://proxy:2019", upstreams: UPSTREAMS, fetchImpl });
  return { control, getConfig: () => config, getState: () => decodeState(config), calls };
}

const BASE = buildCaddyConfig({ state: {}, upstreams: UPSTREAMS, adminListen: "0.0.0.0:2019" });

describe("ProxyControl client (mocked admin HTTP)", () => {
  it("getOrgState returns the default for an unknown org", async () => {
    const { control } = mockCaddy(BASE);
    expect(await control.getOrgState("tenant")).toEqual({ upstream: "v1", frozen: false });
  });

  it("freezeOrg adds the org's freeze route (write-freeze) and keeps it on v1", async () => {
    const { control, getState, getConfig } = mockCaddy(BASE);
    await control.freezeOrg("tenant");
    expect(getState().tenant).toEqual({ upstream: "v1", frozen: true });
    // a freeze route is present and precedes the fallback
    const ids = cutoverServer(getConfig()).routes.map((r) => r["@id"]);
    expect(ids).toContain("freeze_tenant");
    expect(ids.indexOf("freeze_tenant")).toBeLessThan(ids.indexOf("fallback_v1"));
  });

  it("setOrgUpstream(v2) flips the org to v2 (idempotent on re-apply)", async () => {
    const { control, getState } = mockCaddy(BASE);
    await control.setOrgUpstream("tenant", "v2");
    expect(getState().tenant).toEqual({ upstream: "v2", frozen: false });
    await control.setOrgUpstream("tenant", "v2"); // idempotent
    expect(getState().tenant).toEqual({ upstream: "v2", frozen: false });
  });

  it("the full freeze→flip→unfreeze sequence yields v2 + unfrozen", async () => {
    const { control, getState } = mockCaddy(BASE);
    await control.freezeOrg("tenant");
    await control.setOrgUpstream("tenant", "v2");
    await control.unfreezeOrg("tenant");
    expect(getState().tenant).toEqual({ upstream: "v2", frozen: false });
  });

  it("ROLLBACK (setUpstream v1 + unfreeze) returns a half-flipped org to v1 + unfrozen", async () => {
    const { control } = mockCaddy(BASE);
    await control.freezeOrg("tenant");
    // ... a failure occurs before/at flip; rollback:
    await control.setOrgUpstream("tenant", "v1");
    await control.unfreezeOrg("tenant");
    // back to the v1/unfrozen default ⇒ no routes ⇒ observed via getOrgState (the orchestrator's view).
    expect(await control.getOrgState("tenant")).toEqual({ upstream: "v1", frozen: false });
  });

  it("never touches another org (cutting tenant leaves other on v1)", async () => {
    const { control, getState } = mockCaddy(buildCaddyConfig({
      state: { other: { upstream: "v1", frozen: false } },
      upstreams: UPSTREAMS,
      adminListen: "0.0.0.0:2019",
    }));
    await control.freezeOrg("tenant");
    await control.setOrgUpstream("tenant", "v2");
    await control.unfreezeOrg("tenant");
    // "other" is on the default v1 upstream + unfrozen ⇒ it needs NO routes (minimal config),
    // so it decodes to absent — which getOrgState coalesces to the v1/unfrozen default. Asserting
    // via getOrgState proves the invariant the way the orchestrator actually observes it.
    expect(await control.getOrgState("other")).toEqual({ upstream: "v1", frozen: false });
    expect(getState().tenant).toEqual({ upstream: "v2", frozen: false });
  });

  it("each mutation does exactly one GET /config/ + one POST /load", async () => {
    const { control, calls } = mockCaddy(BASE);
    await control.freezeOrg("tenant");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("preserves the admin + http listen addresses across a mutation", async () => {
    const { control, getConfig } = mockCaddy(BASE);
    await control.freezeOrg("tenant");
    expect((getConfig().admin as Record<string, unknown>).listen).toBe("0.0.0.0:2019");
    expect(cutoverServer(getConfig()).listen).toEqual([":80"]);
  });

  it("throws on a non-OK admin response (fail-closed)", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const control = new ProxyControl({ adminUrl: "http://proxy:2019", upstreams: UPSTREAMS, fetchImpl });
    await expect(control.getOrgState("tenant")).rejects.toThrow(/GET \/config\/ failed 500/);
  });
});
