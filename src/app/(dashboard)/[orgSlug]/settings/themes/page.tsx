import { redirect } from "next/navigation";

/**
 * The Themes settings page was merged into Preferences (its org-branding
 * controls now live in the "Organization branding" section there) as of
 * v2.100.1. This stub redirects the old route so existing links and bookmarks
 * land in the right place instead of 404ing. The preferences page enforces its
 * own auth, so no permission check is needed here.
 */
export default async function ThemesRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(`/${orgSlug}/settings/preferences`);
}
