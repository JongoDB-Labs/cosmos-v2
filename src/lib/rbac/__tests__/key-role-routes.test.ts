// @vitest-environment node
//
// An API key carries the role of whoever minted it. Before key-role.ts, a
// `read` or `rules:run` key minted by an org OWNER, or by a project's MANAGER,
// passed requireProjectManage through that role and wrote the project:
// milestones, KPI data points, goals, intervals, objectives. Driven through the
// real handlers; the minter's role and project membership come from the mocks.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, ProjectRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => {
  // Every model method a handler reaches resolves to a bland row, so a request
  // that gets past authorization shows up as a write rather than a crash.
  const calls: string[] = [];
  const models = new Map<string, Record<string, unknown>>();
  const model = (name: string) => {
    if (!models.has(name)) {
      models.set(name, new Proxy({}, {
        get: (_t, method: string) => async () => {
          calls.push(`${name}.${method}`);
          // The project exists (handlers look it up before writing to it).
          if (name === "project" && method.startsWith("find")) {
            return { id: "22222222-2222-4222-8222-222222222222", orgId: "11111111-1111-4111-8111-111111111111", name: "P", key: "P" };
          }
          return null;
        },
      }));
    }
    return models.get(name)!;
  };
  return { calls, model, getAuthContext: vi.fn(), isManager: { value: false } };
});

vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/db/client", () => ({
  prisma: new Proxy({}, {
    get: (_t, name: string) => {
      if (name === "organization") return { findUnique: async () => ({ id: ORG, slug: "acme" }) };
      if (name === "orgMember") return { findUnique: async () => ({ id: "om1" }) };
      if (name === "projectMember") {
        return { findFirst: async () => (h.isManager.value ? { id: "pm1", role: ProjectRole.MANAGER } : null) };
      }
      return h.model(name);
    },
  }),
}));

import { POST as createMilestone } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/route";
import { POST as createDataPoint } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/kpis/[kpiId]/data-points/route";
import { POST as createGoal } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/goals/route";
import { POST as createInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/route";
import { POST as createObjective } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const KPI = "33333333-3333-4333-8333-333333333333";

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: [string, Handler, Record<string, string>, unknown][] = [
  ["milestones", createMilestone as unknown as Handler, {}, { title: "M", dueDate: "2026-12-01T00:00:00.000Z" }],
  ["KPI data points", createDataPoint as unknown as Handler, { kpiId: KPI }, { value: 1, recordedAt: "2026-11-01T00:00:00.000Z" }],
  ["goals", createGoal as unknown as Handler, {}, { title: "G" }],
  ["intervals", createInterval as unknown as Handler, {}, { name: "S", startDate: "2026-11-01T00:00:00.000Z", endDate: "2026-11-14T00:00:00.000Z" }],
  ["objectives", createObjective as unknown as Handler, {}, { title: "O" }],
];

/**
 * A key's context as apiKeyAuthContext builds it: the minter's role, their
 * permissions cut down to the scope mask, and the scopes. A MEMBER holds none
 * of the org-wide manage bits; an OWNER's are all cut away by `read`.
 */
const key = (scopes: string[], orgRole: OrgRole, permissions: bigint): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole, permissions, basePermissions: permissions,
  abacRules: [], isApiKey: true, scopes,
});
const READ_MASK = Permission.PROJECT_READ | Permission.ITEM_READ | Permission.OKR_READ | Permission.SPRINT_READ;

const call = (handler: Handler, extra: Record<string, string>, body: unknown) =>
  handler(
    new NextRequest(`http://localhost/api/v1/orgs/${ORG}/projects/${PROJECT}/x`, {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ orgId: ORG, projectId: PROJECT, ...extra }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.isManager.value = false;
});

describe("a key minted by an OWNER or a project MANAGER writes the project only as far as its scopes allow", () => {
  const MINTERS: [string, OrgRole, boolean][] = [
    ["an org OWNER", OrgRole.OWNER, false],
    ["the project's MANAGER", OrgRole.MEMBER, true],
  ];
  const writes = () => h.calls.filter((c) => /\.(create|createMany|update|upsert|delete)/.test(c));

  for (const [who, orgRole, manager] of MINTERS) {
    for (const scope of ["read", "rules:run"]) {
      it.each(ROUTES)(`${who}'s ${scope} key gets a 403 creating %s, and nothing is written`, async (_n, handler, extra, body) => {
        h.isManager.value = manager;
        h.getAuthContext.mockResolvedValue(key([scope], orgRole, scope === "read" ? READ_MASK : Permission.RULES_RUN));
        const res = await call(handler, extra, body);
        expect(res.status).toBe(403);
        expect(writes()).toEqual([]);
      });
    }
  }

  it("the project MANAGER's items:write key still gets past authorization to a milestone write", async () => {
    h.isManager.value = true;
    h.getAuthContext.mockResolvedValue(key(["items:write"], OrgRole.MEMBER, READ_MASK | Permission.ITEM_CREATE | Permission.ITEM_UPDATE));
    const res = await call(ROUTES[0][1], {}, ROUTES[0][3]);
    // Past authorization: the handler goes on to the milestone table (where the
    // bland mock rows end it; what it writes is the milestone tests' business).
    expect(res.status).not.toBe(403);
    expect(h.calls.some((c) => c.startsWith("milestone."))).toBe(true);
  });

  it("a browser session of the project's MANAGER is unchanged", async () => {
    h.isManager.value = true;
    h.getAuthContext.mockResolvedValue({ ...key([], OrgRole.MEMBER, READ_MASK), isApiKey: undefined, scopes: undefined });
    const res = await call(ROUTES[0][1], {}, ROUTES[0][3]);
    // Past authorization: the handler goes on to the milestone table (where the
    // bland mock rows end it; what it writes is the milestone tests' business).
    expect(res.status).not.toBe(403);
    expect(h.calls.some((c) => c.startsWith("milestone."))).toBe(true);
  });
});
