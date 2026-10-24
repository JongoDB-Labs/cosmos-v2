import { describe, it, expect, vi } from "vitest";
import { ZodError, z } from "zod";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/telemetry/server", () => ({ serverReportError: vi.fn() }));

import { handleApiError } from "@/lib/api-helpers";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/rbac/check";
import { NoModelCredentialError } from "@/lib/ai/egress/types";
import { TransitionError } from "@/lib/workflow/contract";
import { problem, PROBLEM_CONTENT_TYPE } from "../problem";
import { REQUEST_ID_HEADER, requestIdFor } from "../request-id";

const withId = (id: string) => new Request("http://x/api/v1/y", { headers: { [REQUEST_ID_HEADER]: id } });

describe("problem()", () => {
  it("is RFC 9457 problem+json and keeps the legacy error key", async () => {
    const res = problem(404, "not_found", "Project not found", { request: withId("req-1") });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    expect(await res.json()).toEqual({
      type: "/developers/guides/errors#not_found",
      title: "Not found",
      status: 404,
      detail: "Project not found",
      code: "not_found",
      requestId: "req-1",
      error: "Project not found",
    });
  });

  it("falls back to the title for error, and omits what it does not have", async () => {
    const body = await problem(401, "unauthorized").json();
    expect(body).toEqual({
      type: "/developers/guides/errors#unauthorized", title: "Unauthorized", status: 401,
      code: "unauthorized", error: "Unauthorized",
    });
  });

  it("keeps caller headers", () => {
    const res = problem(429, "rate_limited", undefined, { headers: { "Retry-After": "7" } });
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
  });
});

/**
 * Everything that read `body.error` before must read the same string now: the
 * UI toasts it, and scripts and the stdio MCP servers match on it.
 */
describe("handleApiError keeps every legacy body", () => {
  const p2002 = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
  let zodErr: ZodError;
  try { z.object({ a: z.string() }).parse({}); } catch (e) { zodErr = e as ZodError; }

  it.each([
    ["Forbidden", new ForbiddenError("Missing required permission"), 403, "forbidden", "Missing required permission"],
    ["NotFound", new NotFoundError("Item not found"), 404, "not_found", "Item not found"],
    ["Conflict", new ConflictError("payment exceeds balance"), 409, "conflict", "payment exceeds balance"],
    ["NoModelCredential", new NoModelCredentialError(), 409, "model_not_connected", new NoModelCredentialError().message],
    ["P2002", p2002, 409, "conflict", "Conflicting concurrent request — please retry"],
    ["deadlock", new Prisma.PrismaClientKnownRequestError("deadlock", { code: "P2010", clientVersion: "x", meta: { code: "40P01" } }), 409, "conflict", "Conflicting concurrent request — please retry"],
    ["write conflict", new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "x" }), 409, "conflict", "Conflicting concurrent request — please retry"],
    ["unknown", new Error("db exploded: password=hunter2"), 500, "internal_error", "Internal server error"],
  ] as const)("%s keeps its status, code and legacy text", async (_n, err, status, code, legacy) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(err);
    spy.mockRestore();
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error).toBe(legacy);
    expect(body.code).toBe(code);
    expect(body.status).toBe(status);
    // A 500 never echoes the thrown message.
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("a workflow refusal is a problem with its code and what to ask for beside it", async () => {
    const res = handleApiError(
      new TransitionError({
        error: "Resolve needs a resolution.",
        code: "transition_input_required",
        transition: { id: "t1", name: "Resolve", to: "done" },
        fields: [{ field: { system: "resolution" }, required: true }],
      }),
      withId("req-9"),
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    expect(await res.json()).toEqual({
      type: "/developers/guides/errors#transition_input_required",
      title: "Transition needs input",
      status: 422,
      detail: "Resolve needs a resolution.",
      code: "transition_input_required",
      requestId: "req-9",
      error: "Resolve needs a resolution.",
      transition: { id: "t1", name: "Resolve", to: "done" },
      fields: [{ field: { system: "resolution" }, required: true }],
    });
  });

  it("Zod → 400 with the issues still at body.issues", async () => {
    const res = handleApiError(zodErr!);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid request");
    expect(body.code).toBe("invalid_request");
    expect(body.issues).toEqual(zodErr!.issues);
  });

  it("puts the request id in the body when given the request", async () => {
    const body = await handleApiError(new NotFoundError("x"), withId("abc-123")).json();
    expect(body.requestId).toBe("abc-123");
  });
});

describe("requestIdFor", () => {
  it("echoes a plain inbound id", () => {
    expect(requestIdFor("caddy-7f3a:01")).toBe("caddy-7f3a:01");
  });

  it.each(["", "  ", "a b", "x\r\nSet-Cookie: s=1", "<script>", "x".repeat(129)])(
    "mints a fresh one instead of echoing %j",
    (bad) => {
      const id = requestIdFor(bad);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it("mints a different id each time", () => {
    expect(requestIdFor(null)).not.toBe(requestIdFor(null));
  });
});
