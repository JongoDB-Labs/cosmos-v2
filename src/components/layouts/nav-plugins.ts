import { SIDEBAR_NAV, type NavEntry } from "./nav-config";
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
