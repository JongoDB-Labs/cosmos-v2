// scripts/cutover/lib/proxy-control.ts — CUTOVER REVERSE-PROXY CONTROL (design spec §9.4).
//
// A small Caddy ADMIN-API client + the PURE config builders behind the per-tenant
// freeze / flip / rollback that the orchestrator drives. The cutover reverse proxy
// (compose/cutover-proxy/, a SEPARATE Caddy from the app's compose/Caddyfile) routes by
// orgSlug PATH PREFIX (`/<slug>/…`, the dashboard route shape) to the v1 (source, default)
// or v2 (target) backend, and enforces a per-org WRITE-FREEZE at the proxy (because the v1
// stack lacks v2's in-app freeze middleware — the freeze must be enforced at the edge).
//
// DESIGN — DESIRED-STATE, not array surgery:
//   We model the proxy's per-org state as a plain object { [slug]: { upstream, frozen } }
//   and DERIVE the full Caddy HTTP-server route list from it (buildCaddyConfig). Every
//   mutation (freezeOrg/unfreezeOrg/setOrgUpstream) reads the live config, decodes the
//   per-org state from it, applies ONE idempotent change, re-derives the full config, and
//   POSTs it back via `POST /load` (atomic, zero-downtime, auto-rollback on a bad config).
//   This is far more robust than PATCH-by-array-index (no index drift, trivially idempotent)
//   and makes the builders PURE + unit-testable without a live Caddy.
//
// ROUTE ORDER (Caddy evaluates top-down; first terminal match wins):
//   1. FREEZE routes  — one per frozen org: (mutating method ∧ that org's path) ⇒ 405
//      static_response with `Allow: GET, HEAD, OPTIONS` + a JSON `{"error":"org_frozen",…}`
//      body. Reads (GET/HEAD/OPTIONS) do NOT match ⇒ fall through to the upstream route.
//   2. UPSTREAM routes — one per org whose upstream ≠ the default (v1): that org's path ⇒
//      reverse_proxy to v2. (An org on the default upstream needs no route — the fallback
//      serves it, so the config stays minimal.)
//   3. FALLBACK route — no matcher (catch-all) ⇒ reverse_proxy to v1 (the default upstream).
//
// SLUG-vs-ID ASSUMPTION (documented): the proxy routes by the PATH TOKEN at the edge. The
// dashboard shape is `/<orgSlug>/…`, so we key on orgSlug. The API form `/api/v1/orgs/<id>/…`
// is NOT matched here (it would need an id↔slug map at the edge); the in-app freeze
// (src/lib/cutover/freeze.ts) already covers the id-keyed API path inside v2. For the cutover
// window the dashboard slug path is the surface that flips, which is what this proxy governs.
//
// BUILD-ONLY / SYNTHETIC-TEST ONLY. The orchestrator calls these under `--confirm`; never
// point the admin URL at a real production proxy without the runbook + sign-off.

export type Upstream = "v1" | "v2";

/** One org's edge state: which backend serves it, and whether its writes are frozen. */
export interface OrgState {
  upstream: Upstream;
  frozen: boolean;
}

/** The whole proxy's per-org state, keyed by orgSlug. Orgs not present default to v1/unfrozen. */
export type ProxyState = Record<string, OrgState>;

/** Backend dial targets (host:port inside the proxy's docker network). */
export interface Upstreams {
  v1: string; // default upstream (the source stack — stays live for un-flipped orgs)
  v2: string; // target upstream (an org points here only AFTER its flip)
}

/** The frozen-org 405 body (stable JSON the orchestrator/acceptance can assert on). */
export function frozenBody(slug: string): string {
  return JSON.stringify({
    error: "org_frozen",
    message:
      "This organization is temporarily read-only during a scheduled cutover. " +
      "Writes are paused; reads continue. Please retry shortly.",
    org: slug,
  });
}

// ── Caddy JSON shapes (only the fields we use) ──────────────────────────────────────────
export interface CaddyRoute {
  // An optional stable handle so a human reading the live config can see what each route is.
  "@id"?: string;
  match?: Array<Record<string, unknown>>;
  handle: Array<Record<string, unknown>>;
  terminal?: boolean;
  // Cutover-private annotations (e.g. `_cutover_upstream`) ride alongside the Caddy fields so
  // decodeState can recover the logical upstream without parsing dials.
  [key: string]: unknown;
}

/** Path matcher patterns for an org slug: the bare `/slug` AND everything under `/slug/`. */
export function orgPathPatterns(slug: string): string[] {
  return [`/${slug}`, `/${slug}/*`];
}

const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/** The FREEZE route for one org: a mutating verb on the org's path ⇒ 405 (reads fall through). */
export function buildFreezeRoute(slug: string): CaddyRoute {
  return {
    "@id": `freeze_${slug}`,
    match: [{ path: orgPathPatterns(slug), method: MUTATING_METHODS }],
    handle: [
      {
        handler: "static_response",
        status_code: 405,
        headers: {
          // RFC 7231: the methods still allowed on a frozen org (reads only).
          Allow: ["GET, HEAD, OPTIONS"],
          "Content-Type": ["application/json"],
          "Retry-After": ["30"],
        },
        body: frozenBody(slug),
      },
    ],
    terminal: true,
  };
}

/** The UPSTREAM route for one org pinned to a non-default backend (post-flip → v2). */
export function buildUpstreamRoute(slug: string, dial: string, upstream: Upstream): CaddyRoute {
  return {
    "@id": `upstream_${slug}`,
    match: [{ path: orgPathPatterns(slug) }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial }] }],
    terminal: true,
    // Record the logical upstream so getOrgState can decode it back without parsing dials.
    _cutover_upstream: upstream,
  };
}

/** The catch-all FALLBACK route ⇒ the default upstream (v1). */
export function buildFallbackRoute(dial: string): CaddyRoute {
  return {
    "@id": "fallback_v1",
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial }] }],
    terminal: true,
  };
}

/**
 * Derive the ORDERED route list for the cutover HTTP server from the per-org state.
 * Order: all FREEZE routes, then all non-default UPSTREAM routes, then the FALLBACK. Slugs are
 * sorted so the output is DETERMINISTIC (stable config ⇒ idempotent POST /load, clean diffs).
 */
export function buildRoutes(state: ProxyState, upstreams: Upstreams): CaddyRoute[] {
  const slugs = Object.keys(state).sort();
  const routes: CaddyRoute[] = [];
  // 1. freeze routes (must precede upstream routes so a frozen write 405s before proxying)
  for (const slug of slugs) {
    if (state[slug]?.frozen) routes.push(buildFreezeRoute(slug));
  }
  // 2. per-org upstream overrides (only orgs NOT on the default v1 upstream)
  for (const slug of slugs) {
    const up = state[slug]?.upstream ?? "v1";
    if (up !== "v1") routes.push(buildUpstreamRoute(slug, upstreams[up], up));
  }
  // 3. fallback → v1 (the default; un-flipped orgs + every non-org path land here)
  routes.push(buildFallbackRoute(upstreams.v1));
  return routes;
}

/**
 * Build the FULL Caddy config object (admin + one http server) for a given state. This is what
 * `POST /load` receives. The admin listen address is provided by the caller (internal-only in
 * the prod-intent compose; a free host port in the synthetic test).
 */
export function buildCaddyConfig(opts: {
  state: ProxyState;
  upstreams: Upstreams;
  adminListen: string; // e.g. "0.0.0.0:2019" (test) or "localhost:2019" (prod-intent)
  httpListen?: string; // default ":80"
}): Record<string, unknown> {
  const { state, upstreams, adminListen, httpListen = ":80" } = opts;
  return {
    admin: { listen: adminListen },
    apps: {
      http: {
        servers: {
          cutover: {
            listen: [httpListen],
            routes: buildRoutes(state, upstreams),
          },
        },
      },
    },
  };
}

/**
 * Decode the per-org state back OUT of a live Caddy config's route list — the inverse of
 * buildRoutes. A `freeze_<slug>` route ⇒ that org is frozen; an `upstream_<slug>` route ⇒ that
 * org is pinned to its `_cutover_upstream` (default v1 when no upstream route exists). This lets
 * each mutation read→modify→rewrite the FULL config idempotently without server-side surgery.
 */
export function decodeState(config: Record<string, unknown>): ProxyState {
  const routes = routesOf(config);
  const state: ProxyState = {};
  const ensure = (slug: string): OrgState => (state[slug] ??= { upstream: "v1", frozen: false });
  for (const r of routes) {
    const id = typeof r["@id"] === "string" ? (r["@id"] as string) : "";
    if (id.startsWith("freeze_")) {
      ensure(id.slice("freeze_".length)).frozen = true;
    } else if (id.startsWith("upstream_")) {
      const slug = id.slice("upstream_".length);
      const up = (r as Record<string, unknown>)._cutover_upstream;
      ensure(slug).upstream = up === "v2" ? "v2" : "v1";
    }
  }
  return state;
}

/** Read the cutover server's route array out of a config object (empty if absent). */
function routesOf(config: Record<string, unknown>): CaddyRoute[] {
  const apps = config?.apps as Record<string, unknown> | undefined;
  const http = apps?.http as Record<string, unknown> | undefined;
  const servers = http?.servers as Record<string, unknown> | undefined;
  const cutover = servers?.cutover as Record<string, unknown> | undefined;
  const routes = cutover?.routes;
  return Array.isArray(routes) ? (routes as CaddyRoute[]) : [];
}

/** Read the admin listen address out of a live config (so a rewrite preserves it). */
function adminListenOf(config: Record<string, unknown>): string {
  const admin = config?.admin as Record<string, unknown> | undefined;
  const listen = admin?.listen;
  return typeof listen === "string" ? listen : "localhost:2019";
}

/** Read the cutover server's http listen address (so a rewrite preserves it). */
function httpListenOf(config: Record<string, unknown>): string {
  const apps = config?.apps as Record<string, unknown> | undefined;
  const http = apps?.http as Record<string, unknown> | undefined;
  const servers = http?.servers as Record<string, unknown> | undefined;
  const cutover = servers?.cutover as Record<string, unknown> | undefined;
  const listen = cutover?.listen;
  return Array.isArray(listen) && typeof listen[0] === "string" ? (listen[0] as string) : ":80";
}

// ── PURE state transitions (the unit-tested crux) ───────────────────────────────────────

/** Freeze one org (idempotent): set frozen=true, preserve its upstream. */
export function applyFreeze(state: ProxyState, slug: string): ProxyState {
  const cur = state[slug] ?? { upstream: "v1" as Upstream, frozen: false };
  return { ...state, [slug]: { ...cur, frozen: true } };
}

/** Unfreeze one org (idempotent): set frozen=false, preserve its upstream. */
export function applyUnfreeze(state: ProxyState, slug: string): ProxyState {
  const cur = state[slug] ?? { upstream: "v1" as Upstream, frozen: false };
  return { ...state, [slug]: { ...cur, frozen: false } };
}

/** Pin one org's upstream (idempotent): set upstream, preserve its frozen flag. */
export function applySetUpstream(state: ProxyState, slug: string, upstream: Upstream): ProxyState {
  const cur = state[slug] ?? { upstream: "v1" as Upstream, frozen: false };
  return { ...state, [slug]: { ...cur, upstream } };
}

// ── The admin-API client (the impure edge; wraps fetch) ─────────────────────────────────

export interface ProxyControlOptions {
  /** Admin API base URL, e.g. http://localhost:2019 (NO trailing slash). */
  adminUrl: string;
  upstreams: Upstreams;
  /** Injectable fetch (tests pass a mock; default = global fetch). */
  fetchImpl?: typeof fetch;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export class ProxyControl {
  private readonly adminUrl: string;
  private readonly upstreams: Upstreams;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;

  constructor(opts: ProxyControlOptions) {
    this.adminUrl = opts.adminUrl.replace(/\/+$/, "");
    this.upstreams = opts.upstreams;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  /** GET the full live config. */
  async getConfig(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.adminUrl}/config/`, { method: "GET" });
    if (!res.ok) throw new Error(`proxy-control: GET /config/ failed ${res.status} ${await safeText(res)}`);
    const text = await res.text();
    return text && text !== "null" ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  /** POST a FULL config via /load (atomic, zero-downtime, auto-rollback on a bad config). */
  async load(config: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(`${this.adminUrl}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`proxy-control: POST /load failed ${res.status} ${await safeText(res)}`);
  }

  /** Read the decoded per-org state from the live config. */
  async getOrgState(slug: string): Promise<OrgState> {
    const cfg = await this.getConfig();
    const state = decodeState(cfg);
    return state[slug] ?? { upstream: "v1", frozen: false };
  }

  /** Read→transform→rewrite the FULL config idempotently, preserving the live listen addresses. */
  private async mutate(transform: (s: ProxyState) => ProxyState): Promise<void> {
    const cfg = await this.getConfig();
    const next = transform(decodeState(cfg));
    const config = buildCaddyConfig({
      state: next,
      upstreams: this.upstreams,
      adminListen: adminListenOf(cfg),
      httpListen: httpListenOf(cfg),
    });
    await this.load(config);
  }

  /** Freeze an org's writes at the proxy (idempotent). */
  async freezeOrg(slug: string): Promise<void> {
    this.log(`proxy-control: freezeOrg(${slug})`);
    await this.mutate((s) => applyFreeze(s, slug));
  }

  /** Lift an org's write-freeze (idempotent). */
  async unfreezeOrg(slug: string): Promise<void> {
    this.log(`proxy-control: unfreezeOrg(${slug})`);
    await this.mutate((s) => applyUnfreeze(s, slug));
  }

  /** Point an org's route at v1 (rollback) or v2 (flip) (idempotent). */
  async setOrgUpstream(slug: string, upstream: Upstream): Promise<void> {
    this.log(`proxy-control: setOrgUpstream(${slug}, ${upstream})`);
    await this.mutate((s) => applySetUpstream(s, slug, upstream));
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return "";
  }
}
