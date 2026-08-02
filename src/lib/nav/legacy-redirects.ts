/**
 * Legacy page-route redirects for the Accounting information-architecture move.
 *
 * The Accounting section used to live under `/finance/*`, so the sidebar label
 * ("Accounting") and the URL ("/finance/…") disagreed, and the trail carried
 * "Accounting" twice — once as the group, once as the `/finance/accounting`
 * ledger page. The section now lives at `/{orgSlug}/accounting/{page}`, so every
 * breadcrumb segment matches the nav label that produced it.
 *
 * These rules keep bookmarks, pasted links and anything already in the wild
 * working. They are declared as DATA (rather than hand-written entries in
 * `next.config.ts`) for two reasons:
 *   1. `next.config.ts` is untestable in isolation; this module is not — see
 *      `legacy-redirects.test.ts`, which pins the whole map so a future rename
 *      cannot silently drop a path.
 *   2. `ACCOUNTING_SECTION_DEFAULT` is shared with the `/accounting` index page,
 *      so the section's landing page is defined in exactly one place.
 */

/** Org-relative path the Accounting section lands on (its first child). */
export const ACCOUNTING_SECTION_DEFAULT = "/accounting/finance";

/**
 * Old org-relative path -> new org-relative path.
 *
 * Note `/finance/accounting` (the old ledger page) has no 1:1 successor: its
 * Reports / Journal / Chart-of-Accounts panels are now TABS on the Finance
 * page, so it lands there rather than on a page of its own. That collapse is
 * the point of the move — there is only one "Accounting" breadcrumb now.
 */
export const LEGACY_ORG_PATH_REDIRECTS: Readonly<Record<string, string>> = {
  "/finance": ACCOUNTING_SECTION_DEFAULT,
  "/finance/accounting": ACCOUNTING_SECTION_DEFAULT,
  "/finance/banking": "/accounting/banking",
  "/finance/payroll": "/accounting/payroll",
  "/finance/tax": "/accounting/tax",
  "/finance/invoices": "/accounting/invoices",
};

export interface RedirectRule {
  source: string;
  destination: string;
  permanent: boolean;
}

/**
 * The map rendered as `next.config.ts` `redirects()` rules, org slug templated
 * back in. Redirects are matched before the filesystem, so no placeholder route
 * files have to be left behind under the old paths.
 *
 * `permanent: false` (307) is deliberate. A 308 is cached by the browser
 * indefinitely, and this app auto-deploys to a production instance — a wrong or
 * reverted 308 would be unfixable for everyone who had already hit it. A 307
 * costs one extra request and stays reversible.
 */
export function legacyRedirectRules(): RedirectRule[] {
  return Object.entries(LEGACY_ORG_PATH_REDIRECTS).map(
    ([source, destination]) => ({
      source: `/:orgSlug${source}`,
      destination: `/:orgSlug${destination}`,
      permanent: false,
    }),
  );
}
