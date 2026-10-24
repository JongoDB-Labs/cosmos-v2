import { describe, it, expect, vi, afterEach } from "vitest";
import { z, ZodError } from "zod";
import { defineRoute } from "../contract";
import { droppedKeys, parseRequest, respond, ResponseContractError, withoutPath } from "../respond";
import { ProblemError } from "../problem";

vi.mock("@/lib/telemetry/server", () => ({ serverReportError: vi.fn() }));
import { handleApiError } from "@/lib/api-helpers";

const Thing = z.object({ id: z.string(), name: z.string(), at: z.string() });

const getThings = defineRoute({
  method: "get", path: "/things/{thingId}", operationId: "getThings", summary: "s", tags: ["T"],
  stability: "stable", scopes: ["read"],
  request: {
    params: z.object({ thingId: z.string().min(3) }),
    query: z.object({ n: z.coerce.number().int().optional(), tag: z.array(z.string()).optional() }),
  },
  responses: { 200: z.array(Thing) }, errors: [400], pagination: "cursor",
});

const createThing = defineRoute({
  method: "post", path: "/things", operationId: "createThing", summary: "s", tags: ["T"],
  stability: "stable", scopes: ["items:write"],
  request: { body: z.object({ name: z.string().min(1) }) },
  responses: { 201: Thing, 204: null }, errors: [400],
});

const req = (url: string, init?: RequestInit) => new Request(`http://x${url}`, init);

describe("parseRequest", () => {
  it("parses params, coerces the query and adds the page params of a paginated contract", async () => {
    const r = await parseRequest(getThings, req("/things/abc?n=3&tag=a&tag=b&limit=10&cursor=xyz"), Promise.resolve({ thingId: "abc" }));
    expect(r.params).toEqual({ thingId: "abc" });
    expect(r.query).toEqual({ n: 3, tag: ["a", "b"], limit: 10, cursor: "xyz" });
  });

  it("drops a query parameter the contract doesn't name (clients send cache-busters), keeping the known ones", async () => {
    const r = await parseRequest(getThings, req("/things/abc?n=3&_=1729700000&utm_source=x"), { thingId: "abc" });
    expect(r.query).toEqual({ n: 3 });
  });

  it("still refuses an invalid value for a parameter it does name", async () => {
    const err = await parseRequest(getThings, req("/things/abc?n=three"), { thingId: "abc" }).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    const res = handleApiError(err);
    expect(res.status).toBe(400);
    expect(JSON.stringify((await res.json()).issues)).toContain("n");
  });

  it("refuses limit outside 1–200", async () => {
    await expect(parseRequest(getThings, req("/things/abc?limit=201"), { thingId: "abc" })).rejects.toBeInstanceOf(ZodError);
  });

  it("validates path params", async () => {
    await expect(parseRequest(getThings, req("/things/ab"), { thingId: "ab" })).rejects.toBeInstanceOf(ZodError);
  });

  it("parses the body, and a malformed one is a 400 problem, not a 500", async () => {
    const ok = await parseRequest(createThing, req("/things", { method: "POST", body: '{"name":"x"}' }));
    expect(ok.body).toEqual({ name: "x" });
    const err = await parseRequest(createThing, req("/things", { method: "POST", body: "{nope" })).catch((e) => e);
    expect(err).toBeInstanceOf(ProblemError);
    const res = handleApiError(err);
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe("Request body must be valid JSON");
  });

  it("a contract without a query schema ignores query params too", async () => {
    const r = await parseRequest(createThing, req("/things?x=1", { method: "POST", body: '{"name":"x"}' }));
    expect(r.query).toEqual({});
  });
});

describe("respond", () => {
  const env = process.env.NODE_ENV;
  afterEach(() => { (process.env as Record<string, string | undefined>).NODE_ENV = env; });

  it("serializes through the schema: dates become ISO strings", async () => {
    const res = respond(createThing, 201, { id: "1", name: "n", at: new Date("2026-11-01T00:00:00Z") });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "1", name: "n", at: "2026-11-01T00:00:00.000Z" });
  });

  it("in production, strips a field the contract doesn't declare: the projection", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    const res = respond(getThings, 200, [{ id: "1", name: "n", at: "t", keyHash: "SECRET", nested: { x: 1 } }]);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("nested");
  });

  it("outside production, an undeclared field fails loudly instead, naming it", () => {
    expect(() => respond(getThings, 200, [{ id: "1", name: "n", at: "t", keyHash: "SECRET" }]))
      .toThrow(/undeclared field\(s\) \$\[0\]\.keyHash/);
  });

  it("a row the contract can't describe is a 500, never a 400 blamed on the caller", async () => {
    const err = (() => { try { respond(createThing, 201, { id: 1 }); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(ResponseContractError);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(err);
    spy.mockRestore();
    expect(res.status).toBe(500);
  });

  it("204 has no body; an undeclared status is a server bug", async () => {
    const res = respond(createThing, 204, undefined);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(() => respond(createThing, 200 as never, {})).toThrow(/no 200 response is declared/);
  });

  it("keeps caller headers (pagination)", () => {
    const res = respond(getThings, 200, [], { headers: { Link: '<u>; rel="next"' } });
    expect(res.headers.get("link")).toBe('<u>; rel="next"');
  });
});

describe("droppedKeys", () => {
  it("reports nested and per-item paths", () => {
    expect(droppedKeys({ a: 1, b: { c: 1, d: 2 }, e: [{ f: 1, g: 2 }] }, { a: 1, b: { c: 1 }, e: [{ f: 1 }] }))
      .toEqual(["$.b.d", "$.e[0].g"]);
  });
});

describe("respond: scopedFields (email behind members:read)", () => {
  const Person = z.object({
    id: z.string(),
    user: z.object({ email: z.string().optional(), name: z.string() }),
    // Same key name, different field: an exact path must never touch it.
    settings: z.object({ email: z.string() }),
  });
  const getPeople = defineRoute({
    method: "get", path: "/people", operationId: "getPeople", summary: "s", tags: ["T"], stability: "stable",
    scopes: ["read"], request: {}, responses: { 200: z.array(Person) }, errors: [],
    scopedFields: [{ scope: "members:read", paths: ["[].user.email"] }],
  });
  const rows = [{ id: "1", user: { email: "a@x.gov", name: "A" }, settings: { email: "alerts@x.gov" } }];
  const body = async (ctx: object) => (await respond(getPeople, 200, rows, { ctx }).json()) as typeof rows;

  it("a browser session gets them", async () => {
    expect((await body({}))[0].user.email).toBe("a@x.gov");
  });

  it("a token with the scope gets them", async () => {
    expect((await body({ isApiKey: true, scopes: ["read", "members:read"] }))[0].user.email).toBe("a@x.gov");
  });

  it("a token without it loses exactly that path, nothing else", async () => {
    const [p] = await body({ isApiKey: true, scopes: ["read"] });
    expect(p.user).toEqual({ name: "A" });
    expect(p.settings.email).toBe("alerts@x.gov");
  });

  it("withoutPath walks objects and arrays, and ignores what isn't there", () => {
    const v = { members: [{ orgMember: { user: { email: "x", id: 1 } } }, { orgMember: null }] };
    withoutPath(v, ["members", "[]", "orgMember", "user", "email"]);
    expect(v).toEqual({ members: [{ orgMember: { user: { id: 1 } } }, { orgMember: null }] });
  });

  it("refuses to answer without knowing the caller", () => {
    expect(() => respond(getPeople, 200, rows)).toThrow(/scopedFields needs the caller's ctx/);
  });
});

