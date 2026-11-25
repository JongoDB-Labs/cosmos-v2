import {
  SIDEBAR_NAV,
  applyAdminLayout,
  applyEntitlements,
  applyPluginEnablement,
  visibleNav,
  type NavEntry,
} from "./nav-config";
import { PluginRegistry } from "@/lib/plugins/registry";
import "@/lib/plugins/registry/index"; // side-effect: manifests registered (client-safe)

/**
 * SIDEBAR_NAV with plugin-contributed modules spliced in before the fixed
 * "settings" anchor. Lives apart from nav-config so nav-config stays free of
 * registry imports (no cycle: registry type-imports NavEntry from nav-config).
 *
 * Deterministic: the registry's contents are a static function of the one
 * image's code — per-ORG variation happens later in the pipeline via
 * applyPluginEnablement (fail-closed), never here.
 */
export function composeSidebarNav(): NavEntry[] {
  const pluginEntries: NavEntry[] = PluginRegistry.getAll().flatMap((p) =>
    p.modules.map((m) => ({ ...m.nav, pluginSlug: p.slug })),
  );
  if (pluginEntries.length === 0) return SIDEBAR_NAV;
  const i = SIDEBAR_NAV.findIndex((e) => e.id === "settings");
  if (i === -1) return [...SIDEBAR_NAV, ...pluginEntries];
  return [...SIDEBAR_NAV.slice(0, i), ...pluginEntries, ...SIDEBAR_NAV.slice(i)];
}

/** What the org switches that shape the sidebar look like on the client. */
export interface SidebarOrgSettings {
  enabledModules?: string[] | null;
  enabledPlugins?: string[];
  navLayout?: { order?: string[]; hidden?: string[] };
}

/**
 * The sidebar entries this person sees in this org: permission filter, module
 * entitlements (fail-open), plugin enablement (fail-closed), then the admin's
 * order and hidden list. One chain, shared by the sidebar and the ⌘K palette,
 * so the palette can never offer a section the sidebar hides.
 */
export function visibleSidebarNav(
  can: (p: bigint) => boolean,
  org: SidebarOrgSettings | undefined,
  navLayout?: { order?: string[]; hidden?: string[] },
): NavEntry[] {
  return applyAdminLayout(
    applyPluginEnablement(
      applyEntitlements(
        visibleNav(composeSidebarNav(), can),
        org?.enabledModules ?? null,
      ),
      new Set(org?.enabledPlugins ?? []),
    ),
    // Settings only ever CONSTRAIN: permission, entitlement and plugin
    // filtering have already run, so hiding can never reveal anything.
    navLayout ?? org?.navLayout,
  );
}
