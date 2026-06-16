/**
 * Canonical catalog of gateable product modules + industry sectors.
 *
 * Module keys ARE the top-level sidebar nav ids (src/components/layouts/nav-config.ts),
 * so an entitlement allowlist lines up 1:1 with the IA. `overview` and `settings`
 * are FIXED (the fixed anchors of the nav, FIXED_NAV_IDS there) — always on, never
 * gateable. Sectors mirror the seeded industry verticals (prisma/seed/sectors/*).
 *
 * Enforcement (nav + API/proxy) is Foundation Plan 3; this file is the shared
 * vocabulary both the data layer (here) and the enforcement layer (later) read.
 */

export const MODULES = [
  { key: "projects", label: "Projects" },
  { key: "issues", label: "Issues" },
  { key: "time-tracking", label: "Time Tracking" },
  { key: "crm", label: "CRM" },
  { key: "accounting", label: "Accounting" },
  { key: "analytics", label: "Analytics" },
] as const;

export type ModuleKey = (typeof MODULES)[number]["key"];

export const ALL_MODULE_KEYS: ModuleKey[] = MODULES.map((m) => m.key);

/** Always-on modules — the fixed anchors of the IA (overview + settings). */
export const FIXED_MODULES = ["overview", "settings"] as const;
export type FixedModuleKey = (typeof FIXED_MODULES)[number];

/** Seeded industry verticals (prisma/seed/sectors). */
export const SECTORS = [
  "software",
  "aec",
  "ops",
  "consulting",
  "manufacturing",
  "education",
  "event",
] as const;
export type SectorKey = (typeof SECTORS)[number];
