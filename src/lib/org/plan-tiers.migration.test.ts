// @vitest-environment node
//
// Effect of the 20260713170000_simplify_plan_tiers migration against the real
// e2e DB (same real-DB style as the foreman route tests — no mocks, the real
// @/lib/db/client runs the queries). Proves the Plan enum is exactly
// BASIC/TEAM/ENTERPRISE (legacy FREE/BUSINESS/GOV removed) and every org was
// backfilled to ENTERPRISE.
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db/client";

describe("Plan-tier migration effect (e2e DB)", () => {
  it("the Plan enum has exactly BASIC, TEAM, ENTERPRISE (in order)", async () => {
    const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'Plan'
      ORDER BY e.enumsortorder
    `;
    expect(rows.map((r) => r.enumlabel)).toEqual(["BASIC", "TEAM", "ENTERPRISE"]);
  });

  it("no legacy tiers (FREE / BUSINESS / GOV) remain on the enum", async () => {
    const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'Plan'
    `;
    const labels = rows.map((r) => r.enumlabel);
    for (const legacy of ["FREE", "BUSINESS", "GOV"]) {
      expect(labels).not.toContain(legacy);
    }
  });

  it("every organization was backfilled to ENTERPRISE", async () => {
    const orgs = await prisma.organization.findMany({ select: { plan: true } });
    expect(orgs.length).toBeGreaterThan(0);
    expect(orgs.every((o) => o.plan === "ENTERPRISE")).toBe(true);
  });

  it("the plan column default is ENTERPRISE", async () => {
    const rows = await prisma.$queryRaw<{ column_default: string | null }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'organizations' AND column_name = 'plan'
    `;
    expect(rows[0]?.column_default ?? "").toContain("ENTERPRISE");
  });
});
