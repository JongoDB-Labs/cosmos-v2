import { Suspense } from "react";
import { projectWork } from "@/lib/integrations/microsoft/teams-app/tab-data.server";
import { TabSignIn } from "@/components/teams/tab-sign-in";
import { TabViewList } from "@/components/teams/tab-view";
import { tabOrigin, tabUser } from "../session.server";

type Props = { searchParams: Promise<{ org?: string; project?: string }> };

/** COSMOS-202 T1 d: a channel tab showing one project's open items. */
export default function ProjectTab({ searchParams }: Props) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: Props) {
  const { org, project } = await searchParams;
  const u = await tabUser();
  if (!u || (org && org !== u.slug)) return <TabSignIn org={org ?? null} />;
  const view = project ? await projectWork(u, await tabOrigin(), project) : null;
  // Not found and not allowed read the same.
  return view ? <TabViewList view={view} /> : <p className="p-6 text-sm">This project isn&apos;t available to you in Cosmos.</p>;
}
