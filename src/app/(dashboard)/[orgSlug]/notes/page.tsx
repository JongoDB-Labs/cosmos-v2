import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { NotesList } from "@/components/notes/notes-list";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function NotesPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Notes" description="Workspace knowledge base" maxWidth="7xl">
      <NotesList orgId={ctx.orgId} />
    </PageShell>
  );
}
