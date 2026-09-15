import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_QUERY_PARAMS, unknownQueryParams } from "./parse";

/**
 * An unrecognised query parameter used to be silently dropped, so `?search=`,
 * `?q=`, `?limit=`, `?offset=` and `?cursor=` each returned an unfiltered first
 * page rather than an error.
 *
 * That is the worst failure mode available: a filter that silently does not
 * filter returns plausible WRONG answers. A caller paging with `?offset=`
 * re-read page 1 sixteen times and concluded the ticket it wanted did not
 * exist — the API answered truthfully and uselessly that there were 25 items,
 * every time. An error would have cost one request.
 */

const q = (s: string) => new URLSearchParams(s);

describe("unknownQueryParams", () => {
  it("names the params that inspired this", () => {
    // The exact set reported from a real integration attempt.
    for (const p of ["search", "q", "ticketKey", "projectKey", "limit", "offset", "cursor", "skip"]) {
      expect(unknownQueryParams(q(`${p}=x`)), p).toEqual([p]);
    }
  });

  it("accepts every parameter the UI actually sends", () => {
    // Taken from issues-view's toQueryString. If this ever fails, the guard is
    // about to 400 the product's own list view.
    const ui = "project=p&type=t&status=s&assignee=a&label=l&priority=HIGH"
      + "&text=hello&archived=only&createdFrom=2026-01-01&createdTo=2026-02-01"
      + "&updatedFrom=2026-01-01&updatedTo=2026-02-01&page=2&pageSize=25";
    expect(unknownQueryParams(q(ui))).toEqual([]);
  });

  it("accepts a route's own extra params only where that route passes them", () => {
    // watchedByMe is handled by the search route itself, not the shared parser.
    expect(unknownQueryParams(q("watchedByMe=1"))).toEqual(["watchedByMe"]);
    expect(unknownQueryParams(q("watchedByMe=1"), ["watchedByMe"])).toEqual([]);
  });

  it("reports an unknown param once even when repeated", () => {
    expect(unknownQueryParams(q("bogus=a&bogus=b"))).toEqual(["bogus"]);
  });

  it("does not report repeated KNOWN params", () => {
    expect(unknownQueryParams(q("project=a&project=b&cf=x&cf=y"))).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(unknownQueryParams(q(""))).toEqual([]);
  });

  it("reports several at once, so one round-trip fixes them all", () => {
    expect(unknownQueryParams(q("limit=5&offset=10&sortBy=x")).sort())
      .toEqual(["limit", "offset", "sortBy"]);
  });
});

describe("the allowlist cannot drift from the parser", () => {
  // The dangerous direction of this change is the OPPOSITE of the bug it fixes:
  // a parameter added to the parser but not to KNOWN_QUERY_PARAMS becomes a
  // 400 on a filter that genuinely works. This reads the parser and asserts
  // every parameter it consumes is declared.
  const SRC = readFileSync(join(process.cwd(), "src/lib/work-items/query/parse.ts"), "utf8");
  const body = SRC.slice(0, SRC.indexOf("export const KNOWN_QUERY_PARAMS"));

  const readByParser = [
    ...body.matchAll(/params\.get(?:All)?\("([a-zA-Z_]+)"\)/g),
    ...body.matchAll(/multi\(params,\s*"([a-zA-Z_]+)"\)/g),
  ].map((m) => m[1]);

  it("finds the parameters the parser reads", () => {
    // Control: if the regexes matched nothing, the assertion below would pass
    // vacuously and the drift guard would be worthless.
    expect(readByParser.length).toBeGreaterThan(10);
    expect(readByParser).toContain("project");
    expect(readByParser).toContain("page");
  });

  it("declares every one of them", () => {
    const missing = [...new Set(readByParser)].filter((p) => !KNOWN_QUERY_PARAMS.has(p));
    expect(missing, `parser reads these but KNOWN_QUERY_PARAMS omits them: ${missing.join(", ")}`)
      .toEqual([]);
  });
});
