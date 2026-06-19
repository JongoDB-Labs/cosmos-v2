# ADR 0001 — One source, many products (cosmos-v2 as a multi-customer platform)

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

cosmos-v2 serves multiple customers through different **faces** (products) built from
the same code. Today a DoD / software-development community runs the original
`cosmos` product; an architecture & engineering firm (ĒSO) will run the `pontis`
product. More customers and job sectors are expected.

The requirement: **continually develop and refine the shared platform from multiple
customer lenses, without cross-pollination that negatively impacts any single
customer's deployment.** Same underlying things, different faces — and, over time,
possibly different modules/configs per customer based on job sector.

## Decision

cosmos-v2 is a **single source of truth** built into multiple products from **one
commit**. **Pontis is an A&E flavor of cosmos-v2, not a fork.** Every
customer/sector difference is expressed as **configuration, data, and gated modules
on one trunk** — never as forked or long-lived divergent code.

## The model

1. **One repo, one trunk (`main`), one version, ONE image.** A `vX.Y.Z` tag builds a
   SINGLE multi-arch image (`ghcr.io/jongodb-labs/cosmos-v2`) from one commit
   (`.github/workflows/release.yml`). The per-deployment product is a **runtime env**
   (`PRODUCT=<key>`), not a build-time matrix — so every deployment runs byte-identical
   bits and cannot drift. (Phase 3 of the runtime-skins/brand pivot collapsed the former
   `cosmos-v2` + `pontis` two-image matrix.)
2. **A product = a profile** (`src/lib/product/profiles.ts`): brand, skin, default
   module/sector entitlements, tenant class. The active profile is **selected at
   runtime** by `PRODUCT` (`getBrand()`), and brand/skin are further **overridable
   per-org** (Phase 2 `resolveBrand(org)` + org `defaultSkinId`). Default entitlements
   are overridable per-deployment via `DEFAULT_ENABLED_MODULES`/`DEFAULT_ENABLED_SECTORS`
   env. **Adding a customer/face = a new profile (+ optionally a runtime env), not a
   matrix row and never a fork.** Signing is uniform gov-grade for every image.
3. **Per-deployment + per-org scoping** via **entitlements** (modules + sectors,
   fail-open — `src/lib/entitlements/`) and **sector built-ins** (templates /
   work-item types seeded as global `orgId: null` rows). A customer sees only what
   their entitlements enable.
4. **Separate deployments per customer** (separate DB/infra), each built as its
   product, all drawing from one shared version stream.

## Isolation guarantees (no harmful cross-pollination)

Three layers ensure a change made through one customer's lens cannot silently harm
another's deployment:

- **Runtime-selection (was build-time).** `PRODUCT` (a runtime env) selects exactly one
  profile per render; brand strings resolve via `getBrand()`/`resolveBrand(org)` and skins
  are runtime-selectable classes (Phase 1-2). Product-specific values cannot bleed across
  deployments because deployments are separate (data isolation) and the resolution is
  per-request from that deployment's env + per-org data — there is no second image to drift.
- **Runtime.** Deployments are separate (data isolation). Entitlements **fail open**:
  a newly added module or sector is **OFF for existing orgs until explicitly
  enabled**, so *adding* capability never changes a running deployment's behavior.
- **Change-time (the decisive layer).** Every PR/release builds **both** products in
  CI (`check` + `build-pontis` legs, `fail-fast: false`). **Product-neutrality arch
  tests** (e.g. the brand-literal guard,
  `src/lib/product/__tests__/brand-literals.arch.test.ts`) assert the default
  (`cosmos`) face is preserved. Shared-schema changes are **additive and
  backward-compatible** (new tables/columns; no destructive change to shared ones). A
  change that breaks either product fails before it can ship.

## Feature-placement maturity ladder

Place each customer/sector-specific feature at the **lowest rung that fits**:

1. **Data / templates** — a sector template, custom-field set, or seed. (Most
   "features" are only this.)
2. **Sector-scoped behavior** — shared code that branches on the sector key.
3. **Gated module** — a first-class feature, entitlement-gated *off* for org-types
   that don't need it (nav / route / API filtered). The shared code is the same;
   only the entitlement differs. **This is the main growth lever.**
4. **Adapter** — a heavy or third-party-specific integration (A&E: BIM/Procore;
   DoD: compliance scanners) behind an interface, env-configured, so the core never
   hard-depends on it.
5. **Fork** — never. The pull toward a fork is the signal to push the difference
   down to rungs 1–4.

## Consequences

- ✅ Versions can't drift; a fix benefits every customer; one CI run proves every face.
- ✅ New customers/sectors are **additive** (profile + entitlements) and low-risk to
  existing deployments.
- ✅ A bad release can be caught on one deployment's staging before another upgrades.
- ✅ ONE image carries every product's code; the runtime `PRODUCT` env + fail-open
  entitlements select per-deployment behavior — no per-product build artifacts to drift,
  uniform supply-chain evidence for all.
- ⚠️ Discipline required: changes to shared code must stay **neutral + additive**; the
  CI matrix + arch tests + fail-open entitlements are what enforce it.

## Open / revisitable decisions

- **Gated code in the shared image (supply chain). RESOLVED (Phase 3).** There is now ONE
  image that carries every product's code; the runtime `PRODUCT` env + fail-open
  entitlements gate what each deployment runs. Build-time sector exclusion (tree-shake per
  `PRODUCT`) is explicitly **not pursued** — it would re-introduce per-product artifacts and
  defeat the one-image collapse. Uniform gov-grade signing (keyless + KMS) + the full
  SBOM/SLSA/security gates apply to the single image, so the supply-chain posture is
  identical for all deployments.
- **Upgrade cadence.** Each deployment pins a version and upgrades on its own
  schedule (gov change-control is slower than commercial). "Adjacent" means the same
  version is *available* to both, not that upgrades are simultaneous.

## References

- Profiles — `src/lib/product/profiles.ts`
- Entitlements (modules + sectors, fail-open) — `src/lib/entitlements/`
- Skins (scoped per product) — `src/lib/theme/skins.ts`
- Release (tags-only, single `cosmos-v2` image, uniform keyless+KMS signing) — `.github/workflows/release.yml`
- Runtime product resolution (`PRODUCT` env) — `src/lib/brand/index.ts`; entitlement env defaults — `src/lib/entitlements/default-env.ts`
