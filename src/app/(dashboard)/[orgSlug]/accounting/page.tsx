import { redirect } from "next/navigation";
import { ACCOUNTING_SECTION_DEFAULT } from "@/lib/nav/legacy-redirects";

/**
 * The Accounting section index. "Accounting" is a sidebar GROUP, not a page —
 * but it IS a breadcrumb segment (/{orgSlug}/accounting/{page}), and that crumb
 * is a link. Without this route the crumb would 404, so it lands on the
 * section's first child (Finance).
 *
 * No auth read here. Unlike the /settings index — which uses the context to
 * pick the first child the caller may actually see — this one has a FIXED
 * destination, and that destination (accounting/finance/page.tsx) already does
 * the identical `getAuthContext` + `redirect("/")` check plus its own
 * `canViewPage` gate. A session+DB read that gates nothing on the way to a page
 * that re-reads it anyway is a round-trip, not a guard.
 */
export default async function AccountingIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(`/${orgSlug}${ACCOUNTING_SECTION_DEFAULT}`);
}
