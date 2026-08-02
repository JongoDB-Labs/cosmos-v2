import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  ACCOUNTING_SECTION_DEFAULT,
  LEGACY_ORG_PATH_REDIRECTS,
  legacyRedirectRules,
} from "./legacy-redirects";
import { SIDEBAR_NAV, type NavLeaf } from "@/components/layouts/nav-config";
import { MOBILE_NAV_DESTINATIONS } from "./mobile-nav";

/**
 * These tests exist because the redirect map is the ONLY thing keeping every
 * bookmark, pasted link and notification URL that predates the Accounting IA
 * move alive. A silent hole in it is invisible from the app: the old URL just
 * 404s for whoever still has it.
 *
 * Two failure modes are guarded, and they need different tests:
 *   - a path DROPPED from the map (the map itself is pinned below), and
 *   - a path still in the map but pointing at a route that no longer exists
 *     (checked against the real app directory, so a future page rename fails
 *     here instead of shipping a redirect into a 404).
 */

const APP_ORG_DIR = path.resolve(
  __dirname,
  "../../app/(dashboard)/[orgSlug]",
);

/** Does an org-relative path resolve to a real page route? */
function routeExists(orgRelativePath: string): boolean {
  const dir = path.join(APP_ORG_DIR, orgRelativePath);
  return existsSync(path.join(dir, "page.tsx"));
}

/** Every leaf in the sidebar tree, flattened out of its groups. */
function allNavLeaves(): NavLeaf[] {
  return SIDEBAR_NAV.flatMap((e) =>
    e.type === "group" ? e.children : [e],
  );
}

describe("legacy /finance -> /accounting redirects", () => {
  it("maps every old Accounting-section path to its new home", () => {
    // Pinned in full: adding a route to the section without adding its legacy
    // path here is fine, but silently DROPPING one of these is not.
    expect(LEGACY_ORG_PATH_REDIRECTS).toEqual({
      "/finance": "/accounting/finance",
      // The old ledger page has no 1:1 successor — its panels are tabs on the
      // Finance page now.
      "/finance/accounting": "/accounting/finance",
      "/finance/banking": "/accounting/banking",
      "/finance/payroll": "/accounting/payroll",
      "/finance/tax": "/accounting/tax",
      "/finance/invoices": "/accounting/invoices",
    });
  });

  it("covers every page route that used to live under /finance", () => {
    // The six routes that existed before the move. Kept as a literal list so
    // deleting a redirect cannot be self-justifying.
    const oldRoutes = [
      "/finance",
      "/finance/accounting",
      "/finance/banking",
      "/finance/payroll",
      "/finance/tax",
      "/finance/invoices",
    ];
    for (const old of oldRoutes) {
      expect(
        Object.keys(LEGACY_ORG_PATH_REDIRECTS),
        `${old} lost its redirect — anyone holding that bookmark now gets a 404`,
      ).toContain(old);
    }
  });

  it("sends every old path to a route that actually exists", () => {
    for (const [from, to] of Object.entries(LEGACY_ORG_PATH_REDIRECTS)) {
      expect(routeExists(to), `${from} -> ${to} but ${to} has no page.tsx`).toBe(
        true,
      );
    }
  });

  it("leaves no old path still served by a page (redirects run first, but a stale route would be dead code)", () => {
    for (const from of Object.keys(LEGACY_ORG_PATH_REDIRECTS)) {
      expect(
        routeExists(from),
        `${from} still has a page.tsx; the redirect shadows it forever`,
      ).toBe(false);
    }
  });

  it("never redirects to a path that is itself redirected (no chains or loops)", () => {
    const sources = new Set(Object.keys(LEGACY_ORG_PATH_REDIRECTS));
    for (const [from, to] of Object.entries(LEGACY_ORG_PATH_REDIRECTS)) {
      expect(sources.has(to), `${from} -> ${to} chains into another redirect`).toBe(
        false,
      );
    }
  });

  it("templates the org slug into next.config rules and stays reversible (307)", () => {
    const rules = legacyRedirectRules();
    expect(rules).toHaveLength(Object.keys(LEGACY_ORG_PATH_REDIRECTS).length);
    for (const rule of rules) {
      expect(rule.source.startsWith("/:orgSlug/")).toBe(true);
      expect(rule.destination.startsWith("/:orgSlug/")).toBe(true);
      // A 308 is cached by the browser forever; this app auto-deploys to prod.
      expect(rule.permanent).toBe(false);
    }
    expect(rules).toContainEqual({
      source: "/:orgSlug/finance/invoices",
      destination: "/:orgSlug/accounting/invoices",
      permanent: false,
    });
  });

  it("lands the Accounting section index on a real page", () => {
    expect(routeExists(ACCOUNTING_SECTION_DEFAULT)).toBe(true);
    expect(routeExists("/accounting")).toBe(true);
  });
});

describe("navigation points at the new URLs only", () => {
  it("has no sidebar leaf still pointing at a legacy path", () => {
    for (const leaf of allNavLeaves()) {
      expect(
        Object.keys(LEGACY_ORG_PATH_REDIRECTS),
        `sidebar item "${leaf.label}" links to ${leaf.href}, which redirects`,
      ).not.toContain(leaf.href);
    }
  });

  it("has no mobile-nav destination still pointing at a legacy path", () => {
    for (const dest of MOBILE_NAV_DESTINATIONS) {
      expect(
        Object.keys(LEGACY_ORG_PATH_REDIRECTS),
        `mobile nav "${dest.label}" links to ${dest.href}, which redirects`,
      ).not.toContain(dest.href);
    }
  });

  it("gives the Accounting group the five children the URLs promise", () => {
    const group = SIDEBAR_NAV.find(
      (e) => e.type === "group" && e.id === "accounting",
    );
    expect(group?.type).toBe("group");
    const children = group?.type === "group" ? group.children : [];
    expect(children.map((c) => c.label)).toEqual([
      "Finance",
      "Banking",
      "Payroll",
      "Tax",
      "Invoices",
    ]);
    // The whole point of the move: label and URL segment agree, and the group
    // label is not repeated by a child.
    for (const child of children) {
      expect(
        child.href,
        `${child.label} must live under /accounting/`,
      ).toMatch(/^\/accounting\//);
      expect(child.label).not.toBe("Accounting");
      expect(routeExists(child.href), `${child.href} has no page.tsx`).toBe(true);
    }
  });

  it("no longer offers Invoices from the CRM group", () => {
    const crm = SIDEBAR_NAV.find((e) => e.type === "group" && e.id === "crm");
    const children = crm?.type === "group" ? crm.children : [];
    expect(children.map((c) => c.label)).toEqual([
      "Contacts",
      "Partners",
      "Products",
      "Contracts",
    ]);
  });
});
