import { prisma } from "@/lib/db/client";
import { coerceLoopMode, defaultLoopSettings, type LoopSettings } from "@/lib/foreman/loop/mode";

/** Read the effective loop settings for an org: an org-specific row wins; else the
 *  project-wide default row (orgId null); else the hard-coded safe default (off). */
export async function getForemanLoopSettings(orgId: string): Promise<LoopSettings> {
  const rows = await prisma.foremanLoopSettings.findMany({ where: { OR: [{ orgId: null }, { orgId }] } });
  const row = rows.find((r) => r.orgId === orgId) ?? rows.find((r) => r.orgId === null);
  const base = defaultLoopSettings();
  if (!row) return base;
  return {
    mode: coerceLoopMode(row.mode),
    budgets: {
      ...base.budgets,
      wallClockMs: row.wallClockMin * 60_000,
      costUsdCeiling: row.costUsdCeiling ?? null,
      stallRounds: row.stallRounds,
    },
  };
}
