import { SIDEBAR_NAV, type NavEntry, type NavLeaf } from "@/components/layouts/nav-config";
import { hasAnyPermission } from "@/lib/rbac/permissions";

/**
 * Whether an actor may VIEW a dashboard page, derived from the same nav
 * declaration that decides whether they can SEE the link.
 *
 * The sidebar has always declared `anyOf` per entry, and that is what hides
 * Payroll from a contributor. The PAGES enforced nothing — every one of them
 * checked only "are you signed in to this org". So typing the URL loaded the
 * screen: 12 of the 14 pages that declared a permission enforced none of it.
 *
 * The data itself was never exposed — the APIs gate independently, which is why
 * a member who browsed to Payroll saw an empty table rather than salaries. But
 * "the API happened to also check" is not access control, it is luck about
 * which layer someone remembered. A page a person is not entitled to see should
 * not render its shell, its headings, or its affordances.
 *
 * DERIVED, never re-declared. Writing the permission a second time on the page
 * is how the two drift: someone tightens the nav, the page keeps the old rule,
 * and the gap is invisible because the link is gone from the sidebar. There is
 * one source of truth and `page-access.arch.test.ts` proves every page uses it.
 */

/** Org-relative path -> the permissions any ONE of which grants access. */
function buildIndex(): Map<string, bigint[]> {
  const index = new Map<string, bigint[]>();
  const visit = (entries: NavEntry[]) => {
    for (const entry of entries) {
      if (entry.type === "group") {
        visit(entry.children);
        continue;
      }
      const leaf = entry as NavLeaf;
      // An entry with no `anyOf` is open to any member of the org — the org
      // overview, for instance. Absence means "no requirement", not "unknown".
      if (leaf.anyOf && leaf.anyOf.length > 0) {
        index.set(normalise(leaf.href), leaf.anyOf);
      }
    }
  };
  visit(SIDEBAR_NAV);
  return index;
}

/** Trailing slashes and the empty root normalised so lookups are exact. */
function normalise(href: string): string {
  const trimmed = href.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

const PAGE_PERMISSIONS = buildIndex();

/** Every org-relative path that declares a permission requirement. */
export function guardedPagePaths(): string[] {
  return [...PAGE_PERMISSIONS.keys()].sort();
}

/** The permissions any one of which grants this page, or null if unrestricted. */
export function requiredAnyOfFor(orgRelativePath: string): bigint[] | null {
  return PAGE_PERMISSIONS.get(normalise(orgRelativePath)) ?? null;
}

/**
 * May this actor view the page?
 *
 * Unrestricted pages return true — this answers "does the nav requirement let
 * them in", not "are they authenticated", which the caller has already
 * established.
 */
export function canViewPage(permissions: bigint, orgRelativePath: string): boolean {
  const required = requiredAnyOfFor(orgRelativePath);
  if (!required) return true;
  return hasAnyPermission(permissions, ...required);
}
