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
// handler, the bits it checks (Permission.X and action keys, in its body and
// in the module's own helpers it calls). A handler whose bits all sit inside
// the read mask is writable by a read key.
import { describe, it, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { Permission } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

/**
 * Handlers that already met that bar before scopes were enforced. Each acts on
 * the caller's own state, or is a read sent as POST. Frozen: a new entry fails
 * the test, so it is a decision, not drift.
 */
const BASELINE = [
  "POST v1/orgs/[orgId]/work-items/search",
  "POST v1/orgs/[orgId]/saved-views",
  "DELETE v1/orgs/[orgId]/saved-views/[viewId]",
  "PUT v1/orgs/[orgId]/saved-views/[viewId]/favorite",
  "DELETE v1/orgs/[orgId]/saved-views/[viewId]/favorite",
  "POST v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/watch",
  "DELETE v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/watch",
  "PATCH v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/[commentId]",
  "PUT v1/orgs/[orgId]/projects/[projectId]/tab-prefs",
  "PATCH v1/orgs/[orgId]/projects/[projectId]/pm-comments/[commentId]",
  "POST v1/orgs/[orgId]/integrations/teams/digest",
];

function bitsChecked(body: string, preamble: string): bigint {
  const helpers = [...preamble.matchAll(/^(?:async )?function (\w+)\([\s\S]*?\n\}/gm)];
  for (const [fn, name] of helpers) if (new RegExp(`\\b${name}\\(`).test(body)) body += fn;
  const keys = new Set([...body.matchAll(/Permission\.([A-Z_]+)/g)].map((m) => m[1]));
  for (const m of body.matchAll(/\b(?:requireAccess|requireProjectRead|assertProjectRead)\([^)]*?"([A-Z_]+)"/g)) keys.add(m[1]);
  let need = 0n;
  for (const k of keys) need |= (Permission as Record<string, bigint>)[k] ?? 0n;
  return need;
}

/** Every write handler a key holding exactly `mask` could pass on bits alone. */
export function writesReachableBy(mask: bigint): string[] {
  const out: string[] = [];
  for (const file of globSync("src/app/api/**/route.ts")) {
    const parts = readFileSync(file, "utf8").split(/export async function (GET|POST|PUT|PATCH|DELETE)\b/);
    for (let i = 1; i < parts.length; i += 2) {
      if (parts[i] === "GET") continue;
      const need = bitsChecked(parts[i + 1], parts[0]);
      if (need !== 0n && (need & ~mask) === 0n) {
        out.push(`${parts[i]} ${file.replace(/^src\/app\/api\//, "").replace(/\/route\.ts$/, "")}`);
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
