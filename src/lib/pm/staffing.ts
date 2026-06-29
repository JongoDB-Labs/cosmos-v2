import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Staffing lens — join the existing project membership (`ProjectMember` →
 * `OrgMember` → `User`) with HR data (`Employee`: labor category, clearance,
 * cost rate) into one view. Cost rate is only included when the caller may see
 * financials. PM-owned fields on the membership: `allocationPercent` and the
 * per-contract compliance status (CAC / training / system access / NDA / on
 * contract), from which "fully compliant" is derived.
 */
export interface StaffRow {
  id: string; // projectMember id
  userId: string;
  name: string;
  role: ProjectRole;
  allocationPercent: number | null;
  laborCategory: string | null;
  clearance: string | null; // Employee.classification, "None"/empty normalized to null
  employmentType: string | null;
  costRate: number | null; // only when includeCost
  // Compliance (per-contract onboarding posture)
  onContract: boolean;
  cacStatus: string | null;
  cacExpiry: string | null;
  trainingStatus: string | null;
  accessStatus: string | null;
  ndaStatus: string | null;
  complianceNotes: string | null;
  compliant: boolean; // derived: every dimension green
}

// A dimension is "green" only when explicitly at its compliant value — missing
// data reads as not-yet-compliant (matches govcon onboarding tracking).
export const cacOk = (s: string | null) => s === "active";
export const trainingOk = (s: string | null) => s === "complete";
export const accessOk = (s: string | null) => s === "granted";
export const ndaOk = (s: string | null) => s === "executed";

export interface ComplianceSummary {
  total: number;
  compliant: number;
  percent: number | null;
  cacPending: number;
  trainingIncomplete: number;
  accessPending: number;
  ndaNotExecuted: number;
  offContract: number;
}

export function summarizeCompliance(rows: StaffRow[]): ComplianceSummary {
  const total = rows.length;
  const compliant = rows.filter((r) => r.compliant).length;
  return {
    total,
    compliant,
    percent: total > 0 ? Math.round((compliant / total) * 100) : null,
    cacPending: rows.filter((r) => !cacOk(r.cacStatus)).length,
    trainingIncomplete: rows.filter((r) => !trainingOk(r.trainingStatus)).length,
    accessPending: rows.filter((r) => !accessOk(r.accessStatus)).length,
    ndaNotExecuted: rows.filter((r) => !ndaOk(r.ndaStatus)).length,
    offContract: rows.filter((r) => !r.onContract).length,
  };
}

export async function loadStaffing(
  orgId: string,
  projectId: string,
  opts: { includeCost: boolean },
): Promise<StaffRow[]> {
  const members = await prisma.projectMember.findMany({
    where: { projectId, orgMember: { orgId } },
    include: {
      orgMember: { include: { user: { select: { id: true, displayName: true } } } },
    },
  });

  const userIds = members.map((m) => m.orgMember.userId);
  // Employee has no FK to User (scalar userId), so resolve by userId set.
  const employees = userIds.length
    ? await prisma.employee.findMany({
        where: { orgId, userId: { in: userIds } },
        select: {
          userId: true,
          laborCategory: true,
          classification: true,
          employmentType: true,
          costRate: true,
        },
      })
    : [];
  const empByUser = new Map(employees.map((e) => [e.userId, e]));

  const rows = members.map((m): StaffRow => {
    const e = empByUser.get(m.orgMember.userId);
    const clearance =
      e?.classification && e.classification.toLowerCase() !== "none" ? e.classification : null;
    const compliant =
      m.onContract &&
      cacOk(m.cacStatus) &&
      trainingOk(m.trainingStatus) &&
      accessOk(m.accessStatus) &&
      ndaOk(m.ndaStatus);
    return {
      id: m.id,
      userId: m.orgMember.userId,
      name: m.orgMember.user.displayName,
      role: m.role,
      allocationPercent: m.allocationPercent,
      laborCategory: e?.laborCategory ?? null,
      clearance,
      employmentType: e?.employmentType ?? null,
      costRate: opts.includeCost && e?.costRate != null ? Number(e.costRate) : null,
      onContract: m.onContract,
      cacStatus: m.cacStatus,
      cacExpiry: m.cacExpiry ? m.cacExpiry.toISOString() : null,
      trainingStatus: m.trainingStatus,
      accessStatus: m.accessStatus,
      ndaStatus: m.ndaStatus,
      complianceNotes: m.complianceNotes,
      compliant,
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}
