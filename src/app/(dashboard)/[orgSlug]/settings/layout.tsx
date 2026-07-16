import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import {
  SETTINGS_NAV_GROUPS,
  canViewSettings,
} from "@/lib/rbac/settings-access";
import { SettingsNav } from "@/components/settings/settings-nav";
import { SettingsRealtime } from "@/components/settings/settings-realtime";

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const visibleHrefs = SETTINGS_NAV_GROUPS
    .flatMap((g) => g.items)
    .filter((i) => canViewSettings(ctx, i.href))
    .map((i) => i.href);

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      {/* App-wide live updates for settings/membership (COSMOS-130): a single
          org-scoped subscription that refreshes the open settings views when a
          change lands in another tab/user. */}
      <SettingsRealtime orgId={ctx.orgId} />
      <SettingsNav visibleHrefs={visibleHrefs} orgSlug={orgSlug} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
