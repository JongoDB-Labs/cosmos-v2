import { z } from "zod";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { ProblemError } from "./problem";

/**
 * Cursor pagination for list operations, GitHub-style: the body stays a JSON
 * ARRAY (the UI depends on that), and the next page is announced in headers:
 *
 *   Link: <https://host/api/v1/…?limit=50&cursor=…>; rel="next"
 *   Cosmos-Next-Cursor: …
 *
 * No `Link` means the last page. Clients follow `next` until it's absent
 * rather than stopping at a short page.
 *
 * OPT-IN: a request with neither `limit` nor `cursor` gets the whole list, as
 * it always has; existing clients that never learned about `Link` must not
 * silently lose rows. A default page size is a later, announced change.
 *
 * Visibility belongs in the query's WHERE, never in a filter after the fetch:
 * the cursor is built from a page's last row, so a row dropped afterwards would
 * still put its sort key (an id, a timestamp) in `Link`.
 *
 * Keyset, not offset: the cursor is the sort key of the last row returned, so
 * rows inserted while a caller pages don't shift or repeat what it has seen.
 * It is opaque (base64url JSON) and only means something to the operation
 * that minted it.
 */

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export const pageQueryShape = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional()
    .describe(
      `Page size, 1–${MAX_PAGE_LIMIT}. Paging is opt-in: send \`limit\` (or a \`cursor\`, which pages by ` +
      `${DEFAULT_PAGE_LIMIT}) to get pages; send neither to get the whole list.`,
    ),
  cursor: z.string().max(1024).optional()
    .describe("Opaque cursor from the previous page's `Link: rel=\"next\"` (or `Cosmos-Next-Cursor`)."),
};

export const NEXT_CURSOR_HEADER = "Cosmos-Next-Cursor";

/** One sort column. Every column must be NOT NULL, and the last one unique (`id`). */
export interface SortKey<Row> {
  field: keyof Row & string;
  dir: "asc" | "desc";
  type: "date" | "number" | "string";
}

type CursorValue = string | number | Date;

function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify(values.map((v) => (v instanceof Date ? v.toISOString() : v))))
    .toString("base64url");
}

function decodeCursor<Row>(cursor: string, order: SortKey<Row>[]): CursorValue[] {
  const bad = () => new ProblemError(400, "invalid_request", "Invalid or expired cursor");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!Array.isArray(raw) || raw.length !== order.length) throw bad();
  return order.map((k, i) => {
    const v = raw[i];
    if (k.type === "number" && typeof v === "number" && Number.isFinite(v)) return v;
    if (k.type === "string" && typeof v === "string") return v;
    if (k.type === "date" && typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v);
    throw bad();
  });
}

/** Rows strictly after `values` in `order`: (a > x) OR (a = x AND b > y) OR … */
function keysetWhere<Row>(order: SortKey<Row>[], values: CursorValue[]): Record<string, unknown> {
  return {
    OR: order.map((key, i) => ({
      ...Object.fromEntries(order.slice(0, i).map((k, j) => [k.field, values[j]])),
      [key.field]: { [key.dir === "asc" ? "gt" : "lt"]: values[i] },
    })),
  };
}

export interface CursorPage<Row> {
  /** AND this into the query's `where` (`{ AND: [base, page.where] }`). */
  where: Record<string, unknown>;
  orderBy: Record<string, "asc" | "desc">[];
  /** Fetch this many: one more than the page, to learn whether there is a next. */
  take: number | undefined;
  /** Trim the extra row and build the `Link` headers. */
  finish<T extends Row>(rows: T[]): { rows: T[]; headers: Headers };
}

/**
 * Plan one page. Neither `limit` nor `cursor` means the whole list (see the
 * opt-in note above); a `cursor` alone pages by DEFAULT_PAGE_LIMIT.
 */
export function cursorPage<Row>(opts: {
  request: Request;
  query: { limit?: number; cursor?: string };
  order: SortKey<Row>[];
}): CursorPage<Row> {
  const { request, query, order } = opts;
  const limit = query.limit ?? (query.cursor ? DEFAULT_PAGE_LIMIT : undefined);
  const where = query.cursor ? keysetWhere(order, decodeCursor(query.cursor, order)) : {};
  return {
    where,
    orderBy: order.map((k) => ({ [k.field]: k.dir })),
    take: limit === undefined ? undefined : limit + 1,
    finish(rows) {
      const headers = new Headers();
      if (limit === undefined || rows.length <= limit) return { rows, headers };
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const cursor = encodeCursor(order.map((k) => last[k.field] as CursorValue));
      const url = new URL(request.url);
      const next = new URL(`${url.pathname}${url.search}`, getPublicOrigin(request));
      next.searchParams.set("limit", String(limit));
      next.searchParams.set("cursor", cursor);
      headers.set("Link", `<${next.toString()}>; rel="next"`);
      headers.set(NEXT_CURSOR_HEADER, cursor);
      return { rows: page, headers };
    },
  };
}
