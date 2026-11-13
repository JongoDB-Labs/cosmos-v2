// @vitest-environment node
/**
 * No API route answers a caller it hasn't identified.
 *
 * The proxy passes any request with an API-key-shaped `Authorization: Bearer
 * cosmos_…` header on to the route, so each handler is the last line. This imports every route.ts under
 * src/app/api and calls each exported handler, against a seeded org whose real
 * ids fill the path, as:
 * - nobody (no credentials),
 * - a well-formed API key that doesn't exist, with a body that isn't JSON,
 * - nobody, with every path value but the org's malformed.
 * Each must refuse (401 or 403, a redirect to /login, or a 404 after asking who
 * the caller is), and no answer may carry the org's data. The org's signed-in
 * owner is the positive control: no GET may refuse them as unidentified.
 *
 * Authentication is real: getAuthContext and getCurrentUser run unmocked (only
 * wrapped to count calls), reading the request's headers and cookies through a
 * stand-in for `next/headers`. See route-sweep.ts.
 *
 * The routes are split across this file and every-route-authenticates-*.db.test.ts
 * so they run in parallel. This file also holds the checks on the sweep itself,
 * and the wrong-credential tests for the public routes that take a credential
 * of their own (route-auth-policy.ts lists the public routes).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./route-sweep")).fakeNextHeaders);
vi.mock("next/cache", async () => (await import("./route-sweep")).fakeNextCache);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
  after: () => undefined,
}));
vi.mock("@/lib/auth/session", async (importOriginal) =>
  (await import("./route-sweep")).spyOnSession(await importOriginal<typeof import("@/lib/auth/session")>()),
);

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { newFeedToken } from "@/lib/calendar/feed-token";
import { unsubscribeToken } from "@/lib/query/subscription-email";
import { fakeBotFramework } from "@/lib/testing/fake-bot-framework";
import { _resetBotKeys } from "@/lib/integrations/microsoft/teams-app/bot-auth.server";
import {
  KNOWN_OPEN, PLUGIN_KNOWN_OPEN, PLUGIN_SIGNED_OUT, PUBLIC_HANDLERS, REDIRECT_REFUSALS, SIGNED_OUT_STEPS, UNSEEDED_PARAMS, pluginOf,
} from "./route-auth-policy";
import {
  SWEEP_SHARDS, defineRouteSweep, discoverRoutes, handlersOf, paramNames, refusal, seedWorld, urlFor, type Outcome, type World,
} from "./route-sweep";
import { proxy } from "@/proxy";

describe("every API route refuses a caller it hasn't identified (shard 1)", () => defineRouteSweep(0));

describe("the sweep itself", () => {
  const routes = discoverRoutes();

  it("finds the API's routes on disk", () => {
    const rels = routes.map((r) => r.rel);
    expect(rels.length).toBeGreaterThan(400);
    for (const known of ["health", "v1/orgs/[orgId]/members", "v1/orgs/[orgId]/projects/[projectId]/work-items"]) {
      expect(rels).toContain(known);
    }
  });

  it("has a test file for every shard, so no route is left out", () => {
    const here = readdirSync(__dirname);
    const shards = here.flatMap((f) =>
      /^every-route-authenticates(-\d+)?\.db\.test\.ts$/.test(f)
        ? [...readFileSync(path.join(__dirname, f), "utf8").matchAll(/defineRouteSweep\((\d+)\)/g)].map((m) => Number(m[1]))
        : [],
    );
    expect(shards.sort()).toEqual(Array.from({ length: SWEEP_SHARDS }, (_, i) => i));
  });

  it("finds route files whatever their extension", () => {
    const names = new Set(routes.map((r) => path.basename(r.abs)));
    expect(names.has("route.ts")).toBe(true);
    for (const n of names) expect(n).toMatch(/^route\.(ts|tsx|js|jsx)$/);
  });

  it("lists only handlers that exist, so a stale exemption can't hide a new one", async () => {
    const composed = new Set(routes.map((r) => pluginOf(r.rel)).filter((p): p is string => p !== null));
    const missing: string[] = [];
    const keys = [
      ...Object.keys(PUBLIC_HANDLERS),
      ...Object.keys(SIGNED_OUT_STEPS),
      ...Object.keys(KNOWN_OPEN),
      ...Object.keys(REDIRECT_REFUSALS),
      // A plugin's entries only when that plugin is composed into this tree.
      ...[...Object.keys(PLUGIN_KNOWN_OPEN), ...Object.keys(PLUGIN_SIGNED_OUT)].filter((k) =>
        composed.has(pluginOf(k.split(" ")[1]) ?? ""),
      ),
    ];
    for (const key of keys) {
      const [method, rel] = key.split(" ");
      const route = routes.find((r) => r.rel === rel);
      const mod = route ? ((await import(/* @vite-ignore */ route.abs)) as Record<string, unknown>) : {};
      if (!handlersOf(mod).some(([m]) => m === method)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it("lists plugin handlers only under a plugin route group, and core ones only outside one", () => {
    const plugin = [...Object.keys(PLUGIN_KNOWN_OPEN), ...Object.keys(PLUGIN_SIGNED_OUT)];
    const core = [...Object.keys(PUBLIC_HANDLERS), ...Object.keys(SIGNED_OUT_STEPS), ...Object.keys(KNOWN_OPEN), ...Object.keys(REDIRECT_REFUSALS)];
    expect(plugin.filter((k) => pluginOf(k.split(" ")[1]) === null)).toEqual([]);
    expect(core.filter((k) => pluginOf(k.split(" ")[1]) !== null)).toEqual([]);
  });

  it("counts a redirect as a refusal only to /login, or to the one page a handler is listed with", () => {
    const redirect = (location: string): Outcome => ({ status: 307, location, asked: false, body: "", url: "http://localhost/api/x" });
    expect(refusal(redirect("/login"))).toBeNull();
    expect(refusal(redirect("http://localhost/login?next=/x"))).toBeNull();
    expect(refusal(redirect("/"))).toMatch(/not to this app's \/login/);
    expect(refusal(redirect("/"), undefined, "/")).toBeNull();
    expect(refusal(redirect("/acme/settings"), undefined, "/")).toMatch(/or \//);
    expect(refusal(redirect("https://elsewhere.example/"), undefined, "/")).toMatch(/elsewhere/);
  });

  it("lists only unseeded params some route still uses", () => {
    const used = new Set(routes.flatMap((r) => paramNames(r.rel)));
    expect(Object.keys(UNSEEDED_PARAMS).filter((n) => !used.has(n))).toEqual([]);
  });
});

describe("the proxy lets a signed-out caller reach exactly the public handlers", () => {
  // The proxy (src/proxy.ts) reads the same list as this sweep
  // (lib/auth/signed-out-api.ts). These check it does, through the real proxy:
  // when it refuses a handler the list calls public, the feature is broken for
  // signed-out people; when it passes one the list doesn't name, that handler
  // is the only thing between it and the internet.
  const routes = discoverRoutes();
  const signedOutOk = new Set([
    ...Object.keys(PUBLIC_HANDLERS),
    ...Object.keys(SIGNED_OUT_STEPS),
    ...Object.keys(PLUGIN_SIGNED_OUT),
  ]);

  /** Whether the proxy passes this request on to the route. */
  async function passes(method: string, pathname: string): Promise<boolean> {
    const res = await proxy(
      new NextRequest(`http://localhost${pathname}`, {
        method,
        // Same-origin, so the CSRF check isn't what stops it: only the session check is in question.
        headers: { host: "localhost", origin: "http://localhost" },
      }),
    );
    return res.headers.get("x-middleware-next") === "1";
  }

  it("passes every handler the public list names", async () => {
    const refused: string[] = [];
    for (const key of [...Object.keys(PUBLIC_HANDLERS), ...Object.keys(SIGNED_OUT_STEPS), ...Object.keys(PLUGIN_SIGNED_OUT)]) {
      const [method, rel] = key.split(" ");
      if (!(await passes(method, new URL(urlFor(rel, {}).url).pathname))) refused.push(key);
    }
    expect(refused).toEqual([]);
  });

  it("passes no other handler, even at a path that ends like a static file", async () => {
    const passed: string[] = [];
    for (const r of routes) {
      const mod = (await import(/* @vite-ignore */ r.abs)) as Record<string, unknown>;
      for (const [method] of handlersOf(mod)) {
        const key = `${method} ${r.rel}`;
        if (signedOutOk.has(key)) continue;
        const pathname = new URL(urlFor(r.rel, {}).url).pathname;
        if (await passes(method, pathname)) passed.push(key);
        // A last segment that's an id can be anything, `x.png` included.
        if (/\]$/.test(r.rel) && (await passes(method, pathname.replace(/[^/]+$/, "x.png")))) passed.push(`${key} (as …/x.png)`);
      }
    }
    expect(passed).toEqual([]);
  }, 300_000); // imports every route module
});

describe("a public route with a credential of its own refuses a wrong one", () => {
  let world: World;
  let ip = 0;
  const from = () => ({ "x-forwarded-for": `198.19.0.${++ip}` });
  beforeAll(async () => {
    world = await seedWorld();
  }, 60_000);
  afterAll(async () => {
    await world?.cleanup();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("calendar feed: the real token answers; a wrong one gets an empty 404", async () => {
    const { GET } = await import("../v1/calendar/feeds/[token]/route");
    const call = (token: string) =>
      GET(new NextRequest(`http://localhost/api/v1/calendar/feeds/${token}.ics`, { headers: from() }), {
        params: Promise.resolve({ token: `${token}.ics` }),
      });

    const real = await call(world.tokens.feed);
    expect(real.status).toBe(200);
    expect(real.headers.get("content-type")).toContain("text/calendar");

    const t = world.tokens.feed;
    for (const wrong of [newFeedToken().token, `${t[0] === "A" ? "B" : "A"}${t.slice(1)}`]) {
      const res = await call(wrong);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  it("unsubscribe link: the real token asks to confirm; a wrong one changes nothing", async () => {
    const route = await import("../v1/unsubscribe/filter/[token]/route");
    const call = (method: "GET" | "POST", token: string) =>
      route[method](new NextRequest(`http://localhost/api/v1/unsubscribe/filter/${token}`, { method, headers: from() }), {
        params: Promise.resolve({ token }),
      });

    const real = await call("GET", world.tokens.unsubscribe);
    expect(real.status).toBe(200);
    expect(await real.text()).toContain("Unsubscribe from this filter email?");

    // The right subscription and person, signed with a key that isn't the subscription's.
    const forged = unsubscribeToken(randomBytes(32).toString("hex"), world.subscriptionId, world.ownerId);
    for (const method of ["GET", "POST"] as const) {
      const res = await call(method, forged);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("This link no longer works");
    }
    const sub = await prisma.filterSubscription.findUniqueOrThrow({ where: { id: world.subscriptionId } });
    expect(sub.disabledAt).toBeNull();
  });

  it("Teams bot: a token the Bot Framework didn't sign is refused 401", async () => {
    _resetBotKeys();
    const bf = fakeBotFramework();
    vi.stubGlobal("fetch", bf.fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { POST } = await import("../teams/bot/route");
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const call = (authorization: string) =>
      POST(
        new NextRequest("http://localhost/api/teams/bot", {
          method: "POST",
          body: JSON.stringify({ type: "message", channelId: "msteams", serviceUrl, channelData: { tenant: { id: "t1" } } }),
          headers: { "content-type": "application/json", authorization, ...from() },
        }),
      );

    // Our key id in the header, signed with a key the Bot Framework never published.
    const forged = await call(bf.token({ aud: "any-app", serviceUrl }, { key: bf.mk("other").privateKey }));
    expect(forged.status).toBe(401);
    expect(warn.mock.calls.flat().join(" ")).toContain("bad_signature");

    // The positive control: a properly signed token gets past the signature,
    // and stops at the next check (no bot app is configured in this database).
    warn.mockClear();
    const signed = await call(bf.token({ aud: "any-app", serviceUrl }));
    expect(signed.status).toBe(503);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("bad_signature");
  });

  it("Teams tab sign-in: no token, or a forged one, is refused 401 with no session cookie", async () => {
    const { POST } = await import("../teams/tab/session/route");
    const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const forged = `${enc({ alg: "RS256", typ: "JWT", kid: "k1" })}.${enc({ tid: "11111111-2222-3333-4444-555555555555", aud: "api://x" })}.${randomBytes(64).toString("base64url")}`;
    for (const token of ["", forged]) {
      const res = await POST(
        new NextRequest("http://localhost/api/teams/tab/session", {
          method: "POST",
          body: JSON.stringify({ token }),
          headers: { "content-type": "application/json", ...from() },
        }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("test-only routes answer 404 in production, even with E2E_TEST_AUTH=1", async () => {
    const userId = await import("../testenv/user-id/route");
    const signIn = await import("../testenv/sign-in/route");
    const lookup = () =>
      userId.GET(new NextRequest(`http://localhost/api/testenv/user-id?email=${encodeURIComponent(world.ownerEmail)}`, { headers: from() }));
    vi.stubEnv("E2E_TEST_AUTH", "1");

    // The positive control: outside production, with the switch on, the lookup answers.
    vi.stubEnv("NODE_ENV", "test");
    const dev = await lookup();
    expect(dev.status).toBe(200);
    expect(await dev.json()).toEqual({ userId: world.ownerId });

    vi.stubEnv("NODE_ENV", "production");
    const prod = await lookup();
    expect(prod.status).toBe(404);
    expect(await prod.text()).not.toContain(world.ownerId);
    const signInRes = await signIn.POST(
      new NextRequest("http://localhost/api/testenv/sign-in", {
        method: "POST",
        body: JSON.stringify({ email: world.ownerEmail }),
        headers: { "content-type": "application/json", ...from() },
      }),
    );
    expect(signInRes.status).toBe(404);
    expect(signInRes.headers.get("set-cookie")).toBeNull();
  });
});
