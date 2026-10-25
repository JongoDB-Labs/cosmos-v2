import { NextResponse } from "next/server";
import { z } from "zod";
import { bodyIsOptional, type AnyObject, type RouteContract } from "./contract";
import { pageQueryShape } from "./paginate";
import { ProblemError } from "./problem";

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;
type PageQuery = { limit?: number; cursor?: string };

export type ParsedRequest<C> = C extends RouteContract<infer P, infer Q, infer B>
  ? {
      params: Out<P>;
      query: Out<Q> & (C["pagination"] extends "cursor" ? PageQuery : unknown);
      body: Out<B>;
    }
  : never;

/** URLSearchParams → plain object; a repeated key becomes an array. */
function queryObject(sp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

/**
 * Validate a request against its contract. Throws (ZodError → 400 with
 * `issues`, ProblemError → its own status), so it sits inside the route's
 * existing try/catch and handleApiError answers.
 *
 * Query parameters the contract doesn't name are DROPPED, not refused:
 * existing clients send them (cache-busters like `_=`, tracking params), and
 * these routes accepted them before they had contracts. A known parameter with
 * an invalid value is still a 400.
 */
export async function parseRequest<C extends RouteContract>(
  contract: C,
  request: Request,
  params?: Promise<Record<string, string | string[]>> | Record<string, string | string[]>,
): Promise<ParsedRequest<C>> {
  const { request: shape } = contract;

  const parsedParams = shape.params ? shape.params.parse(await params) : undefined;

  let querySchema: AnyObject | undefined = shape.query;
  if (contract.pagination === "cursor") {
    querySchema = (querySchema ?? z.object({})).extend(pageQueryShape);
  }
  const q = queryObject(new URL(request.url).searchParams);
  const parsedQuery = (querySchema ?? z.object({})).parse(q);

  let parsedBody: unknown = undefined;
  if (shape.body) {
    const text = await request.text();
    let raw: unknown;
    // A body the contract makes optional (`schema.optional()`) may be left out
    // entirely: the app duplicates an item with no body at all.
    if (text.trim() === "" && bodyIsOptional(shape.body)) raw = undefined;
    else {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ProblemError(400, "invalid_request", "Request body must be valid JSON");
      }
    }
    parsedBody = shape.body.parse(raw);
  }

  return { params: parsedParams, query: parsedQuery, body: parsedBody } as ParsedRequest<C>;
}

/** A handler returned something its own contract doesn't describe. A server bug, so a 500. */
export class ResponseContractError extends Error {
  constructor(operationId: string, detail: string) {
    super(`${operationId}: response violates its contract: ${detail}`);
    this.name = "ResponseContractError";
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Paths present in `wire` that the schema stripped from `out`. */
export function droppedKeys(wire: unknown, out: unknown, at = "$"): string[] {
  if (Array.isArray(wire) && Array.isArray(out)) {
    return wire.flatMap((w, i) => droppedKeys(w, out[i], `${at}[${i}]`));
  }
  if (isPlainObject(wire) && isPlainObject(out)) {
    return Object.keys(wire).flatMap((k) =>
      k in out ? droppedKeys(wire[k], out[k], `${at}.${k}`) : [`${at}.${k}`],
    );
  }
  return [];
}

/**
 * Everywhere but production, a field the contract doesn't declare is an error,
 * in both directions: a handler that over-selects, and a contract that forgot a
 * column the handler (and so the UI) relies on. Development included, because
 * that second case is invisible otherwise: the column just vanishes. Production
 * strips quietly, which is the point of the projection.
 */
const strictResponses = () => process.env.NODE_ENV !== "production";

/** A copy of `v` with the named keys removed at every depth. */
/** Delete the field at an exact path (`a.b`, `[].c`, `items[].user.email`). */
export function withoutPath(v: unknown, path: string[]): void {
  const [head, ...rest] = path;
  if (head === undefined || v === null || typeof v !== "object") return;
  if (head === "[]") {
    if (Array.isArray(v)) for (const x of v) withoutPath(x, rest);
    return;
  }
  const obj = v as Record<string, unknown>;
  if (rest.length === 0) delete obj[head];
  else withoutPath(obj[head], rest);
}

/** `members[].orgMember.user.email` → ["members", "[]", "orgMember", "user", "email"]. */
const splitPath = (p: string) => p.split(".").flatMap((seg) => (seg.endsWith("[]") ? [seg.slice(0, -2), "[]"] : [seg])).filter(Boolean);

/**
 * Serialize `data` through the contract's response schema for `status`.
 *
 * The schema is a PROJECTION: `z.object` strips keys it doesn't declare, so
 * a raw Prisma row can't leak a column someone adds to the table later. It
 * only reaches callers once a contract names it. Serialized to JSON first so
 * the schema describes the wire (dates as ISO strings), exactly as documented.
 */
export function respond<C extends RouteContract>(
  contract: C,
  status: keyof C["responses"] & number,
  data: unknown,
  init: { headers?: HeadersInit; ctx?: { isApiKey?: boolean; scopes?: string[] } } = {},
): NextResponse {
  const schema = (contract.responses as Record<number, z.ZodType | null | undefined>)[status];
  if (schema === undefined) {
    throw new ResponseContractError(contract.operationId, `no ${status} response is declared`);
  }
  if (schema === null) return new NextResponse(null, { status, headers: init.headers });

  const wire: unknown = data === undefined ? undefined : JSON.parse(JSON.stringify(data));
  if (contract.scopedFields?.length) {
    if (!init.ctx) throw new ResponseContractError(contract.operationId, "scopedFields needs the caller's ctx");
    if (init.ctx.isApiKey) {
      for (const { scope, paths } of contract.scopedFields) {
        if (init.ctx.scopes?.includes(scope)) continue;
        for (const p of paths) withoutPath(wire, splitPath(p));
      }
    }
  }
  const result = schema.safeParse(wire);
  if (!result.success) {
    throw new ResponseContractError(contract.operationId, z.prettifyError(result.error));
  }
  if (strictResponses()) {
    const dropped = droppedKeys(wire, result.data);
    if (dropped.length) {
      throw new ResponseContractError(
        contract.operationId,
        `undeclared field(s) ${dropped.slice(0, 5).join(", ")}: select less, or add them to the contract`,
      );
    }
  }
  return NextResponse.json(result.data, { status, headers: init.headers });
}
