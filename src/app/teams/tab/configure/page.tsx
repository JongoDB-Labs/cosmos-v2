import { Suspense } from "react";
import { tabProjects } from "@/lib/integrations/microsoft/teams-app/tab-data.server";
import { TabSignIn } from "@/components/teams/tab-sign-in";
import { TabConfigure } from "@/components/teams/tab-configure";
import { tabOrigin, tabUser } from "../session.server";

type Props = { searchParams: Promise<{ org?: string }> };

/** COSMOS-202 T1 d: configure a channel tab (pick a project). */
export default function ConfigureTab({ searchParams }: Props) {
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
  return <TabConfigure origin={await tabOrigin()} org={u.slug} projects={await tabProjects(u)} />;
}
