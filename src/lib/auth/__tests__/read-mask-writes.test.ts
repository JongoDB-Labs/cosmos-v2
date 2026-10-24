// @vitest-environment node
//
// No bit in the `read` scope's mask may be, on its own, what gates a write.
// The mask is recomputed from a key's scopes on every request, so a bit added
// to it reaches every existing read key on every route, contracted or not, and
// ~300 routes don't pass through the scope gate. Widening `read` with ORG_READ
// (ops' review of #1135) would have let read-only keys edit documents, post
// comments and feedback and create widgets, because those writes gate on
// ORG_READ alone.
//
// The scan reads every src/app/api route: for each POST/PUT/PATCH/DELETE
// handler, the bits it GATES on (gate-bits.ts: gate calls only, in its body and
// the module's own helpers it calls, the key arm of a session/key ternary). A
// handler whose gate bits all sit inside a mask is writable by that scope.
import { describe, it, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { Permission } from "@/lib/rbac/permissions";
import { gateBits, handlerCode } from "./gate-bits";
import { scopeMask } from "@/lib/auth/api-key";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import BASELINE_BY_SCOPE from "./scope-writes.baseline.json";

/**
 * Handlers that already met that bar before scopes were enforced. Each acts on
 * the caller's own state (watching an item, their tab layout) or is a read sent
 * as POST (search); the Teams digest awaits ops' call on its scheduled caller.
 * Frozen: a new entry fails the test, so it is a decision, not drift.
 */
const BASELINE = [
  "DELETE v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/watch",
  "POST v1/orgs/[orgId]/integrations/teams/digest",
  "POST v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/watch",
  "POST v1/orgs/[orgId]/work-items/search",
  "PUT v1/orgs/[orgId]/projects/[projectId]/tab-prefs",
];

/** Every write handler a key holding exactly `mask` could pass on bits alone. */
export function writesReachableBy(mask: bigint): string[] {
  const out: string[] = [];
  for (const file of globSync("src/app/api/**/route.ts")) {
    const src = readFileSync(file, "utf8");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const code = handlerCode(src, method);
      if (!code) continue;
      const need = gateBits(code);
      if (need !== 0n && (need & ~mask) === 0n) {
        out.push(`${method} ${file.replace(/^src\/app\/api\//, "").replace(/\/route\.ts$/, "")}`);
      }
    }
  }
  return out.sort();
}

describe("the read scope's mask gates no write", () => {
  it("scans a real surface (not vacuous)", () => {
    expect(globSync("src/app/api/**/route.ts").length).toBeGreaterThan(300);
  });

  it("only the frozen baseline is writable on read bits alone", () => {
    expect(writesReachableBy(scopeMask(["read"]))).toEqual([...BASELINE].sort());
  });

  it("would catch ORG_READ in the mask (the #1135 review finding)", () => {
    const widened = writesReachableBy(scopeMask(["read"]) | Permission.ORG_READ);
    expect(widened.length).toBeGreaterThan(BASELINE.length);
    expect(widened).toContain("POST v1/orgs/[orgId]/mentions/resolve");
  });
});

/**
 * Every scope, not just `read`: the writes each scope's mask reaches on bits
 * alone, frozen in scope-writes.baseline.json. A change to a mask, or a route
 * whose gate moves onto a bit some scope carries, changes a list and fails
 * here, so it is reviewed as a diff of that file, never discovered later.
 * (Regenerate it by hand from writesReachableBy when the change is intended.)
 */
describe("every scope reaches exactly its frozen writes", () => {
  it("covers every scope", () => {
    expect(Object.keys(BASELINE_BY_SCOPE).sort()).toEqual([...API_KEY_SCOPES].sort());
  });

  it.each([...API_KEY_SCOPES])("%s", (scope) => {
    expect(writesReachableBy(scopeMask([scope]))).toEqual((BASELINE_BY_SCOPE as Record<string, string[]>)[scope]);
  });

  it.each(["time:read", "audit:read", "members:read"])("%s, a read scope, reaches no write at all", (scope) => {
    expect(writesReachableBy(scopeMask([scope]))).toEqual([]);
  });

  it("read reaches only its frozen pre-existing handlers", () => {
    expect((BASELINE_BY_SCOPE as Record<string, string[]>).read).toEqual([...BASELINE].sort());
  });

  it("would catch ANALYTICS_READ in planning:write: the SharePoint export POST", () => {
    const widened = writesReachableBy(scopeMask(["planning:write"]) | Permission.ANALYTICS_READ);
    expect(widened).toContain("POST v1/orgs/[orgId]/projects/[projectId]/export/sharepoint");
  });
});
