// @vitest-environment node
//
// The assistant's semantic search over work items used to scope by the DB role
// alone (OWNER/ADMIN = every project, else memberships): an ADMIN session
// searched projects an ABAC deny on ITEM_READ had taken away, and a
// project-scoped API key searched every project its minter could (defence in
// depth: no real key holds ORG_READ, and the assistant needs CHAT_USE). It now intersects with getReadableProjectIds on the
// CALLER's context, the rule GET /work-items uses. Narrowing only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "88888888-8888-4888-8888-888888888888";
const P1 = "a1111111-1111-4111-8111-111111111111";
const P2 = "a2222222-2222-4222-8222-222222222222";
const P3 = "a3333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  role: { value: "MEMBER" as string },
  memberOf: { value: [] as string[] },
  projects: { value: [] as { id: string; teamScopedAccess: boolean }[] },
  queries: [] as unknown[][],
}));
vi.mock("@/lib/rag/embed", () => ({ embedText: async () => [0.1, 0.2], toVectorLiteral: () => "[0.1,0.2]" }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ slug: "acme" }) },
    orgMember: { findUnique: async () => ({ id: "om1", role: h.role.value }) },
    projectMember: { findMany: async () => h.memberOf.value.map((projectId) => ({ projectId })) },
    project: { findMany: async () => h.projects.value },
    $queryRawUnsafe: async (...args: unknown[]) => { h.queries.push(args); return []; },
  },
}));

import { semanticSearch } from "./rag";
import { Permission } from "@/lib/rbac/permissions";

const auth = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER,
  permissions: Permission.ORG_READ | Permission.ITEM_READ | Permission.PROJECT_READ,
  basePermissions: Permission.ORG_READ | Permission.ITEM_READ | Permission.PROJECT_READ,
  abacRules: [], ...over,
});
const search = (a: AuthContext | undefined) =>
  semanticSearch({ query: "deploy", types: ["work_item"] }, { orgId: ORG, userId: ME, auth: a as AuthContext });
/** The project ids the work-item query was bound to, or null when it never ran. */
const searched = () => (h.queries.length ? (h.queries[0][3] as string[]) : null);

beforeEach(() => {
  h.queries.length = 0;
  h.role.value = "MEMBER";
  h.memberOf.value = [];
  h.projects.value = [P1, P2, P3].map((id) => ({ id, teamScopedAccess: false }));
});

describe("assistant work-item search follows the caller's readable projects", () => {
  it("an OWNER's key scoped to one project searches that project only", async () => {
    h.role.value = "OWNER";
    await search(auth({ orgRole: OrgRole.OWNER, isApiKey: true, scopes: ["read"], projectScope: [P1] }));
    expect(searched()).toEqual([P1]);
  });

  it("a member's key scoped to one of their projects searches only that one", async () => {
    h.memberOf.value = [P1, P2];
    await search(auth({ isApiKey: true, scopes: ["read"], projectScope: [P2] }));
    expect(searched()).toEqual([P2]);
  });

  it("an ADMIN session loses a project an ABAC deny on ITEM_READ takes away", async () => {
    // The role path alone (OWNER/ADMIN = every project) never consulted policy;
    // getReadableProjectIds does, as GET /work-items always has.
    h.role.value = "ADMIN";
    await search(auth({
      orgRole: OrgRole.ADMIN,
      abacRules: [{ effect: "deny", actions: ["ITEM_READ"], conditions: [{ attr: "projectId", op: "eq", value: P2 }] }],
    } as Partial<AuthContext>));
    expect(searched()).toEqual([P1, P3]);
  });

  it("an OWNER's browser session still searches every project", async () => {
    h.role.value = "OWNER";
    await search(auth({ orgRole: OrgRole.OWNER }));
    expect(searched()).toEqual([P1, P2, P3]);
  });

  it("nobody gains a project: a member still searches only their memberships", async () => {
    h.memberOf.value = [P1];
    await search(auth());
    expect(searched()).toEqual([P1]);
  });

  it("without a caller context it refuses", async () => {
    expect(await search(undefined)).toHaveProperty("error");
    expect(searched()).toBeNull();
  });
});
