import { NextResponse } from "next/server";
import { requestIdOf } from "./request-id";
import { PROBLEM_CODES, type ProblemCode } from "./problem-codes";

/**
 * RFC 9457 `application/problem+json`: the one error shape the public API
 * documents.
 *
 * Every body also keeps the legacy `error` key with the exact string routes
 * returned before, so anything that reads `body.error` (the UI's toasts, the
 * stdio MCP servers, scripts) sees no change. `issues` is kept too, for the
 * same reason, on validation failures.
 */
export { PROBLEM_CODES, type ProblemCode };

export interface Problem {
  /** Relative URI of the code's entry in the errors guide. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: ProblemCode;
  /** The `X-Request-Id` of the failed request, when the route passed its request. */
  requestId?: string;
  issues?: unknown[];
  /** Legacy key: `detail` when there is one, else `title`. */
  error: string;
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export function problemBody(
  status: number,
  code: ProblemCode,
  detail?: string,
  opts: { request?: Request | null; issues?: unknown[] } = {},
): Problem {
  const title = PROBLEM_CODES[code];
  const requestId = requestIdOf(opts.request);
  return {
    type: `/developers/guides/errors#${code}`,
    title,
    status,
    ...(detail !== undefined && { detail }),
    code,
    ...(requestId && { requestId }),
    ...(opts.issues && { issues: opts.issues }),
    error: detail ?? title,
  };
}

/** A problem+json response. Use instead of `new Response("Not found")` and
 *  ad-hoc `NextResponse.json({ error })` bodies. */
export function problem(
  status: number,
  code: ProblemCode,
  detail?: string,
  opts: { request?: Request | null; issues?: unknown[]; headers?: HeadersInit } = {},
): NextResponse {
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", PROBLEM_CONTENT_TYPE);
  return NextResponse.json(problemBody(status, code, detail, opts), { status, headers });
}

/**
 * Throw from anywhere under a route's try/catch; handleApiError turns it into
 * the matching problem response. For the errors no domain class covers
 * (malformed JSON, an unusable cursor, a scope the token lacks).
 */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProblemCode,
    detail?: string,
    readonly headers?: HeadersInit,
  ) {
    super(detail ?? PROBLEM_CODES[code]);
    this.name = "ProblemError";
  }
}
