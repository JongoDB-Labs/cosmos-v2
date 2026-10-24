// @vitest-environment node
//
// No key minted before per-operation scopes loses anything (ops' condition on
// PR4a). Two halves:
//
//   1. Each scope that existed before keeps exactly its mask (frozen below from
//      main as of 2.454): `read` gains ORG_READ and ANALYTICS_READ, which the
//      spec documents as reads; the rest are byte-identical.
//   2. No loss against the mask: for every contracted operation and every
//      pre-existing scope, if the old mask held every bit the handler checks
//      (read from its source), the new scope gate passes.
//
// The one named exception: handlers that check no bit at all (the member list,
// saved views) were reachable by ANY key, including `rules:run` and a bare
// `members:read`, which carry no read. Those two now need `read` for them, as
// the scope table always said ("rules:run: deliberately no read").
//
// The manager/admin role path is not "reach": #1130 closed it as a bug.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Permission } from "@/lib/rbac/permissions";
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
const NO_READ = new Set(["rules:run", "members:read"]);

describe("pre-existing scopes keep their masks", () => {
  it.each(Object.keys(BEFORE))("%s", (scope) => {
    const extra = scope === "read" ? P.ORG_READ | P.ANALYTICS_READ : 0n;
    expect(scopeMask([scope])).toBe(BEFORE[scope] | extra);
  });
});

/** Every contract, with the source of the route.ts beside it. */
function contracts(): { contract: RouteContract; src: string }[] {
  const gen = readFileSync(path.join(process.cwd(), "src/lib/openapi/contracts.generated.ts"), "utf8");
  const files = [...gen.matchAll(/from "@\/(app\/[^"]+)\/route\.contract"/g)].map((m) =>
    path.join(process.cwd(), "src", m[1], "route.ts"),
  );
  expect(files).toHaveLength(contractModules.length);
  return contractModules.flatMap((mod, i) =>
    Object.values(mod)
      .filter((v): v is RouteContract => !!v && typeof v === "object" && "operationId" in v && "method" in v)
      .map((contract) => ({ contract, src: readFileSync(files[i], "utf8") })),
  );
}

/** The bits a handler checks: Permission.X references and "X" action keys in its body. */
function bitsChecked(src: string, method: string): bigint {
  const parts = src.split(/export async function (GET|POST|PUT|PATCH|DELETE)\b/);
  const i = parts.indexOf(method.toUpperCase());
  expect(i, `no ${method.toUpperCase()} handler`).toBeGreaterThan(0);
  const body = parts[i + 1];
  const keys = new Set<string>();
  for (const m of body.matchAll(/Permission\.([A-Z_]+)/g)) keys.add(m[1]);
  for (const m of body.matchAll(/\b(?:requireAccess|requireProjectRead|assertProjectRead)\([^)]*?"([A-Z_]+)"/g)) keys.add(m[1]);
  let mask = 0n;
  for (const k of keys) mask |= (P as Record<string, bigint>)[k] ?? 0n;
  return mask;
}

describe("no pre-existing scope loses an operation its mask reached", () => {
  const ctx = (scopes: string[]) =>
    ({ userId: "u", orgId: "o", orgRole: "MEMBER", permissions: 0n, basePermissions: 0n, abacRules: [], scopes }) as never;
  const all = contracts();
  const cases = all.flatMap(({ contract, src }) => {
    const need = bitsChecked(src, contract.method);
    return Object.keys(BEFORE)
      .filter((s) => (BEFORE[s] & need) === need) // the old mask reached it
      .filter((s) => !(need === 0n && NO_READ.has(s))) // the named exception
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
