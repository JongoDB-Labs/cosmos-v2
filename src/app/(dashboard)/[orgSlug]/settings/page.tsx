import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { canViewSettings, SETTINGS_NAV_GROUPS } from "@/lib/rbac/settings-access";

export default async function SettingsIndexPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  const first = SETTINGS_NAV_GROUPS.flatMap((g) => g.items).find((i) => canViewSettings(ctx, i.href));
  redirect(`/${orgSlug}${first?.href ?? "/settings/profile"}`);
}
