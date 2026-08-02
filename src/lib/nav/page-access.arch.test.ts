// @vitest-environment node
//
// A page that DECLARES a permission in the sidebar must ENFORCE it.
//
// The sidebar has always carried `anyOf` per entry, and that is what hides
// Payroll from a contributor. The pages enforced nothing — every one checked
// only "are you signed in to this org" — so typing the URL loaded the screen.
// A member reached /accounting/payroll and got the Payroll page.
//
// The data was never exposed (the APIs gate independently), but "the API
// happened to also check" is not access control, it is luck about which layer
// somebody remembered. This test is the standing rule, because the failure is
// INVISIBLE in review: the sidebar link is gone, so the page looks unreachable.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { guardedPagePaths, requiredAnyOfFor, canViewPage } from "./page-access";
import { Permission } from "@/lib/rbac/permissions";

const DASHBOARD = "src/app/(dashboard)/[orgSlug]";

function pageFileFor(orgRelativePath: string): string | null {
  const seg = orgRelativePath.replace(/^\//, "");
  const file = seg ? `${DASHBOARD}/${seg}/page.tsx` : `${DASHBOARD}/page.tsx`;
  return existsSync(file) ? file : null;
}

/**
 * Paths whose page is NOT yet routed through `canViewPage`.
 *
 * Every entry here is a page a member can currently open by typing the URL.
 * The money screens were fixed first because they carry salaries, invoices and
 * bank data; these render a shell and then fetch nothing, because their APIs
 * gate independently. Shrinking this list to empty is the remaining work — do
 * NOT add to it.
 */
const NOT_YET_GUARDED = new Set([
  "/projects",
  "/time-tracking",
  "/crm",
  "/partners",
  "/products",
  "/contracts",
  "/analytics",
]);

describe("every page that declares a permission enforces it", () => {
  it("has at least one guarded path to check (the test is not vacuous)", () => {
    expect(guardedPagePaths().length).toBeGreaterThan(5);
  });

  for (const path of guardedPagePaths()) {
    const file = pageFileFor(path);
    if (!file) continue; // nav entry with no page of its own (a section index)

    it(`${path} enforces its declared permission`, () => {
      const src = readFileSync(file, "utf8");
      // The CALL, with this page's own path — not merely the word. Checking for
      // the bare identifier passes on the import line alone, so deleting the
      // guard and leaving the import would satisfy it. That is exactly the
      // mutation that survived the first version of this test.
      const call = new RegExp(
        `canViewPage\\(\\s*ctx\\.permissions\\s*,\\s*["\`]${path}["\`]\\s*\\)`,
      );
      if (NOT_YET_GUARDED.has(path)) {
        // Pinned so the exemption cannot silently become permanent: if someone
        // guards one of these, this line fails and they remove it from the set.
        expect(src).not.toMatch(call);
        return;
      }
      expect(src).toMatch(call);
    });
  }
});

describe("the requirement comes from the nav, not a second declaration", () => {
  it("reads Payroll's requirement straight off the sidebar entry", () => {
    const required = requiredAnyOfFor("/accounting/payroll");
    expect(required).toEqual([Permission.FINANCE_READ, Permission.ACCOUNTING_READ]);
  });

  it("lets a finance reader in and keeps a plain member out", () => {
    expect(canViewPage(Permission.FINANCE_READ, "/accounting/payroll")).toBe(true);
    expect(canViewPage(Permission.ACCOUNTING_READ, "/accounting/payroll")).toBe(true);
    // A contributor's bits — real ones, so this cannot pass by using 0n.
    const member = Permission.TIME_CREATE | Permission.ITEM_READ | Permission.PROJECT_READ;
    expect(canViewPage(member, "/accounting/payroll")).toBe(false);
  });

  it("treats a page with no declared requirement as open", () => {
    expect(requiredAnyOfFor("/definitely-not-in-the-nav")).toBeNull();
    expect(canViewPage(0n, "/definitely-not-in-the-nav")).toBe(true);
  });

  it("ignores a trailing slash rather than silently failing open", () => {
    // A lookup miss returns "unrestricted", so a normalisation bug here would
    // OPEN a page rather than close it — the dangerous direction.
    expect(canViewPage(0n, "/accounting/payroll/")).toBe(false);
  });
});
