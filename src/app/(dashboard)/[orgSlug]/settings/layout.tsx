import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import {
  SETTINGS_NAV_GROUPS,
  canViewSettings,
} from "@/lib/rbac/settings-access";
import { SettingsNav } from "@/components/settings/settings-nav";

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

  const groups = SETTINGS_NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => canViewSettings(ctx, i.href)),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <SettingsNav groups={groups} orgSlug={orgSlug} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
