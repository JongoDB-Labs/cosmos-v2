import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { ACCOUNTING_SECTION_DEFAULT } from "@/lib/nav/legacy-redirects";

/**
 * The Accounting section index. "Accounting" is a sidebar GROUP, not a page —
 * but it IS a breadcrumb segment (/{orgSlug}/accounting/{page}), and that crumb
 * is a link. Without this route the crumb would 404, so it lands on the
 * section's first child (Finance) — the same idiom as the /settings index.
 */
export default async function AccountingIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  redirect(`/${orgSlug}${ACCOUNTING_SECTION_DEFAULT}`);
}
