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

const PAGES: Array<{ name: string; path: string }> = [
  { name: "overview", path: "" },
  { name: "projects", path: "/projects" },
  { name: "analytics", path: "/analytics" },
  { name: "finance", path: "/finance" },
];

// Catastrophic-only — a healthy prod LCP is well under 1s (see perf memory).
const MAX_LCP_MS = 8000;

test.describe("perf — Web Vitals snapshot", () => {
  for (const { name, path } of PAGES) {
    test(`${name}: captures vitals and isn't catastrophically slow`, async ({
      page,
      signInAs,
    }) => {
      await signInAs(EMAIL);
      await page.goto(`/${ORG}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("main", { timeout: 20_000 });
      await page
        .locator('[data-slot="skeleton"]')
        .first()
        .waitFor({ state: "detached", timeout: 10_000 })
        .catch(() => {});
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

      console.log(
        `[perf] ${name}: LCP=${vitals.lcp}ms CLS=${vitals.cls} load=${vitals.load}ms`,
      );
      expect(vitals.lcp, `${name}: LCP should be captured`).toBeGreaterThan(0);
      expect(
        vitals.lcp,
        `${name}: LCP ${vitals.lcp}ms exceeds catastrophic ${MAX_LCP_MS}ms`,
      ).toBeLessThan(MAX_LCP_MS);
    });
  }
});
