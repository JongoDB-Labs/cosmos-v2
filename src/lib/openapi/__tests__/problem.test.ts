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
// Prisma's own P2028 messages, word for word (its transaction manager prefixes
// each with "Transaction API error: ").
const START_TIMEOUT = "Transaction API error: Unable to start a transaction in the given time.";
const EXPIRED =
  "Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.";
const COMMITTED = "Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.";
const ROLLED_BACK = "Transaction API error: Transaction already closed: A query cannot be executed on a transaction that was rolled back.";
const NOT_FOUND =
  "Transaction API error: Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn't have information about anymore, or was obtained before disconnecting.";
function p2028(message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, { code: "P2028", clientVersion: "x" });
}

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
    ["transaction start timeout", p2028(START_TIMEOUT), 503, "server_busy", "The server was too busy to finish this request. Try again in a moment."],
    ["transaction expired", p2028(EXPIRED), 503, "server_busy", "The server was too busy to finish this request. Try again in a moment."],
    ["transaction misuse", p2028(COMMITTED), 500, "internal_error", "Internal server error"],
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

  it.each([
    ["could not start", START_TIMEOUT],
    ["expired", EXPIRED],
  ])("a transaction that timed out (%s) says when to try again, and isn't reported as a server fault", (_n, message) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(p2028(message));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
  });

  it.each([
    ["committed", COMMITTED],
    ["rolled back", ROLLED_BACK],
    ["unknown id", NOT_FOUND],
  ])("a transaction used wrongly (%s) is still a reported 500, not a busy server", (_n, message) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(p2028(message));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  // A foreign-key violation is answered with a 400 that says which way the
  // reference broke, in Postgres's own words where it gives them: the write
  // named a row that isn't there (a parent deleted a moment ago, say), or other
  // records still point at the row being deleted. Where it doesn't say, one
  // message true of both. The answer names no table, constraint or column; the
  // server log does, at error level, so a server bug that writes a bad
  // reference is still seen. The status-column case keeps its own message.
  const p2003 = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError("Foreign key constraint violated", { code: "P2003", clientVersion: "x", meta });
  // The shape Prisma's pg driver adapter reports one in, as read off real violations.
  const adapterMeta = (modelName: string, constraint: string, originalMessage: string) => ({
    modelName,
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: { originalCode: "23503", originalMessage, kind: "ForeignKeyConstraintViolation", constraint: { index: constraint } },
    },
  });
  const written = (modelName: string, table: string, constraint: string) =>
    adapterMeta(modelName, constraint, `insert or update on table "${table}" violates foreign key constraint "${constraint}"`);
  const MISSING = "This refers to something that no longer exists.";
  const IN_USE = "This is still in use by other records.";
  const EITHER = "This conflicts with a related record.";

  it.each([
    ["a parent that isn't there", written("WorkItem", "work_items", "work_items_parent_id_fkey"), MISSING, "work_items_parent_id_fkey"],
    ["another table's reference", written("Comment", "comments", "comments_work_item_id_fkey"), MISSING, "comments_work_item_id_fkey"],
    [
      "a delete that other records still point at",
      adapterMeta(
        "WorkItemType",
        "work_items_work_item_type_id_fkey",
        'update or delete on table "work_item_types" violates foreign key constraint "work_items_work_item_type_id_fkey" on table "work_items"',
      ),
      IN_USE,
      "work_items_work_item_type_id_fkey",
    ],
    [
      "a server that words it otherwise",
      adapterMeta("WorkItem", "work_items_parent_id_fkey", 'Einfügen oder Aktualisieren in Tabelle "work_items" verletzt Fremdschlüssel-Constraint'),
      EITHER,
      "work_items_parent_id_fkey",
    ],
    ["no detail at all", {}, EITHER, "P2003"],
  ])("a broken reference (%s) is a 400 that names nothing, logged with what it was", async (_n, meta, message, logged) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(p2003(meta), withId("req-fk"));
    const logs = spy.mock.calls.map((args) => args.map(String).join(" "));
    spy.mockRestore();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(logged);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    const body = await res.json();
    expect(body).toMatchObject({ status: 400, code: "invalid_request", error: message });
    expect(body.detail).toBe(body.error);
    const text = JSON.stringify(body);
    for (const leak of ["fkey", "parent_id", "work_item", "comments", "Comment", "23503", "Foreign key", "Fremdschl"]) expect(text).not.toContain(leak);
  });

  it("a status the project doesn't have keeps its own message", async () => {
    const res = handleApiError(p2003(written("WorkItem", "work_items", "work_items_project_id_column_key_fkey")));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("That status doesn't exist in this project.");
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
    expect(body.code).toBe("invalid_request");
    expect(body.issues).toEqual(zodErr!.issues);
  });

  // The form's toast reads `error` (jsonFetch → notifyError), and "Invalid
  // request" told the person nothing about what to fix. The first issue, with
  // the field it is about, goes in `detail`, which `error` repeats.
  it("Zod → the first issue, with its field, is the detail and the error", async () => {
    const body = await handleApiError(zodErr!).json();
    expect(body.title).toBe("Invalid request");
    expect(body.detail).toBe("a: Invalid input: expected string, received undefined");
    expect(body.error).toBe(body.detail);
  });

  it("Zod → a nested field is named by its path; a problem with the whole body has no field", async () => {
    const schema = z.object({ items: z.array(z.object({ title: z.string().min(1, "Give it a title") })) });
    const nested = schema.safeParse({ items: [{ title: "ok" }, { title: "" }] });
    expect((await handleApiError(nested.error!).json()).detail).toBe("items[1].title: Give it a title");
    const whole = schema.safeParse(null);
    expect((await handleApiError(whole.error!).json()).detail).toBe("Invalid input: expected object, received null");
  });

  it("Zod → only the first of several issues, and never the input that failed", async () => {
    const secret = "hunter2-not-long-enough";
    const r = z.object({ name: z.string().min(1, "Name is required"), password: z.string().min(64) }).safeParse({ name: "", password: secret });
    expect(r.error!.issues).toHaveLength(2);
    const body = await handleApiError(r.error!).json();
    expect(body.detail).toBe("name: Name is required");
    expect(JSON.stringify(body)).not.toContain(secret);
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
