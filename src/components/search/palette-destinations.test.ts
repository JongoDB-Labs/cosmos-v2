// The ⌘K palette's page list is built from the sidebar, topbar and Settings
// menus, through their own filters. These tests pin that: each role gets only
// pages it may open, org switches hide what the sidebar hides, and a page added
// to either menu reaches the palette without anyone editing it.
import { beforeAll, describe, expect, it } from "vitest";
import { Blocks } from "lucide-react";
import { paletteDestinations, matchesWords } from "./palette-destinations";
import { SIDEBAR_NAV } from "@/components/layouts/nav-config";
import { visibleTopbarNav } from "@/components/layouts/topbar-nav";
import { SETTINGS_NAV_GROUPS, canViewSettings } from "@/lib/rbac/settings-access";
import { canViewPage } from "@/lib/nav/page-access";
import { RolePermissions, hasPermission } from "@/lib/rbac/permissions";
import { PluginRegistry, PLUGIN_API_VERSION } from "@/lib/plugins/registry";

const ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER", "GUEST", "BILLING_ADMIN"] as const;
type Role = (typeof ROLES)[number];

// A stub plugin, registered once for the whole file (the registry has no
// unregister). It is enabled only where a test lists its slug.
const STUB = "palette-test-stub";
beforeAll(() => {
  PluginRegistry.register({
    apiVersion: PLUGIN_API_VERSION,
    slug: STUB,
    name: "Stub",
    description: "",
    icon: Blocks,
    version: "1.0.0",
    modules: [
      {
        key: "palette-stub",
        label: "Stub Module",
        nav: { type: "leaf", id: "palette-stub", icon: Blocks, label: "Stub Module", href: "/stub-module" },
      },
    ],
  });
});

function forRole(role: Role, org: Parameters<typeof paletteDestinations>[0]["org"] = {}) {
  const permissions = RolePermissions[role];
  return paletteDestinations({
    can: (p) => hasPermission(permissions, p),
    permissions,
    org,
  });
}

const labels = (role: Role, org?: Parameters<typeof forRole>[1]) => forRole(role, org).map((d) => d.label);

const sidebarLeafHrefs = SIDEBAR_NAV.flatMap((e) =>
  e.type === "leaf" ? [e.href] : e.children.map((c) => c.href),
);
const settingsHrefs = SETTINGS_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));

describe("paletteDestinations", () => {
  it.each(ROLES)("offers %s only pages the role may open", (role) => {
    const permissions = RolePermissions[role];
    const can = (p: bigint) => hasPermission(permissions, p);
    const topbar = new Set(visibleTopbarNav(can).map((t) => t.href ?? t.drawer));
    for (const d of forRole(role)) {
      if (d.group === "settings") {
        expect(canViewSettings({ permissions }, d.href!), d.label).toBe(true);
      } else if (d.drawer !== undefined) {
        expect(topbar.has(d.drawer), d.label).toBe(true);
      } else if (sidebarLeafHrefs.includes(d.href)) {
        expect(canViewPage(permissions, d.href), d.label).toBe(true);
      } else if (d.href !== "/feedback") {
        expect(topbar.has(d.href), d.label).toBe(true);
      }
    }
  });

  it("gives a member API Keys but not Finance", () => {
    const l = labels("MEMBER");
    expect(l).toContain("Settings › API Keys");
    expect(l).not.toContain("Accounting › Finance");
  });

  it("gives a guest neither API Keys, Finance nor Projects", () => {
    const l = labels("GUEST");
    expect(l).not.toContain("Settings › API Keys");
    expect(l).not.toContain("Accounting › Finance");
    expect(l).not.toContain("Projects");
  });

  it("offers nothing without a current org", () => {
    const permissions = RolePermissions.OWNER;
    expect(paletteDestinations({ can: () => true, permissions, org: undefined })).toEqual([]);
  });

  it("offers an owner every sidebar page and every Settings page", () => {
    const hrefs = forRole("OWNER").map((d) => d.href);
    for (const h of [...sidebarLeafHrefs, ...settingsHrefs]) expect(hrefs, h).toContain(h);
  });

  it("drops modules the org has switched off", () => {
    const l = labels("OWNER", { enabledModules: ["projects"] });
    expect(l).toContain("Projects");
    expect(l.some((x) => x.startsWith("CRM ›"))).toBe(false);
    expect(l.some((x) => x.startsWith("Accounting ›"))).toBe(false);
  });

  it("drops sections an admin has hidden from the sidebar", () => {
    const l = labels("OWNER", { navLayout: { hidden: ["accounting"] } });
    expect(l).toContain("Projects");
    expect(l.some((x) => x.startsWith("Accounting ›"))).toBe(false);
  });

  it("offers a plugin's page only where the plugin is enabled", () => {
    expect(labels("OWNER")).not.toContain("Stub Module");
    expect(labels("OWNER", { enabledPlugins: [STUB] })).toContain("Stub Module");
  });

  it("gives every row a unique key", () => {
    const keys = forRole("OWNER", { enabledPlugins: [STUB] }).map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("matchesWords", () => {
  it("needs every word, in any order, ignoring case", () => {
    expect(matchesWords("Settings › API Keys", "api SETTINGS")).toBe(true);
    expect(matchesWords("Settings › API Keys", "api webhooks")).toBe(false);
    expect(matchesWords("Anything", "  ")).toBe(true);
  });
});
