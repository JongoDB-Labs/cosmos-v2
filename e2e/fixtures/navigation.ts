import type { Page } from "@playwright/test";

/**
 * `page.goto` that tolerates the transient `net::ERR_ABORTED` that `next dev`
 * throws when a streaming navigation races a cacheComponents tag revalidation —
 * e.g. loading the /projects list right after a create hard-expires its cache
 * tag. Harmless under a production build; it only bites the dev server the CI
 * e2e job runs. Retries the navigation a few times before giving up.
 */
export async function gotoStable(
  page: Page,
  url: string,
  opts?: Parameters<Page["goto"]>[1],
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, opts);
      return;
    } catch (e) {
      if (attempt >= 4 || !String(e).includes("ERR_ABORTED")) throw e;
      await page.waitForTimeout(500);
    }
  }
}
