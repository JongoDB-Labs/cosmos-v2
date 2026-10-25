// @vitest-environment node
//
// No key minted before per-operation scopes loses anything (ops' condition on
// PR4a). Two halves:
//
//   1. Each scope that existed before keeps exactly its mask, byte-identical
//      (frozen below from main as of 2.454). A bit added to a mask reaches every
//      existing key on every route, including the ones the gate doesn't cover.
//   2. No loss against the mask: for every contracted operation and every
//      pre-existing scope, if the old mask held every bit the handler checks
//      (read from its source), the new scope gate passes.
//
// Two named exceptions (ops, 2026-10-24), both listed for API clients in the
// changelog:
//   1. Handlers that check no bit at all (the member list, saved views) were
//      reachable by ANY key, including `rules:run` and a bare `members:read`,
//      which carry no read. Those two now need `read` for them, as the scope
//      table always said ("rules:run: deliberately no read").
//   2. Saved-view writes (star, unstar, update) check no bit either, so a `read`
//      key could edit its owner's own views. They now need `items:write`: a
//      read scope that writes is the wrong precedent for the scope model.
//      A filter's email subscriptions (create, update, delete) are the same
//      shape and the same rule; they are new, so no key loses them.
//
// And one class that no key reaches at all: the filter-email unsubscribe link
// is authenticated by the MAC'd token in its URL, not by a session or a key.
// Its contracts name no scopes, so every key is refused, and its handler
// authenticates no caller.
//
// The manager/admin role path is not "reach": #1130 closed it as a bug.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Permission } from "@/lib/rbac/permissions";
import { gateBits, handlerCode } from "./gate-bits";
import { scopeMask } from "@/lib/auth/api-key";
import { assertScopes } from "@/lib/openapi/org-context";
import { contractModules } from "@/lib/openapi/contracts.generated";
import type { RouteContract } from "@/lib/openapi/contract";

const P = Permission;
/** main's SCOPE_MASK before this PR, frozen. */
const BEFORE: Record<string, bigint> = {
  read: P.PROJECT_READ | P.ITEM_READ | P.COMMENT_READ | P.OKR_READ | P.SPRINT_READ,
  "items:write":
    P.PROJECT_READ | P.PROJECT_UPDATE | P.ITEM_READ | P.ITEM_CREATE | P.ITEM_UPDATE |
    P.COMMENT_CREATE | P.COMMENT_READ | P.OKR_READ | P.OKR_CREATE | P.SPRINT_READ | P.SPRINT_CREATE,
  "members:read": 0n,
  "documents:write": P.PROJECT_READ | P.PROJECT_UPDATE | P.ITEM_READ | P.ITEM_CREATE,
  "rules:run": P.RULES_RUN,
};
/**
 * Exception 1, pinned: the operations whose handlers check no bit, and the
 * pre-existing scopes (no `read` in them) that lose them. A new zero-bit
 * handler is not exempt: it fails this test until it is listed here.
 */
const LOST_WITHOUT_READ: Record<string, string[]> = {
  listMembers: ["rules:run", "members:read"],
  updateSavedView: ["rules:run", "members:read"],
};
/** Exception 2: writes with no bit check that now need a write scope. */
const SAVED_VIEW_WRITES = new Set([
  "starSavedView",
  "unstarSavedView",
  "updateSavedView",
  "createFilterSubscription",
  "updateFilterSubscription",
  "deleteFilterSubscription",
]);
/** Authenticated by a token in the URL: no key reaches them, before or now. */
const TOKEN_AUTHENTICATED = new Set(["confirmFilterUnsubscribe", "filterUnsubscribe"]);
/**
 * Not an exception, a gap in what this test reads: these handlers gate a key
 * on COMMENT_CREATE (`ctx.isApiKey ? "COMMENT_CREATE" : "COMMENT_READ"`) since
 * read-key-writes.test.ts closed read keys editing and erasing comments, before
 * they had contracts. `bitsChecked` reads the session arm, so it credits `read`
 * with them; no read key has reached them since that fix.
 */
const KEY_ARM_WRITES = new Set(["updateWorkItemComment", "deleteWorkItemComment"]);

describe("pre-existing scopes keep their masks", () => {
  it.each(Object.keys(BEFORE))("%s", (scope) => {
    expect(scopeMask([scope])).toBe(BEFORE[scope]);
  });
});

/** Every contract, with the source of the route.ts beside it. */
function contracts(): { contract: RouteContract; src: string; file: string }[] {
  const gen = readFileSync(path.join(process.cwd(), "src/lib/openapi/contracts.generated.ts"), "utf8");
  const files = [...gen.matchAll(/from "@\/(app\/[^"]+)\/route\.contract"/g)].map((m) =>
    path.join(process.cwd(), "src", m[1], "route.ts"),
  );
  expect(files).toHaveLength(contractModules.length);
  return contractModules.flatMap((mod, i) =>
    Object.values(mod)
      .filter((v): v is RouteContract => !!v && typeof v === "object" && "operationId" in v && "method" in v)
      .map((contract) => ({ contract, src: readFileSync(files[i], "utf8"), file: files[i] })),
  );
}

/**
 * The bits a handler's gates required BEFORE this PR (gate-bits.ts). The
 * `ctx.isApiKey ? keyBit : sessionBit` gates are new here, and before them
 * every caller met the session arm, so that is what a pre-existing key had to hold.
 */
function bitsChecked(src: string, method: string, file: string): bigint {
  // With the file, helpers imported from sibling routes are followed too (the
  // bare work-items collection runs the search's).
  const code = handlerCode(src, method, file);
  expect(code, `no ${method.toUpperCase()} handler`).not.toBeNull();
  return gateBits(code!, { forKey: false });
}

describe("no pre-existing scope loses an operation its mask reached", () => {
  const ctx = (scopes: string[]) =>
    ({ userId: "u", orgId: "o", orgRole: "MEMBER", permissions: 0n, basePermissions: 0n, abacRules: [], scopes, isApiKey: true }) as never;
  const all = contracts();
  const cases = all.flatMap(({ contract, src, file }) => {
    if (TOKEN_AUTHENTICATED.has(contract.operationId)) return [];
    const need = bitsChecked(src, contract.method, file);
    return Object.keys(BEFORE)
      .filter((s) => (BEFORE[s] & need) === need) // the old mask reached it
      .filter((s) => !LOST_WITHOUT_READ[contract.operationId]?.includes(s)) // exception 1
      .filter((s) => !(SAVED_VIEW_WRITES.has(contract.operationId) && s === "read")) // exception 2
      .filter((s) => !(KEY_ARM_WRITES.has(contract.operationId) && s === "read")) // key arm already needs a write
      .map((s) => [contract.operationId, s, contract] as const);
  });

  it("covers a real share of the surface (not vacuous)", () => {
    expect(all.length).toBeGreaterThanOrEqual(40);
    expect(cases.length).toBeGreaterThanOrEqual(50);
  });

  it.each(cases.map(([op, s, c]) => [`${op} with ${s}`, s, c] as const))("%s still passes the gate", (_n, scope, contract) => {
    expect(() => assertScopes(ctx([scope]), contract)).not.toThrow();
  });
});

describe("the named exceptions are exactly what they say", () => {
  const ctx = (scopes: string[]) =>
    ({ userId: "u", orgId: "o", orgRole: "MEMBER", permissions: 0n, basePermissions: 0n, abacRules: [], scopes, isApiKey: true }) as never;
  const byId = new Map(contracts().map(({ contract }) => [contract.operationId, contract]));

  it.each([...SAVED_VIEW_WRITES])("%s needs items:write; a read key is refused", (op) => {
    const c = byId.get(op)!;
    expect(() => assertScopes(ctx(["read"]), c)).toThrow();
    expect(() => assertScopes(ctx(["items:write"]), c)).not.toThrow();
  });

  it.each([...TOKEN_AUTHENTICATED])("%s: every key is refused, and the handler authenticates no caller", (op) => {
    const found = contracts().find(({ contract }) => contract.operationId === op)!;
    expect(found.contract.scopes).toEqual([]);
    for (const s of Object.keys(BEFORE)) expect(() => assertScopes(ctx([s]), found.contract)).toThrow();
    const code = handlerCode(found.src, found.contract.method, found.file)!;
    expect(code).not.toMatch(/getAuthContext|orgContext|resolveAuth|cqlGate|getCurrentUser|verifyApiKey/);
  });

  it.each([...KEY_ARM_WRITES])("%s needs items:write at the gate, as its key arm already did", (op) => {
    const c = byId.get(op)!;
    expect(c.scopes).toEqual(["items:write"]);
    expect(() => assertScopes(ctx(["read"]), c)).toThrow();
    expect(() => assertScopes(ctx(["items:write"]), c)).not.toThrow();
    // The handler still gates a key on COMMENT_CREATE, which only items:write carries.
    const src = readFileSync(path.join(process.cwd(), "src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/[commentId]/route.ts"), "utf8");
    expect(src).toMatch(/ctx\.isApiKey \? "COMMENT_CREATE" : "COMMENT_READ"/);
  });

  it.each(Object.entries(LOST_WITHOUT_READ))("%s: each listed scope is refused", (op, scopes) => {
    const c = byId.get(op)!;
    for (const s of scopes) expect(() => assertScopes(ctx([s]), c)).toThrow();
  });

  it("the member list needs read; rules:run and a bare members:read are refused", () => {
    const c = byId.get("listMembers")!;
    expect(() => assertScopes(ctx(["rules:run"]), c)).toThrow();
    expect(() => assertScopes(ctx(["members:read"]), c)).toThrow();
    expect(() => assertScopes(ctx(["read"]), c)).not.toThrow();
  });
});
