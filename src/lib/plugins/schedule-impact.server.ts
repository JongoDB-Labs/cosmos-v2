/**
 * Ask enabled plugins what a proposed reschedule would do to the things core
 * can't see (fees, rates, hours). See `PluginServerHooks.scheduleImpact`.
 *
 * The confirm step must stay quick and must never depend on a plugin behaving,
 * so each hook gets a time budget, runs alongside the others, and loses its
 * section if it is slow, throws or answers in the wrong shape. What it returns
 * is validated, and every section key is prefixed with the plugin's slug so two
 * plugins can't collide (or pose as core's own "schedule" section).
 */
import { prisma } from "@/lib/db/client";
import "@/lib/plugins/registry/server";
import { PluginServerRegistry, type ScheduleImpactContext } from "@/lib/plugins/registry";
import { isPluginEnabled } from "@/lib/plugins/enablement";
import { ImpactSectionSchema, type ImpactSection } from "@/lib/work-items/schedule-impact";

export const SCHEDULE_IMPACT_BUDGET_MS = 1500;

class Timeout extends Error {}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function collectPluginImpact(
  ctx: ScheduleImpactContext,
  budgetMs = SCHEDULE_IMPACT_BUDGET_MS,
): Promise<ImpactSection[]> {
  const hooks = PluginServerRegistry.getAll().filter((h) => typeof h.scheduleImpact === "function");
  if (hooks.length === 0) return [];

  const results = await Promise.all(
    hooks.map(async (h) => {
      try {
        // Licence + enablement, the gate every plugin surface uses.
        if (!(await isPluginEnabled(ctx.orgId, h.slug))) return [];
        const out = await within(h.scheduleImpact!(prisma, ctx), budgetMs);
        const parsed = ImpactSectionSchema.array().max(10).safeParse(out ?? []);
        if (!parsed.success) {
          console.warn(`[schedule-impact] ${h.slug}: dropped an answer in the wrong shape`);
          return [];
        }
        return parsed.data.map((s) => ({ ...s, key: `${h.slug}:${s.key}` }));
      } catch (err) {
        // Logged by name only: a plugin's error text may carry its own data.
        console.warn(`[schedule-impact] ${h.slug}: ${err instanceof Timeout ? "timed out" : "failed"}`);
        return [];
      }
    }),
  );
  return results.flat();
}
