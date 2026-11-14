import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));
vi.mock("@/lib/telemetry/server", () => ({ serverReportError: vi.fn() }));

import { handleApiError } from "@/lib/api-helpers";
import { problem } from "@/lib/openapi/problem";
import { notifyError } from "@/lib/errors/notify";
import { FetchError, fetchErrorOf, jsonFetch, serverReason } from "../json-fetcher";

/** What a route answers when its schema refuses the body. */
function validationRefusal(): Response {
  const r = z.object({ name: z.string().min(1, "Name is required") }).safeParse({ name: "" });
  return handleApiError(r.error!);
}

const respondWith = (res: Response) => vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => toastError.mockClear());
afterEach(() => vi.restoreAllMocks());

describe("a server's reason reaches the toast", () => {
  // The whole path a form takes: the route's real error response, jsonFetch,
  // notifyError. Each piece was right alone; the toast still said "Invalid request".
  it("jsonFetch → notifyError shows a validation refusal's first issue", async () => {
    respondWith(validationRefusal());
    const err = await rejection(jsonFetch("/api/x", { method: "POST", body: "{}" }));
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).status).toBe(400);
    expect((err as FetchError).message).toBe("name: Name is required");
    notifyError(err, "Couldn't save.");
    expect(toastError).toHaveBeenCalledWith("name: Name is required");
  });

  it("fetchErrorOf → notifyError shows the same reason for code that calls fetch itself", async () => {
    const err = await fetchErrorOf(validationRefusal());
    notifyError(err, "Couldn't save.");
    expect(toastError).toHaveBeenCalledWith("name: Name is required");
  });

  it("fetchErrorOf of a response that says nothing keeps the caller's own fallback", async () => {
    for (const res of [new Response("Not found", { status: 404 }), new Response(null, { status: 502 })]) {
      toastError.mockClear();
      notifyError(await fetchErrorOf(res), "Couldn't save the note.");
      expect(toastError).toHaveBeenCalledWith("Couldn't save the note.");
    }
  });
});

describe("serverReason", () => {
  it("is a problem's detail", () => {
    expect(serverReason({ type: "/x", title: "Conflict", status: 409, code: "conflict", detail: "Sprint is active" })).toBe("Sprint is active");
  });

  // `error` is deprecated (the errors guide says so): a problem that stops
  // sending it must still be read.
  it("reads detail even without the legacy error key", () => {
    expect(serverReason({ title: "Conflict", code: "conflict", detail: "Sprint is active" })).toBe("Sprint is active");
  });

  it("falls back to the legacy error key of a plain body", () => {
    expect(serverReason({ error: "That status doesn't exist in this project." })).toBe("That status doesn't exist in this project.");
  });

  it("is null when the body says nothing", () => {
    for (const body of [null, undefined, "", "Not found", "<html>502</html>", [], {}, { error: { nested: true } }]) {
      expect(serverReason(body)).toBeNull();
    }
  });
});

describe("jsonFetch", () => {
  it("throws a FetchError carrying the server's detail", async () => {
    respondWith(problem(409, "conflict", "Sprint is active"));
    const err = (await rejection(jsonFetch("/api/x"))) as FetchError;
    expect({ status: err.status, message: err.message }).toEqual({ status: 409, message: "Sprint is active" });
  });

  it("names the status when the body has no reason", async () => {
    respondWith(new Response("Not found", { status: 404, statusText: "Not Found" }));
    expect(((await rejection(jsonFetch("/api/x"))) as FetchError).message).toBe("Not Found");
    respondWith(new Response(null, { status: 500 }));
    expect(((await rejection(jsonFetch("/api/x"))) as FetchError).message).toBe("HTTP 500");
  });

  it("still returns the body of a success, unwrapping a lone data key", async () => {
    respondWith(Response.json({ data: [1, 2] }));
    expect(await jsonFetch("/api/x")).toEqual([1, 2]);
  });
});

describe("fetchErrorOf", () => {
  it("is the FetchError jsonFetch would have thrown, body included", async () => {
    const err = await fetchErrorOf(problem(403, "forbidden", "Only an admin can do that"));
    expect(err).toBeInstanceOf(FetchError);
    expect({ status: err.status, message: err.message, code: (err.body as { code?: string }).code }).toEqual({
      status: 403,
      message: "Only an admin can do that",
      code: "forbidden",
    });
  });

  it("uses the fallback it is given when the server gives no reason", async () => {
    expect((await fetchErrorOf(new Response("", { status: 500 }), "Couldn't start that sprint.")).message).toBe("Couldn't start that sprint.");
    expect((await fetchErrorOf(new Response("", { status: 500 }))).message).toBe("");
  });

  it("still returns a FetchError when the body was already read", async () => {
    const res = Response.json({ error: "x" }, { status: 400 });
    await res.text();
    const err = await fetchErrorOf(res, "fallback");
    expect(err).toBeInstanceOf(FetchError);
    expect(err.message).toBe("fallback");
  });
});
