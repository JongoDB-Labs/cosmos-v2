// @vitest-environment node
//
// The agent must not read past a project's team scoping.
//
// `teamScopedAccess` restricts a project to its members (#513 routed 48 HTTP
// routes through `requireProjectRead`, which layers `isProjectVisible` on top of
// the action bit). The AI tools check only `projectInOrg` — that the project
// EXISTS in the org — which is not the same question and answers "yes" for a
// project the caller may not open.
//
// The gates the tools DO have are all weak here: ANALYTICS_READ, ITEM_READ,
// OKR_READ and PROJECT_READ are held by MEMBER and VIEWER. They authorise
// reading SOME project data and say nothing about WHICH project.
//
// Two of three production projects have teamScopedAccess enabled, so this is a
// live bypass rather than a latent one.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, loadEffectivePermissions, requireProjectRead } = vi.hoisted(
  () => ({
    prisma: {
      project: { findFirst: vi.fn() },
      risk: { findMany: vi.fn() },
      blocker: { findMany: vi.fn() },
      deliverable: { findMany: vi.fn() },
      changeRequest: { findMany: vi.fn() },
    },
    loadEffectivePermissions: vi.fn(),
    requireProjectRead: vi.fn(),
  }),
);

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead }));

import { listRisks, listBlockers, listDeliverables, listChanges } from "./pm-register";

const ORG = "org-1";
const ME = "11111111-1111-4111-a111-111111111111";
/** A project the actor may NOT see — team-scoped, and they are not a member. */
const HIDDEN = "22222222-2222-4222-a222-222222222222";

const ctx = { orgId: ORG, userId: ME };

beforeEach(() => {
  vi.clearAllMocks();
  // An ordinary member: holds the weak read bits, nothing else.
  loadEffectivePermissions.mockResolvedValue({
    orgRole: "MEMBER",
    permissions:
      Permission.ANALYTICS_READ | Permission.ITEM_READ | Permission.OKR_READ,
    basePermissions: Permission.ANALYTICS_READ,
    abacRules: [],
  });
  // The project EXISTS in the org — which is all `projectInOrg` ever asked.
  prisma.project.findFirst.mockResolvedValue({ id: HIDDEN });
  // …but the route-level gate refuses it.
  requireProjectRead.mockRejectedValue(new Error("Access denied by policy"));
  for (const m of ["risk", "blocker", "deliverable", "changeRequest"] as const) {
    prisma[m].findMany.mockResolvedValue([{ id: "x", code: "R-001" }]);
  }
});

/**
 * Each register, with the model it must not reach. One test per tool rather
 * than a loop over names, so a failure names the leaking tool directly.
 */
const REGISTERS = [
  { name: "listRisks", fn: listRisks, model: "risk" },
  { name: "listBlockers", fn: listBlockers, model: "blocker" },
  { name: "listDeliverables", fn: listDeliverables, model: "deliverable" },
  { name: "listChanges", fn: listChanges, model: "changeRequest" },
] as const;

describe("PM register tools respect project visibility", () => {
  for (const r of REGISTERS) {
    it(`${r.name} refuses a project the actor may not open`, async () => {
      const out = await r.fn({ projectId: HIDDEN }, ctx);

      // Denied, and denied BEFORE the query — not filtered afterwards.
      expect(out).toHaveProperty("error");
      expect(prisma[r.model].findMany).not.toHaveBeenCalled();
    });

    it(`${r.name} consults the route's gate, not just "is it in the org"`, async () => {
      // The specific defect: `projectInOrg` answers a different question, and
      // answering it is what let a non-member read a team-scoped project.
      await r.fn({ projectId: HIDDEN }, ctx);

      expect(requireProjectRead).toHaveBeenCalled();
    });
  }

  it("still returns data for a project the actor CAN see", async () => {
    // The control. Denying everything would be a different bug, and would make
    // the assistant useless on every unrestricted project — which is all of
    // them by default.
    requireProjectRead.mockResolvedValue(undefined);

    const out = (await listRisks({ projectId: HIDDEN }, ctx)) as {
      count: number;
    };

    expect(out.count).toBe(1);
  });
});
