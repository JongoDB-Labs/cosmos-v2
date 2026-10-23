import { redirect } from "next/navigation";

/**
 * The full-page assistant was retired: the topbar button and the floating
 * bubble open the assistant DRAWER on any page, and nothing linked here any
 * more. This stub sends old links and bookmarks to the org home instead of a
 * 404. The org home enforces its own auth, so no check is needed here.
 */
export default async function AssistantRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(`/${orgSlug}`);
}
