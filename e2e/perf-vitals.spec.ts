import { test, expect } from "./fixtures/auth";

/**
 * Web Vitals snapshot — captures LCP / CLS / load on key surfaces and logs them
 * for visibility (grep "[perf]" in CI output). Perf GATES flake on shared CI
 * runners, so this deliberately only fails on a CATASTROPHIC LCP regression,
 * not a tight budget. Most meaningful against the CI prod build (`npm start`);
 * the parked CLS residual still needs a real-browser/Lighthouse run with classic
 * scrollbars + seeded data (headless Chromium's overlay scrollbars confound it).
 */

const ORG = process.env.E2E_ORG_SLUG ?? "test-org";
const EMAIL = process.env.E2E_EMAIL ?? "alice@test.local";

const GALLERY = process.env.E2E_GALLERY_PROJECT_KEY ?? "GALLERY";

/**
 * The surfaces this samples.
 *
 * The four non-board pages are the originals. The boards were MISSING, which
 * is the same blindness the a11y gate had: every board view is a client
 * component that fetches its project's whole item list AFTER hydration and
 * renders every row (nothing in `components/boards` or `components/work-items`
 * is virtualized), so boards are the surfaces most likely to be slow and the
 * only ones nothing measured. They use the board-gallery project seeded for
 * the a11y scans, so they need no fixture of their own.
 *
 * `content` is a selector that only matches once REAL content is on screen, so
 * a measurement cannot be taken against a loading skeleton.
 */
const PAGES: Array<{ name: string; path: string; content?: string }> = [
  { name: "overview", path: "" },
  { name: "projects", path: "/projects" },
  { name: "analytics", path: "/analytics" },
  { name: "finance", path: "/accounting/finance" },
  { name: "board:kanban", path: `/projects/${GALLERY}/boards/kanban`, content: "text=Gallery item in review" },
  { name: "board:table", path: `/projects/${GALLERY}/boards/table`, content: "text=Gallery item in review" },
  { name: "board:backlog", path: `/projects/${GALLERY}/boards/backlog`, content: "text=Gallery item in review" },
  { name: "board:timeline", path: `/projects/${GALLERY}/boards/timeline`, content: "text=Gallery item in review" },
];

// Catastrophic-only — a healthy prod LCP is well under 1s (see perf memory).
const MAX_LCP_MS = 8000;

test.describe("perf — Web Vitals snapshot", () => {
  for (const { name, path, content } of PAGES) {
    test(`${name}: captures vitals and isn't catastrophically slow`, async ({
      page,
      signInAs,
    }) => {
      await signInAs(EMAIL);
      await page.goto(`/${ORG}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("main", { timeout: 20_000 });

      // ALL skeletons, and a real failure if they never clear. This was
      // `.first().waitFor({ state: "detached" }).catch(() => {})`: it waited
      // for ONE skeleton and swallowed the timeout, so a page still loading
      // was MEASURED AS A SKELETON — and a skeleton paints fast, which makes a
      // slow surface look healthy. The same hole was in the a11y gate, where
      // it was letting axe report clean on pages it had never seen.
      await expect(
        page.locator('[data-slot="skeleton"]'),
        `${name}: still showing loading skeletons — the vitals below would describe the loading state, not the page`,
      ).toHaveCount(0, { timeout: 20_000 });

      // For a board, also wait for a real row: the chrome renders long before
      // the items arrive, so "no skeletons" alone can still be an empty board.
      if (content) {
        await expect(
          page.locator(content).first(),
          `${name}: no board content rendered — vitals would describe empty chrome`,
        ).toBeVisible({ timeout: 20_000 });
      }
      await page.waitForTimeout(800);

      const vitals = await page.evaluate(
        () =>
          new Promise<{ lcp: number; cls: number; load: number }>((resolve) => {
            let lcp = 0;
            let cls = 0;
            try {
              new PerformanceObserver((list) => {
                for (const e of list.getEntries())
                  lcp = (e as PerformanceEntry).startTime;
              }).observe({ type: "largest-contentful-paint", buffered: true });
              new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                  const ls = e as PerformanceEntry & {
                    value: number;
                    hadRecentInput: boolean;
                  };
                  if (!ls.hadRecentInput) cls += ls.value;
                }
              }).observe({ type: "layout-shift", buffered: true });
            } catch {
              /* metric unsupported in this browser */
            }
            setTimeout(() => {
              const nav = performance.getEntriesByType(
                "navigation",
              )[0] as PerformanceNavigationTiming | undefined;
              resolve({
                lcp: Math.round(lcp),
                cls: Number(cls.toFixed(3)),
                load: nav ? Math.round(nav.loadEventEnd) : 0,
              });
            }, 600);
          }),
      );

      // DOM size, logged because it is the cost nothing was watching: with no
      // virtualization a board renders one node-tree per row, so this grows
      // linearly with the project's item count. On a seeded gallery it is
      // small; on a real project of ~1000 items it is the number to watch.
      const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
      console.log(
        `[perf] ${name}: LCP=${vitals.lcp}ms CLS=${vitals.cls} load=${vitals.load}ms domNodes=${nodes}`,
      );
      expect(vitals.lcp, `${name}: LCP should be captured`).toBeGreaterThan(0);
      expect(
        vitals.lcp,
        `${name}: LCP ${vitals.lcp}ms exceeds catastrophic ${MAX_LCP_MS}ms`,
      ).toBeLessThan(MAX_LCP_MS);
    });
  }
});
