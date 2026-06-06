import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { MeetingDetail } from "@/components/meetings/meeting-detail";

type PageParams = { params: Promise<{ orgSlug: string; meetingId: string }> };

export default async function MeetingDetailPage({ params }: PageParams) {
  const { orgSlug, meetingId } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return <MeetingDetail orgId={ctx.orgId} meetingId={meetingId} />;
}
