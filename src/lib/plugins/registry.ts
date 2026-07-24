import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { SectorKey } from "@/lib/entitlements/modules";
// TYPE-ONLY import — erased at compile time, so no runtime cycle with nav-config
// (nav-config never imports this file; composition lives in nav-plugins.ts).
import type { NavEntry } from "@/components/layouts/nav-config";
import type { ToolDefinition } from "@/lib/ai/tools";
import type { IntegrationProvider } from "@/lib/integrations/registry";
import type { PrismaClient } from "@prisma/client";
import type { z } from "zod";

/**
 * PLUGIN REGISTRY (ADR 0003) — the packaging rung above sector templates and
 * gated modules: a named, versioned bundle of surfaces a tenant opts into via
 * Settings → Plugins. Plugins are a FAIL-CLOSED axis (no OrgPluginState row =
 * off), the deliberate opposite of module entitlements' fail-open default —
 * customer/sector-specific capability must never appear for an org that didn't
 * opt in.
 *
 * Isolation contract: plugin code lives in "src/plugins/<slug>/" and may import
 * anything from shared code; shared code may import plugin code ONLY through the
 * two composition files (registry/index.ts for client-safe manifests,
 * registry/server.ts for server hooks) and the thin route shims inside a
 * "(plugin-<slug>)" route group under src/app. Enforced by
 * plugin-isolation.arch.test.ts.
 */

/** Bumped only when the manifest CONTRACT changes shape. Registration refuses mismatches. */
export const PLUGIN_API_VERSION = 1 as const;

/** One gated feature surface the plugin contributes = one top-level sidebar entry. */
export type PluginModule = {
  /** Module key === the top-level nav id it contributes (same identity rule as
   *  core MODULES). Must not collide with core ModuleKey / SIDEBAR_NAV ids —
   *  enforced by registry-invariants.test.ts. */
  key: string;
  label: string;
  /** The top-level NavEntry (leaf or group). entry.id must equal `key`. `anyOf`
   *  uses CORE Permission bits — plugins do not mint permission bits. */
  nav: NavEntry;
};

export type PluginConfigField = {
  key: string;
  label: string;
  type: "text" | "url" | "number" | "boolean" | "select";
  required: boolean;
  options?: string[]; // for "select"
  help?: string;
  // Deliberately NO `secret` here: plugin config is plaintext org config.
  // Secrets belong in the integrations credential vault (IntegrationProvider
  // configFields with secret:true → ConnectorCredential).
};

/** CLIENT-SAFE manifest — may enter the client bundle (nav labels, icons, copy).
 *  No prisma, no seed logic, no zod schema values. */
export type PluginManifest = {
  apiVersion: typeof PLUGIN_API_VERSION;
  /** Stable id; recorded in OrgPluginState.pluginSlug. Lowercase, [a-z0-9-]. */
  slug: string;
  name: string;
  description: string;
  icon: LucideIcon;
  /** The plugin's own semver, independent of package.json — recorded on enable
   *  (OrgPluginState.enabledVersion) to drive onFirstEnable/onUpgrade. */
  version: string;
  /** Documented compatibility floor, asserted by registry-invariants.test.ts
   *  against package.json (in-tree plugins ship with the image, so a runtime
   *  check would be dead code). */
  minCosmosVersion?: string;
  /** Org must have ≥1 of these sectors enabled to ENABLE the plugin (org
   *  enabledSectors === null passes). Omitted ⇒ sector-agnostic. */
  sectors?: SectorKey[];
  modules: PluginModule[];
  /** Rendered generically by the Plugins settings panel as a typed form. */
  configFields?: PluginConfigField[];
  /** Display hint only ("looks best with the Atelier skin"). Never auto-applied —
   *  skins/brand stay owned by resolveBrand()/Organization.defaultSkinId. */
  recommendedSkinId?: string;
  /** Components this plugin renders into core UI slots (see PluginSlotProps). Rendered
   *  by <PluginSlot> ONLY when the plugin is enabled for the org (fail-closed). */
  slots?: PluginSlots;
};

/**
 * CORE-OWNED UI slot vocabulary. Core embeds `<PluginSlot name="..." {...props}/>` at
 * these named extension points; an ENABLED plugin may contribute a component that
 * renders there. Client-safe (components, like `icon`). Fail-closed: a slot with no
 * enabled contributor renders nothing. Add a slot name here (with its prop shape) to
 * open a new extension point — the same closed-vocabulary discipline as MODULES.
 */
export type PluginSlotProps = {
  /** Compact status card on the org dashboard/overview. */
  "overview.card": { orgId: string };
  /** Inline badge inside the work-item detail sheet. */
  "workItem.detailBadge": { orgId: string; workItemId: string };
};
export type PluginSlotName = keyof PluginSlotProps;
export type PluginSlots = {
  [K in PluginSlotName]?: ComponentType<PluginSlotProps[K]>;
};

/** Context handed to plugin AI-tool executors. */
export type PluginToolContext = { orgId: string; userId: string };

/** SERVER-ONLY contributions, registered separately (registry/server.ts) so they
 *  never enter a client bundle. */
export type PluginServerHooks = {
  /** Must match a registered manifest slug. */
  slug: string;
  /** zod schema for OrgPluginState.config — validated in the PATCH route. */
  configSchema?: z.ZodType<Record<string, unknown>>;
  /** Idempotent per-org provisioning, run on FIRST enable. */
  onFirstEnable?: (prisma: PrismaClient, orgId: string) => Promise<void>;
  /** Run when the stored enabledVersion !== manifest.version at enable time. */
  onUpgrade?: (prisma: PrismaClient, orgId: string, from: string | null) => Promise<void>;
  /** AI tools appended to the org's agent catalog while the plugin is enabled. */
  aiTools?: ToolDefinition[];
  /** Executor for those tools. Return undefined for "not mine" (falls through). */
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    ctx: PluginToolContext,
  ) => Promise<unknown | undefined>;
  /** Adapter/integration descriptors, forwarded to IntegrationRegistry.register()
   *  by registry/server.ts (they carry sector tags the integrations UI already
   *  understands). */
  integrations?: IntegrationProvider[];
};

const manifests = new Map<string, PluginManifest>();
const serverHooks = new Map<string, PluginServerHooks>();

export const PluginRegistry = {
  register(m: PluginManifest) {
    if (m.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(
        `plugin ${m.slug}: apiVersion ${m.apiVersion} does not match framework PLUGIN_API_VERSION ${PLUGIN_API_VERSION}`,
      );
    }
    manifests.set(m.slug, m);
  },
  get: (slug: string) => manifests.get(slug),
  getAll: () => Array.from(manifests.values()),
};

export const PluginServerRegistry = {
  register(h: PluginServerHooks) {
    serverHooks.set(h.slug, h);
  },
  get: (slug: string) => serverHooks.get(slug),
  getAll: () => Array.from(serverHooks.values()),
};
