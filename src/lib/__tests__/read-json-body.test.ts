// @vitest-environment node
import { describe, expect, it } from "vitest";
import { handleApiError, readJsonBody } from "@/lib/api-helpers";
import { INVALID_JSON_BODY, ProblemError } from "@/lib/openapi/problem";

const post = (raw?: string) =>
  new Request("http://localhost/api/x", { method: "POST", ...(raw !== undefined && { body: raw }) });

/** A request whose body has already been read: a bug in the route, not the client's mistake. */
async function consumed() {
  const req = post('{"a":1}');
  await req.text();
  return req;
}

const MALFORMED = ['{"name": "Re', "", "name=Release", "{'single': 'quotes'}", "[1, 2,]"];

describe("readJsonBody", () => {
  it("returns what the body says, whatever JSON value it is", async () => {
    expect(await readJsonBody(post('{"name":"Release","n":2}'))).toEqual({ name: "Release", n: 2 });
    expect(await readJsonBody(post("[1,2]"))).toEqual([1, 2]);
    expect(await readJsonBody(post("null"))).toBeNull();
    expect(await readJsonBody(post('"text"'))).toBe("text");
  });

  it.each(MALFORMED)("throws the 400 invalid_request problem for %j", async (raw) => {
    const err = await readJsonBody(post(raw)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 400, code: "invalid_request", message: INVALID_JSON_BODY });
  });

  it("throws the same 400 for a request with no body at all", async () => {
    await expect(readJsonBody(post(undefined))).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("is answered by handleApiError as that 400, saying why", async () => {
    const res = handleApiError(await readJsonBody(post("{")).catch((e: unknown) => e));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request", detail: INVALID_JSON_BODY, error: INVALID_JSON_BODY });
  });

  // The decided design: only a parse failure is the client's. A body the route
  // has already read is a server bug, so it must stay a reported 500 rather
  // than read as the caller's fault.
  it("does NOT turn a failure to read the body into a 400", async () => {
    const err = await readJsonBody(await consumed()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(ProblemError);
    const res = handleApiError(err);
    expect(res.status).toBe(500);
  });
});

describe("readJsonBody with { orElse }: an optional body", () => {
  it("returns the value it was given for a body that is missing or isn't JSON", async () => {
    for (const raw of [...MALFORMED, undefined]) {
      expect(await readJsonBody(post(raw), { orElse: null })).toBeNull();
      expect(await readJsonBody(post(raw), { orElse: {} })).toEqual({});
    }
  });

  it("still returns a well-formed body", async () => {
    expect(await readJsonBody(post('{"refs":[]}'), { orElse: {} })).toEqual({ refs: [] });
  });

  // It replaces `request.json().catch(() => value)`, so it must answer every
  // request the way that did, including one whose body was already read.
  it("answers exactly as request.json().catch(() => value) did", async () => {
    const inputs = [...MALFORMED, undefined, "{}", '{"a":[1,{"b":null}]}', "0", "true"];
    for (const raw of inputs) {
      const before = await post(raw).json().catch(() => "FALLBACK");
      expect(await readJsonBody(post(raw), { orElse: "FALLBACK" })).toEqual(before);
    }
    const before = await (await consumed()).json().catch(() => "FALLBACK");
    expect(before).toBe("FALLBACK");
    expect(await readJsonBody(await consumed(), { orElse: "FALLBACK" })).toBe("FALLBACK");
  });
});
