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
  /**
   * This plugin is PAID: enabling it additionally requires a valid signed
   * entitlement naming this slug (ADR 0004, Tier 1). See src/lib/licensing.
   *
   * Opt-in per plugin, and omitted ⇒ no licence needed, so adding the licensing
   * mechanism changed nothing for plugins already in the field. Setting this is
   * the single, reviewable edit that makes a plugin commercial — which is why it
   * is a manifest flag and not a lookup somewhere less visible.
   */
  requiresEntitlement?: boolean;
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
  /**
   * Full-width panel on the Finance page's revenue tab.
   *
   * For revenue a plugin already tracks against its own delivery model — fees
   * committed per project, what has been logged, billed and collected — which
   * core's revenue ledger has no view of. Core gates the TAB on
   * ACCOUNTING_READ; a contributor still owes its own money check, since the
   * figures it shows are not core's to clear.
   */
  "finance.revenuePanel": { orgId: string };
};
export type PluginSlotName = keyof PluginSlotProps;
export type PluginSlots = {
  [K in PluginSlotName]?: ComponentType<PluginSlotProps[K]>;
};

/** Context handed to plugin AI-tool executors. */
export type PluginToolContext = { orgId: string; userId: string };

/** SERVER-ONLY contributions, registered separately (registry/server.ts) so they
 *  never enter a client bundle. */
/**
 * What one rule did on a single run. Counts, not payloads: a scheduler reads
 * this to tell a working run from a broken one, and it must not become a
 * channel for org data to leave through a machine account's log.
 */
export type RuleRunSummary = {
  /** Namespaced, e.g. "<plugin>.<rule>" -- so two plugins cannot collide. */
  rule: string;
  raised: number;
  resolved: number;
  notified?: number;
};

export type PluginServerHooks = {
  /** Must match a registered manifest slug. */
  slug: string;
  /** zod schema for OrgPluginState.config — validated in the PATCH route. */
  configSchema?: z.ZodType<Record<string, unknown>>;
  /** Idempotent per-org provisioning, run on FIRST enable. */
  onFirstEnable?: (prisma: PrismaClient, orgId: string) => Promise<void>;
  /** Run when the stored enabledVersion !== manifest.version at enable time. */
  onUpgrade?: (prisma: PrismaClient, orgId: string, from: string | null) => Promise<void>;
  /**
   * Run after a project is created in an org where this plugin is enabled, so a
   * plugin can attach its own per-project setup (e.g. instantiate a per-project
   * template). Best-effort and fired POST-COMMIT: a throw here is logged and
   * swallowed — a plugin must never be able to fail core project creation — and
   * the project row is already committed, so the hook can query and mutate it.
   */
  onProjectCreate?: (prisma: PrismaClient, orgId: string, projectId: string) => Promise<void>;
  /** AI tools appended to the org's agent catalog while the plugin is enabled. */
  aiTools?: ToolDefinition[];
  /**
   * Executor for those tools. Return undefined for "not mine" (falls through).
   *
   * ACCESS CONTROL IS YOURS TO ENFORCE — nothing here does it for you. A plugin
   * tool runs on the SAME agent surface as the core ones and reaches the same
   * database, but it bypasses `lib/ai/executors/_ctx.ts` entirely: the core
   * tools' gates are function calls each one makes, not middleware every tool
   * passes through.
   *
   * `PluginToolContext` is deliberately shaped like the core `ToolContext`
   * ({ orgId, userId }) so the same helpers work here. Use them:
   *
   *   assertPermission(ctx, Permission.X)          — the actor holds the bit
   *   assertProjectRead(ctx, projectId, "X_READ")  — and may open THAT project
   *
   * The second is the one that gets missed. A permission MEMBER and VIEWER both
   * hold — ITEM_READ, ANALYTICS_READ, SPRINT_READ, COMMENT_READ — says the actor
   * may read SOME of a thing and nothing about WHICH. A project with
   * `teamScopedAccess` is closed to non-members, and "it exists in this org" is
   * a different question from "may this person open it". That gap was found
   * across ~30 core tools in 2.265.3.
   *
   * A plugin can reintroduce it, and no test in THIS repo will notice, because
   * plugins live in their own repositories.
   */
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    ctx: PluginToolContext,
  ) => Promise<unknown | undefined>;
  /**
   * Evaluate this plugin's standing rules for an org, raising and sweeping
   * flags. Called periodically, and safe to call at any time: a rule is
   * expected to be idempotent, because it will be.
   *
   * Only invoked when the plugin is enabled AND licensed for the org. A throw
   * is caught and reported per-plugin, so one plugin cannot starve the rest --
   * but it IS reported, not swallowed, because a scheduled run that always
   * claims success hides a rule that stopped working months ago.
   */
  runRules?: (prisma: PrismaClient, orgId: string) => Promise<RuleRunSummary[]>;
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
