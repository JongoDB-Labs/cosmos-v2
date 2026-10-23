import { describe, it, expect } from "vitest";
import { cursorPage, DEFAULT_PAGE_LIMIT, NEXT_CURSOR_HEADER } from "../paginate";
import { ProblemError } from "../problem";

type Row = { createdAt: Date; id: string };
const order = [
  { field: "createdAt", dir: "desc", type: "date" },
  { field: "id", dir: "desc", type: "string" },
] as const satisfies readonly { field: keyof Row; dir: "asc" | "desc"; type: "date" | "string" }[];

const req = (url = "http://localhost:3000/api/v1/orgs/o/projects?archived=true", headers: Record<string, string> = {}) =>
  new Request(url, { headers });
const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ createdAt: new Date(Date.UTC(2026, 9, 30 - i)), id: `id-${i}` }));

describe("cursorPage", () => {
  it("a cookie caller with no limit is unbounded, as the UI expects", () => {
    const page = cursorPage<Row>({ request: req(), query: {}, bearer: false, order: [...order] });
    expect(page.take).toBeUndefined();
    const { rows: out, headers } = page.finish(rows(300));
    expect(out).toHaveLength(300);
    expect(headers.get("link")).toBeNull();
  });

  it(`a bearer caller defaults to ${DEFAULT_PAGE_LIMIT}`, () => {
    const page = cursorPage<Row>({ request: req(), query: {}, bearer: true, order: [...order] });
    expect(page.take).toBe(DEFAULT_PAGE_LIMIT + 1);
  });

  it("fetches one extra row to know there is a next page, and links it on the PUBLIC origin", () => {
    const page = cursorPage<Row>({
      request: req(undefined, { "x-forwarded-host": "cosmos.example.gov", "x-forwarded-proto": "https" }),
      query: { limit: 2 }, bearer: false, order: [...order],
    });
    expect(page.take).toBe(3);
    const { rows: out, headers } = page.finish(rows(3));
    expect(out.map((r) => r.id)).toEqual(["id-0", "id-1"]);
    const link = headers.get("link")!;
    expect(link).toMatch(/^<https:\/\/cosmos\.example\.gov\/api\/v1\/orgs\/o\/projects\?archived=true&limit=2&cursor=[\w-]+>; rel="next"$/);
    expect(link).toContain(headers.get(NEXT_CURSOR_HEADER)!);
  });

  it("no Link on the last page", () => {
    const page = cursorPage<Row>({ request: req(), query: { limit: 2 }, bearer: false, order: [...order] });
    expect(page.finish(rows(2)).headers.get("link")).toBeNull();
  });

  it("the cursor resumes strictly after the last row, in sort order", () => {
    const first = cursorPage<Row>({ request: req(), query: { limit: 2 }, bearer: false, order: [...order] });
    const cursor = first.finish(rows(3)).headers.get(NEXT_CURSOR_HEADER)!;
    const next = cursorPage<Row>({ request: req(), query: { limit: 2, cursor }, bearer: false, order: [...order] });
    const last = rows(2)[1];
    expect(next.where).toEqual({
      OR: [
        { createdAt: { lt: last.createdAt } },
        { createdAt: last.createdAt, id: { lt: "id-1" } },
      ],
    });
    expect(next.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it.each(["not-base64!", Buffer.from("[1]").toString("base64url"), Buffer.from('["nope","id"]').toString("base64url")])(
    "a tampered or foreign cursor is a 400, not a 500: %s",
    (cursor) => {
      expect(() => cursorPage<Row>({ request: req(), query: { cursor }, bearer: false, order: [...order] }))
        .toThrow(ProblemError);
    },
  );
});
