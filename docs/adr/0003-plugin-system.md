# ADR 0003 — Plugin system (fail-closed capability bundles on one trunk)

- **Status:** Accepted
- **Date:** 2026-07-16

## Context

ADR 0001 gives every customer/sector difference a home on one trunk: data/templates,
sector-scoped behavior, gated modules, adapters. What it lacks is a **packaging unit**
for a coherent bundle of customer-shaped surfaces — the ĒSO (Pontis product) build
needs a way to ship an A&E practice bundle (pace tracking, EOW→principal reporting,
fee-phase burn) that (a) stays out of every other customer's way, (b) keeps client IP
isolated from shared code, and (c) can be turned on per organization from Settings.

## Decision

A **plugin** is a named, versioned bundle of gated modules + adapters, registered
in-tree and enabled **per org** via Settings → Plugins. Plugins are rungs 3–4 of the
ADR-0001 ladder with a registry and an enablement row on top — never a fork, never a
separate deployable.

### The one load-bearing semantic: fail-closed

Module entitlements fail **open** (missing `OrgEntitlements` row = all modules on).
Plugins fail **closed**: a missing `OrgPluginState` row — or `enabled=false` — means
OFF. Adding a plugin to the codebase changes nothing for any running org anywhere
until that org (or its product profile at creation) opts in. Composition:

```
visible surfaces(org, user) = RBAC(user) ∩ coreEntitlements(org) ∩ pluginEnablement(org)
```

- Plugin module keys never enter `MODULES`/`ALL_MODULE_KEYS`; `applyEntitlements`
  passes plugin-tagged nav entries through and `applyPluginEnablement` (fail-closed)
  governs them.
- The sector gate is enforced at **enable time**: a plugin declaring `sectors`
  can only be enabled for an org whose enabled sectors intersect (400 otherwise).
- Disable hides everything (nav, pages 404, APIs 403, AI tools refused at dispatch)
  but **keeps the row, config, and all plugin domain data** — re-enable restores.

### Shape

- **Registry** (`src/lib/plugins/registry.ts`): client-safe `PluginManifest`
  (slug, version, sectors, contributed modules/nav, typed configFields — no secrets;
  secrets go through the integrations credential vault) + server-only
  `PluginServerHooks` (zod configSchema, onFirstEnable/onUpgrade provisioning,
  aiTools + executeTool, IntegrationProvider adapters).
- **Two composition files** are the only sanctioned shared→plugin imports:
  `src/lib/plugins/registry/index.ts` (manifests; may enter the client bundle) and
  `src/lib/plugins/registry/server.ts` (server hooks; server-only). Same pattern as
  the integrations catalog.
- **Isolation**: plugin code lives in `src/plugins/<slug>/**` and may import
  anything from shared code; nothing else imports it except the composition files
  and thin route shims under `src/app/**/(plugin-<slug>)/…` (App Router requires
  routes under `src/app`; shims are ≤20 lines and re-export from the plugin).
  Enforced by `plugin-isolation.arch.test.ts` + an ESLint `no-restricted-imports`
  mirror. Plugin-owned Prisma models are `<Slug>*`-prefixed, additive-only, and
  queried only inside the plugin (arch-tested).
- **Storage**: `OrgPluginState` — row per (org, plugin): `enabled`, `config`
  (validated by the plugin's zod schema), `enabledVersion/By/At`.
- **Provisioning**: `ProductProfile.defaultEnabledPlugins` (+ `DEFAULT_ENABLED_PLUGINS`
  env CSV override) auto-enables plugins for NEW orgs on that product — pontis →
  `["pontis"]`, cosmos → `[]`. `onFirstEnable` runs once per org (recorded via
  `enabledVersion`); a manifest version bump triggers `onUpgrade` on next enable.
- **Settings surface**: `/settings/plugins` gated by the dedicated
  `PLUGIN_MANAGE` permission bit; GET/PATCH under `/api/v1/orgs/[orgId]/plugins`;
  every toggle/config change audited (`plugin.enabled|disabled|config_updated`).

### Versioning / compatibility

In-tree plugins ride the single image + version stream (no separate artifact).
`PluginManifest.version` handles per-org data migrations via `onUpgrade`;
`minCosmosVersion` is asserted by `registry-invariants.test.ts` against
`package.json` (a runtime check would be dead code for in-tree plugins, but the
field future-proofs out-of-tree distribution). `PLUGIN_API_VERSION` guards the
manifest contract itself — a mismatch throws at registration, which the invariants
test turns into red CI before anything ships.

## Consequences

- The first plugin, **pontis** (`src/plugins/pontis/**`), carries the ĒSO A&E
  bundle; its ESO-specific vocabulary and brand assets are invisible to every
  other org and product face.
- CI must stay green for both products with the plugin disabled (default
  everywhere except pontis-profile org creation) — guaranteed by fail-closed
  defaults plus the existing two-product build matrix.
- Registry-invariant tests keep plugin nav ids/hrefs disjoint from the core IA,
  so a plugin can never shadow a core surface.
