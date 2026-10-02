import { expect, type Page } from "@playwright/test";
import { gotoStable } from "./navigation";

/**
 * Plan an interval (a sprint) from a project's /intervals page.
 *
 * Every selector here is an accessible NAME — "New interval", "Plan an
 * interval", "Name", "Start date", "End date", "Create interval". Those are
 * strings `tsc` cannot check, so a second copy of this sequence means a renamed
 * label fixes one spec and silently breaks the other. Hence one copy, shared.
 *
 * Navigates via `gotoStable`: a project created moments earlier hard-expires its
 * cache tag, which `next dev` can answer with a transient ERR_ABORTED.
 */
export async function planSprint(
  page: Page,
  {
    orgSlug,
    projectKey,
    name,
    start,
    end,
  }: {
    orgSlug: string;
    /** The project's key as it appears in the URL (lower-case). */
    projectKey: string;
    name: string;
    /** `YYYY-MM-DD`. */
    start: string;
    /** `YYYY-MM-DD`. */
    end: string;
  },
): Promise<void> {
  await gotoStable(page, `/${orgSlug}/projects/${projectKey}/intervals`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("main", { timeout: 20_000 });

  await page.getByRole("button", { name: /new interval/i }).first().click();
  await expect(
    page.getByRole("heading", { name: /plan an interval/i }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByLabel(/^Name$/).fill(name);
  await page.getByLabel(/start date/i).fill(start);
  await page.getByLabel(/end date/i).fill(end);
  await page.getByRole("button", { name: /create interval/i }).click();

  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
}
