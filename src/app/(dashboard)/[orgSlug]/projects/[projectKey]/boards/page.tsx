import { redirect } from "next/navigation";

type PageParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
};

/**
 * `/boards` has no index UI — boards live at `/boards/[boardId]`. Without this
 * route the "Boards" breadcrumb and prefetch hit a 404 RSC fetch [BUG-65].
 * Redirect to the project page, which lands on the project's default board.
 */
export default async function BoardsIndexPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  redirect(`/${orgSlug}/projects/${projectKey}`);
}
