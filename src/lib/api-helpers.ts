import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { ForbiddenError, NotFoundError, ConflictError } from "./rbac/check";
import { serverReportError } from "./telemetry/server";
import { problem } from "./openapi/problem";
import { isNoModelCredentialError } from "./ai/egress/types";

export function success<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function created<T>(data: T) {
  return NextResponse.json(data, { status: 201 });
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

/**
 * Map a thrown error to an RFC 9457 problem+json response (the legacy
 * `error` key keeps its old text; see lib/openapi/problem.ts). Pass the
 * request to put its `X-Request-Id` in the body; the header is on every
 * response regardless (the proxy sets it).
 */
export function handleApiError(error: unknown, request?: Request) {
  const opts = { request };
  if (error instanceof ForbiddenError) {
    return problem(403, "forbidden", error.message, opts);
  }
  if (error instanceof NotFoundError) {
    return problem(404, "not_found", error.message, opts);
  }
  if (error instanceof ConflictError) {
    // Business-rule / state violations (e.g. "payment exceeds balance") are client
    // errors — a 409, not a 500 that pollutes the error budget.
    return problem(409, "model_not_connected", error.message, opts);
  }
  if (isNoModelCredentialError(error)) {
    // No Claude connection is an org setup state, not a server fault: say so
    // instead of a 500 (or, before, a stale env key's raw Anthropic 401).
    return problem(409, "model_not_connected", error.message, opts);
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    // A unique-constraint race (e.g. two posts of the same source landing at once)
    // is a conflict, not a server error.
    return problem(409, "conflict", "Conflicting concurrent request — please retry", opts);
  }
  if (error instanceof ZodError) {
    // Input-validation failures are client errors, not server errors —
    // returning 500 here masked real bugs (and confused clients) for every
    // route that did `schema.parse(body)` inside a try/catch.
    return problem(400, "invalid_request", "Invalid request", { ...opts, issues: error.issues });
  }
  console.error("[api:500]", error);
  serverReportError(error, { scope: "api" });
  return problem(500, "internal_error", undefined, opts);
}

export function getIpAddress(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    undefined
  );
}
