import { describe, it, expect } from "vitest";
import { requireAccess, requireAccessForEach, requirePolicy } from "./require-access";
import { Permission } from "@/lib/rbac/permissions";
import type { AbacRule } from "./engine";
import type { AuthContext } from "@/lib/rbac/check";

/**
 * `requirePolicy` is `requireAccess` without the bit check: it applies the deny
 * rules on an action, and a project-limited key's scope, to a caller another
 * gate has already admitted. The interval doors use it after
 * `requireProjectManage`, which admits a project's MANAGER without the
 * org-wide SPRINT_UPDATE bit.
 *
 * Each case pairs it with `requireAccess` or with a twin input, so the test
 * says what differs and not only what passes.
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A MEMBER without SPRINT_UPDATE, the case `requireProjectManage`'s manager branch admits. */
function member(rules: AbacRule[] = [], extra: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "u1",
    orgId: "o1",
    orgRole: "MEMBER",
    permissions: 0n,
    basePermissions: 0n,
    abacRules: rules,
    ...extra,
  };
}

const denyOn = (projectId: string, action: AbacRule["actions"][number] = "SPRINT_UPDATE"): AbacRule => ({
  effect: "deny",
  actions: [action],
  conditions: [{ attr: "projectId", op: "eq", value: projectId }],
});

const resource = { orgId: "o1", projectId: PROJECT };

describe("requirePolicy: the access rules on an action, not the bit", () => {
  it("does not ask for the bit, where requireAccess does", async () => {
    await expect(requirePolicy(member(), "SPRINT_UPDATE", resource)).resolves.toBeUndefined();
    await expect(requireAccess(member(), "SPRINT_UPDATE", resource)).rejects.toThrow("Access denied by policy");
  });

  it("refuses when a deny on the action matches the resource", async () => {
    await expect(requirePolicy(member([denyOn(PROJECT)]), "SPRINT_UPDATE", resource)).rejects.toThrow(
      "Access denied by policy",
    );
  });

  it("allows when the same deny names another project", async () => {
    await expect(requirePolicy(member([denyOn(OTHER)]), "SPRINT_UPDATE", resource)).resolves.toBeUndefined();
  });

  it("ignores a deny on a different action", async () => {
    await expect(
      requirePolicy(member([denyOn(PROJECT, "SPRINT_COMPLETE")]), "SPRINT_UPDATE", resource),
    ).resolves.toBeUndefined();
  });

  it("keeps a project-limited key inside its projects", async () => {
    await expect(
      requirePolicy(member([], { isApiKey: true, projectScope: [OTHER] }), "SPRINT_UPDATE", resource),
    ).rejects.toThrow("Access denied by policy");
    await expect(
      requirePolicy(member([], { isApiKey: true, projectScope: [PROJECT] }), "SPRINT_UPDATE", resource),
    ).resolves.toBeUndefined();
  });
});

// An empty row list (an empty bulk selection) still needs the permission, as
// one row would: the bit, with the owner's break-glass and a key's scope mask
// as requireAccess applies them. It evaluates no rule, since there is no row
// for one to be about.
describe("requireAccessForEach with no rows", () => {
  const denyAll: AbacRule = { effect: "deny", actions: ["ITEM_CREATE"], conditions: [] };
  const withBit = (rules: AbacRule[] = [], extra: Partial<AuthContext> = {}) =>
    member(rules, { permissions: Permission.ITEM_CREATE, ...extra });

  it("refuses a caller without the bit", async () => {
    await expect(requireAccessForEach(member(), "ITEM_CREATE", [])).rejects.toThrow("Access denied by policy");
  });

  it("lets a caller with the bit through, and asks no rule", async () => {
    await expect(requireAccessForEach(withBit([denyAll]), "ITEM_CREATE", [])).resolves.toBeUndefined();
    // Control: the same rule refuses a row.
    await expect(requireAccessForEach(withBit([denyAll]), "ITEM_CREATE", [resource])).rejects.toThrow();
  });

  it("keeps the owner's break-glass for a person, and not for an owner's key without the bit", async () => {
    await expect(requireAccessForEach(member([], { orgRole: "OWNER" }), "ITEM_CREATE", [])).resolves.toBeUndefined();
    await expect(requireAccessForEach(member([], { orgRole: "OWNER", isApiKey: true }), "ITEM_CREATE", [])).rejects.toThrow();
  });
});
