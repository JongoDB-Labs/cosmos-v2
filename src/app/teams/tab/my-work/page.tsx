import { Suspense } from "react";
import { myWork } from "@/lib/integrations/microsoft/teams-app/tab-data.server";
import { TabSignIn } from "@/components/teams/tab-sign-in";
import { TabViewList } from "@/components/teams/tab-view";
import { tabOrigin, tabUser } from "../session.server";

type Props = { searchParams: Promise<{ org?: string }> };

/** COSMOS-202 T1 d: the personal "My work" tab. */
export default function MyWorkTab({ searchParams }: Props) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: Props) {
  const { org } = await searchParams;
  const u = await tabUser();
  if (!u || (org && org !== u.slug)) return <TabSignIn org={org ?? null} />;
  const view = await myWork(u, await tabOrigin());
  return view ? <TabViewList view={view} /> : <p className="p-6 text-sm">You can&apos;t see work items in Cosmos.</p>;
}
