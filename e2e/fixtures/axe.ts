import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

const AXE_SOURCE = fs.readFileSync(
  path.join(process.cwd(), "node_modules/axe-core/axe.min.js"),
  "utf8",
);

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  targets: string[];
  detail?: string; // TEMP: axe color-contrast fg/bg/ratio for diagnosis
}

/**
 * Inject axe-core into the page and run a WCAG 2 A/AA scan. Returns the list of
 * violations (id, impact, where). Codifies the manual axe audits from rounds
 * 16/17 as a repeatable check.
 */
export async function runAxe(
  page: Page,
  opts?: { tags?: string[] },
): Promise<AxeViolation[]> {
  await page.evaluate((src) => {
    // eslint-disable-next-line no-eval
    if (!(window as unknown as { axe?: unknown }).axe) eval(src);
  }, AXE_SOURCE);
  const tags = opts?.tags ?? ["wcag2a", "wcag2aa"];
  return page.evaluate(async (runTags) => {
    // Exclude `[data-a11y-preview]` regions — these intentionally render an
    // arbitrary user-CHOSEN color (e.g. the theme picker's live swatch), so
    // their contrast reflects that choice, not a code regression we should gate
    // on. Also exclude `[data-sonner-toaster]`: transient toast notifications
    // (e.g. a `notifyError` fired by a timing-dependent failed fetch) render in
    // a body-level portal and would otherwise be caught mid-flight on whatever
    // surface is loading, flaking the scan — their contrast is Sonner's own
    // theming, not page content. Everything else on the page is still scanned.
    const res = await (
      window as unknown as {
        axe: {
          run: (
            ctx: unknown,
            o: unknown,
          ) => Promise<{ violations: unknown[] }>;
        };
      }
    ).axe.run(
      { exclude: [["[data-a11y-preview]"], ["[data-sonner-toaster]"]] },
      { runOnly: runTags },
    );
    return (res.violations as Array<{
      id: string;
      impact: string | null;
      help: string;
      nodes: Array<{ target: string[]; any?: Array<{ data?: unknown }> }>;
    }>).map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
      detail: JSON.stringify(v.nodes.slice(0, 3).map((n) => n.any?.[0]?.data ?? null)),
    }));
  }, tags);
}

/** Serious/critical violations are the ones we gate on. */
export function blocking(violations: AxeViolation[]): AxeViolation[] {
  return violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}
