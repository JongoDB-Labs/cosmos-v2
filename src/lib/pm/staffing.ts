import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Staffing lens — join the existing project membership (`ProjectMember` →
 * `OrgMember` → `User`) with HR data (`Employee`: labor category, clearance,
 * cost rate) into one view. Cost rate is only included when the caller may see
 * financials. Surfaces existing data; the only PM-owned field is
 * `allocationPercent` on the membership.
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
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}
