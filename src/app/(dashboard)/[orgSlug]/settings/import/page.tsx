import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { ImportWizard } from "@/components/import/import-wizard";
import { availableEntityDefs } from "@/lib/import/entity-fields";
import { PluginRegistry } from "@/lib/plugins/registry";
import { getEnabledPluginSlugs } from "@/lib/plugins/enablement";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Import records from another system, across the whole organisation.
 *
 * Distinct from a project's own import screen: an export from another system
 * carries every project at once and may name projects this org has never heard
 * of, so there is no single project to be "in".
 *
 * Which record types appear depends on the plugins this org has switched on,
 * which only the server knows — hence the list is resolved here and handed to
 * the wizard rather than read from a static registry in the browser.
 */
export default async function OrgImportPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  if (!hasPermission(ctx.permissions, Permission.ORG_IMPORT)) redirect(`/${orgSlug}/settings`);

  const enabled = await getEnabledPluginSlugs(ctx.orgId);
  const entities = availableEntityDefs(PluginRegistry.getAll(), enabled).filter(
    (e) => e.scope === "org",
  );

  return (
    <PageShell
      title="Import"
      description="Bring records in from another system's export — a spreadsheet of projects, phases or people"
      maxWidth="5xl"
    >
      {entities.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          Nothing to import across the organisation yet. Record types that span every project are
          added by plugins; to bring records into a single project, use that project&apos;s own
          Import screen.
        </p>
      ) : (
        <ImportWizard orgId={ctx.orgId} orgSlug={orgSlug} entities={entities} />
      )}
    </PageShell>
  );
}
