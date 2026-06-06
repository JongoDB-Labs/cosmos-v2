import type { PrismaClient } from "@prisma/client";

interface CrossCuttingType {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  color: string;
  celebrateOnComplete: boolean;
  defaultParentTypeKey?: string;
}

const CROSS_CUTTING_TYPES: CrossCuttingType[] = [
  { key: "cross.goal", name: "Goal", pluralName: "Goals", icon: "Target", color: "#2563eb", celebrateOnComplete: true },
  { key: "cross.milestone", name: "Milestone", pluralName: "Milestones", icon: "Flag", color: "#8b5cf6", celebrateOnComplete: false },
  { key: "cross.kpi", name: "KPI", pluralName: "KPIs", icon: "Gauge", color: "#0891b2", celebrateOnComplete: true },
  { key: "cross.objective", name: "Objective", pluralName: "Objectives", icon: "Compass", color: "#6366f1", celebrateOnComplete: false },
  { key: "cross.key_result", name: "Key Result", pluralName: "Key Results", icon: "TrendingUp", color: "#10b981", defaultParentTypeKey: "cross.objective", celebrateOnComplete: true },
  { key: "cross.risk", name: "Risk", pluralName: "Risks", icon: "ShieldAlert", color: "#ef4444", celebrateOnComplete: false },
  { key: "cross.decision", name: "Decision", pluralName: "Decisions", icon: "Gavel", color: "#f59e0b", celebrateOnComplete: false },
  { key: "cross.meeting_note", name: "Meeting Note", pluralName: "Meeting Notes", icon: "FileText", color: "#64748b", celebrateOnComplete: false },
];

export async function seedCrossCuttingTypes(prisma: PrismaClient) {
  for (let i = 0; i < CROSS_CUTTING_TYPES.length; i++) {
    const t = CROSS_CUTTING_TYPES[i];
    const existing = await prisma.workItemType.findFirst({
      where: { orgId: null, key: t.key },
    });
    if (existing) {
      await prisma.workItemType.update({
        where: { id: existing.id },
        data: { name: t.name, pluralName: t.pluralName, icon: t.icon, color: t.color },
      });
    } else {
      await prisma.workItemType.create({
        data: {
          key: t.key,
          name: t.name,
          pluralName: t.pluralName ?? null,
          icon: t.icon,
          color: t.color,
          isBuiltIn: true,
          sortOrder: i,
          defaultParentTypeKey: t.defaultParentTypeKey ?? null,
          celebrateOnComplete: t.celebrateOnComplete,
        },
      });
    }
  }
  console.log(`  cross-cutting: upserted ${CROSS_CUTTING_TYPES.length} types`);
}
