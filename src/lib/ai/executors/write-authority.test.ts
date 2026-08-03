// @vitest-environment node
//
// Agent WRITES must require what the matching HTTP route requires.
//
// `assertProjectRead` is the wrong question for a mutation, and asking it made
// the agent wrong in BOTH directions:
//
//   - STRICTER for a project manager without the org-wide bit. The app let them
//     edit their own project's risks; the agent refused.
//   - LOOSER wherever the agent picked a weaker bit than the route. `create_kpi`
//     gated on OKR_CREATE — which MEMBER holds — while the KPI routes require
//     PROJECT_UPDATE, which MEMBER does not. A member could create KPIs through
//     the assistant that the app would have refused. That is the one that
//     mattered.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";

const {
  prisma,
  loadEffectivePermissions,
  requireProjectRead,
  requireProjectManage,
} = vi.hoisted(() => ({
  prisma: {
    kpi: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    goal: { findFirst: vi.fn(), create: vi.fn() },
    risk: { findFirst: vi.fn(), create: vi.fn() },
    project: { findFirst: vi.fn() },
  },
  loadEffectivePermissions: vi.fn(),
  requireProjectRead: vi.fn(),
  requireProjectManage: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead }));
vi.mock("@/lib/rbac/require-project-manage", () => ({ requireProjectManage }));

import { createKpi } from "./goals-kpis";

const ORG = "org-1";
const ME = "11111111-1111-4111-a111-111111111111";
const PROJECT = "22222222-2222-4222-a222-222222222222";
const ctx = { orgId: ORG, userId: ME };

/** An ordinary member: holds the OKR bits, NOT PROJECT_UPDATE. */
function asMember() {
  loadEffectivePermissions.mockResolvedValue({
    orgRole: "MEMBER",
    permissions: Permission.OKR_CREATE | Permission.OKR_UPDATE,
    basePermissions: Permission.OKR_CREATE,
    abacRules: [],
  });
}

const input = { projectId: PROJECT, name: "Velocity", target: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  asMember();
  requireProjectRead.mockResolvedValue(undefined);
  // The route helper is the authority; by default it refuses a plain member.
  requireProjectManage.mockRejectedValue(new Error("not a project manager"));
  prisma.kpi.create.mockResolvedValue({ id: "k1" });
  prisma.kpi.aggregate.mockResolvedValue({ _max: { sortOrder: 0 } });
});

describe("create_kpi — write authority matches the KPI routes", () => {
  it("REFUSES a member who only holds OKR_CREATE", async () => {
    // The escalation in one assertion: OKR_CREATE is MEMBER-held, PROJECT_UPDATE
    // is not, and the KPI routes require the latter.
    const out = await createKpi(input, ctx);

    expect(out).toHaveProperty("error");
    expect(prisma.kpi.create).not.toHaveBeenCalled();
  });

  it("asks for PROJECT_UPDATE — the bit the route passes", async () => {
    // Pairing the tool with the route's own org-wide bit IS the contract; a
    // weaker bit here is exactly how the gap appeared.
    await createKpi(input, ctx);

    expect(requireProjectManage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ME, orgId: ORG }),
      PROJECT,
      Permission.PROJECT_UPDATE,
    );
  });

  it("ALLOWS a project manager, matching the app", async () => {
    // The other direction. `requireProjectManage` passes for a manager of this
    // project even without the org-wide bit — the agent used to refuse them
    // while the UI allowed it.
    requireProjectManage.mockResolvedValue(undefined);

    await createKpi(input, ctx);

    expect(prisma.kpi.create).toHaveBeenCalled();
  });

  it("checks VISIBILITY before authority", async () => {
    // A project you cannot open must read as absent, not as forbidden —
    // otherwise the refusal tells you it exists.
    requireProjectRead.mockRejectedValue(new Error("denied"));

    const out = (await createKpi(input, ctx)) as { error: string };

    expect(out.error).toBe("Project not found");
    expect(requireProjectManage).not.toHaveBeenCalled();
  });
});
