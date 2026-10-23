import { NextResponse } from "next/server";
import { z } from "zod";
import type { AnyObject, RouteContract } from "./contract";
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
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ProblemError(400, "invalid_request", "Request body must be valid JSON");
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
function withoutKeys(v: unknown, keys: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => withoutKeys(x, keys));
  if (isPlainObject(v)) {
    return Object.fromEntries(
      Object.entries(v).filter(([k]) => !keys.has(k)).map(([k, x]) => [k, withoutKeys(x, keys)]),
    );
  }
  return v;
}

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
  init: { headers?: HeadersInit; ctx?: { isApiKey?: boolean } } = {},
): NextResponse {
  const schema = (contract.responses as Record<number, z.ZodType | null | undefined>)[status];
  if (schema === undefined) {
    throw new ResponseContractError(contract.operationId, `no ${status} response is declared`);
  }
  if (schema === null) return new NextResponse(null, { status, headers: init.headers });

  let wire: unknown = data === undefined ? undefined : JSON.parse(JSON.stringify(data));
  if (contract.sessionOnly?.length) {
    if (!init.ctx) throw new ResponseContractError(contract.operationId, "sessionOnly needs the caller's ctx");
    if (init.ctx.isApiKey) wire = withoutKeys(wire, new Set(contract.sessionOnly));
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
