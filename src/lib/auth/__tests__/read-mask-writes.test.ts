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
import HELPER_GATED from "./helper-gated-writes.baseline.json";
import UNGATED from "./ungated-writes.baseline.json";

/**
 * Handlers that already met that bar before scopes were enforced. Each acts on
 * the caller's own state (watching an item, their tab layout) or is a read sent
 * as POST (search, and the query language's validate and run, which cqlGate
 * holds to ITEM_READ).
 * Frozen: a new entry fails the test, so it is a decision, not drift.
 */
const BASELINE = [
  "DELETE v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/watch",
  "POST v1/orgs/[orgId]/cql/ai",
  "POST v1/orgs/[orgId]/cql/predicate",
  "POST v1/orgs/[orgId]/cql/validate",
  "POST v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/watch",
  "POST v1/orgs/[orgId]/work-items/aggregate",
  "POST v1/orgs/[orgId]/work-items/query",
  "POST v1/orgs/[orgId]/work-items/search",
  "PUT v1/orgs/[orgId]/projects/[projectId]/tab-prefs",
];

/** Every write handler a key holding exactly `mask` could pass on bits alone. */
export function writesReachableBy(mask: bigint): string[] {
  const out: string[] = [];
  for (const file of globSync("src/app/api/**/route.ts")) {
    const src = readFileSync(file, "utf8");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const code = handlerCode(src, method, file);
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

/**
 * Library helpers that decide a write from the caller's ROLE (org admin,
 * project or channel manager, supervisor, uploader, owner) rather than from a
 * bit the scan above can read. A key carries its minter's role, so each of
 * these must cap the role with roleCountsFor (lib/rbac/key-role.ts) or an
 * equivalent; the bit scan cannot check that, which is how the supervisor
 * approval path (#1135) slipped past it.
 */
const ROLE_HELPERS = [
  "canManageProject", "canAdministerProject", "requireProjectManage", "getManagedProjectIds",
  "canManageBoardsInProject", "canWriteInProject", "approvalAuthority", "isManagerOf",
  "canManageDocument", "withManageFlags", "canManageChannelGiven", "canDeleteMessageGiven",
  "canEdit", "canDelete", "viewerScope", "isOrgAdministrator",
];

/**
 * The same decision written inline: a comparison against an org or project
 * role, a staff/admin flag, or the role passed on to a library that decides.
 * Each is reported under the label on the left.
 */
const INLINE_ROLE_CHECKS: [string, RegExp][] = [
  ["orgRole", /\borgRole\s*[!=]==|[!=]==\s*(?:\w+\.)*orgRole\b/],
  ["OrgRole.OWNER|ADMIN", /\bOrgRole\.(?:OWNER|ADMIN)\b/],
  ["role literal", /[!=]==\s*["'](?:OWNER|ADMIN|MANAGER|LEAD)["']|["'](?:OWNER|ADMIN|MANAGER|LEAD)["']\s*[!=]==/],
  ["isStaff", /\bisStaff\b/],
  ["isAdmin*", /\bisAdmin\w*\b/],
  // The role handed to a library that decides with it (the assistant's tools).
  ["orgRole handed on", /\b(?:orgRole|role):\s*ctx\.orgRole\b/],
];

/**
 * Every write handler that decides by role, with what it consults. A handler
 * that also calls roleCountsFor is marked so, which is the cap a key needs.
 */
export function helperGatedWrites(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of globSync("src/app/api/**/route.ts")) {
    const src = readFileSync(file, "utf8");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const code = handlerCode(src, method, file);
      if (!code) continue;
      const used = [
        ...ROLE_HELPERS.filter((h) => new RegExp(`\\b${h}\\(`).test(code)),
        ...INLINE_ROLE_CHECKS.filter(([, re]) => re.test(code)).map(([label]) => label),
      ];
      if (used.length && /\broleCountsFor\(/.test(code)) used.push("roleCountsFor");
      if (used.length) out[`${method} ${file.replace(/^src\/app\/api\//, "").replace(/\/route\.ts$/, "")}`] = used;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

describe("writes gated by a role helper are listed, so a new one is reviewed", () => {
  it("matches helper-gated-writes.baseline.json exactly", () => {
    // A new entry means a write decided by role: check that a key's role is
    // capped (roleCountsFor) on that path, then add it here.
    expect(helperGatedWrites()).toEqual(HELPER_GATED);
  });
});

/**
 * Write handlers whose gates show the scan no bit at all. Every scope's mask
 * "reaches" them, so the per-scope lists above leave them out, and they are
 * where a key-reachable write hides: some are session-only (/me, auth),
 * signed webhooks or forwards to a gated route; others gate through a bit in
 * a variable or a local helper the scan can't read. Frozen so that a new one
 * is looked at: say how it is gated, then add it.
 */
export function ungatedWrites(): string[] {
  const out: string[] = [];
  for (const file of globSync("src/app/api/**/route.ts")) {
    const src = readFileSync(file, "utf8");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const code = handlerCode(src, method, file);
      if (code && gateBits(code) === 0n) {
        out.push(`${method} ${file.replace(/^src\/app\/api\//, "").replace(/\/route\.ts$/, "")}`);
      }
    }
  }
  return out.sort();
}

describe("writes with no gate bit are listed, so a new one is reviewed", () => {
  it("matches ungated-writes.baseline.json exactly", () => {
    expect(ungatedWrites()).toEqual(UNGATED);
  });
});
