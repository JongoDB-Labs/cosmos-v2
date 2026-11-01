// @vitest-environment node
//
// `narrowAuthToPolicyProjects` — the agent policy's project allowlist as a ceiling on the
// ACTOR'S CONTEXT rather than a check on a model-supplied argument.
//
// The property that matters is NARROWING-ONLY. Two ceilings can be in play at once (a
// project-scoped API key's, and the org's agent policy), and this must return their
// INTERSECTION. If it ever returned the union — or simply replaced the key's scope with the
// policy's — an agent policy would become a way to reach PAST the key driving it, which is
// the opposite of what an allowlist is for.
import { describe, it, expect } from "vitest";
import { narrowAuthToPolicyProjects } from "./project-scope";
import { stubAuth } from "@/lib/testing/tool-auth";
import { Permission } from "@/lib/rbac/permissions";

const ORG = "org-1";
const ME = "11111111-1111-4111-a111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

const auth = (over: Parameters<typeof stubAuth>[2] = {}) =>
  stubAuth(ORG, ME, { orgRole: "OWNER", permissions: Permission.ITEM_READ, ...over });

describe("narrowAuthToPolicyProjects", () => {
  it("returns the context UNCHANGED when no allowlist is set (the permissive default)", () => {
    const before = auth();
    const after = narrowAuthToPolicyProjects(before, null);
    // Identity, not just equality: an org that never opted in must take no new code path.
    expect(after).toBe(before);
    expect(after.projectScope).toBeUndefined();
  });

  it("makes the allowlist the ceiling when the context carries no scope of its own", () => {
    const after = narrowAuthToPolicyProjects(auth(), [A, B]);
    expect(after.projectScope).toEqual([A, B]);
  });

  it("INTERSECTS with a project-scoped API key's ceiling — never widens it", () => {
    // The key may touch A and B. The policy allows B and C. Only B is in both; C must NOT
    // appear, or the policy would have handed the agent a project the key cannot reach.
    const after = narrowAuthToPolicyProjects(auth({ projectScope: [A, B], isApiKey: true }), [B, C]);
    expect(after.projectScope).toEqual([B]);
    expect(after.projectScope).not.toContain(C);
  });

  it("yields an EMPTY scope when the two ceilings are disjoint (reach nothing, not everything)", () => {
    const after = narrowAuthToPolicyProjects(auth({ projectScope: [A], isApiKey: true }), [B]);
    // `[]` is the fail-closed outcome. `undefined` here would mean UNRESTRICTED — the exact
    // inversion that makes an empty allowlist the most dangerous value instead of the safest.
    expect(after.projectScope).toEqual([]);
    expect(after.projectScope).not.toBeUndefined();
  });

  it("treats an empty allowlist as 'no projects', not 'no restriction'", () => {
    const after = narrowAuthToPolicyProjects(auth(), []);
    expect(after.projectScope).toEqual([]);
  });

  it("does not mutate the context it was given", () => {
    const before = auth({ projectScope: [A, B], isApiKey: true });
    narrowAuthToPolicyProjects(before, [B]);
    expect(before.projectScope).toEqual([A, B]);
  });

  it("carries every other field through untouched", () => {
    const before = auth({ projectScope: [A, B], isApiKey: true, scopes: ["items:read"] });
    const after = narrowAuthToPolicyProjects(before, [A]);
    expect(after.orgId).toBe(before.orgId);
    expect(after.userId).toBe(before.userId);
    expect(after.orgRole).toBe(before.orgRole);
    expect(after.permissions).toBe(before.permissions);
    expect(after.isApiKey).toBe(true);
    expect(after.scopes).toEqual(["items:read"]);
  });

  it("de-duplicates, so membership tests stay a clean set", () => {
    const after = narrowAuthToPolicyProjects(auth(), [A, A, B]);
    expect(after.projectScope).toEqual([A, B]);
  });
});
