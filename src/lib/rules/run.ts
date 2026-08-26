import { prisma } from "@/lib/db/client";
import { isPluginEnabled } from "@/lib/plugins/enablement";
import { PluginServerRegistry, type RuleRunSummary } from "@/lib/plugins/registry";

/**
 * Run every enabled plugin's rules for one org.
 *
 * WHY THIS EXISTS: a rule that only runs when somebody happens to load a page
 * produces a flag list that is accurate as of the last time anyone looked,
 * which is not the same as accurate. Both halves are affected -- a condition
 * that became true on Tuesday raises nothing until someone visits, and a
 * condition that cleared keeps its flag up just as long.
 *
 * A plugin's failure must not starve the ones after it. With a periodic runner
 * that is not a one-off: the same plugin fails first every time, so every later
 * plugin's rules would never run again, and nothing would say so. Each plugin is
 * therefore isolated, and its failure is REPORTED rather than swallowed -- `ok`
 * goes false so the caller (a scheduler) can tell a bad run from a quiet one.
 * A cron that always returns success is a cron nobody reads.
 */

export type PluginRuleRun =
  | { slug: string; ok: true; rules: RuleRunSummary[] }
  | { slug: string; ok: false; error: string };

export interface OrgRuleRun {
  ok: boolean;
  plugins: PluginRuleRun[];
}

export async function runOrgRules(orgId: string): Promise<OrgRuleRun> {
  const candidates = PluginServerRegistry.getAll().filter((h) => typeof h.runRules === "function");

  const plugins: PluginRuleRun[] = [];
  for (const hooks of candidates) {
    // Licence + enablement, same gate the rest of the plugin surface uses. A
    // disabled plugin must not keep raising flags in the background.
    if (!(await isPluginEnabled(orgId, hooks.slug))) continue;
    try {
      const rules = (await hooks.runRules!(prisma, orgId)) ?? [];
      plugins.push({ slug: hooks.slug, ok: true, rules });
    } catch (err) {
      console.error(`[rules] ${hooks.slug} failed for org ${orgId}`, err);
      plugins.push({
        slug: hooks.slug,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: plugins.every((p) => p.ok), plugins };
}
