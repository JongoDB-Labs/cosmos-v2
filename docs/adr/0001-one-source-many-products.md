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

1. **One repo, one trunk (`main`), one version.** A `vX.Y.Z` tag builds *every*
   product image (`cosmos-v2`, `pontis`, …) from the same commit via the `PRODUCT`
   build matrix (`.github/workflows/release.yml`). Products are *definitionally* the
   same version — they cannot drift, because there is no second codebase.
2. **A product = a profile** (`src/lib/product/profiles.ts`): brand, skin, default
   module/sector entitlements, tenant class, signing mode. **Adding a customer/face
   = a new profile + one matrix row**, not a fork.
3. **Per-deployment + per-org scoping** via **entitlements** (modules + sectors,
   fail-open — `src/lib/entitlements/`) and **sector built-ins** (templates /
   work-item types seeded as global `orgId: null` rows). A customer sees only what
   their entitlements enable.
4. **Separate deployments per customer** (separate DB/infra), each built as its
   product, all drawing from one shared version stream.

## Isolation guarantees (no harmful cross-pollination)

Three layers ensure a change made through one customer's lens cannot silently harm
another's deployment:

- **Build-time.** `PRODUCT` selects exactly one profile. Product-specific values
  cannot bleed into another product's image — the skin is scoped to
  `:root.<product>`, brand strings resolve via `getBrand()`, and defaults come from
  the selected profile only.
- **Runtime.** Deployments are separate (data isolation). Entitlements **fail open**:
  a newly added module or sector is **OFF for existing orgs until explicitly
  enabled**, so *adding* capability never changes a running deployment's behavior.
- **Change-time (the decisive layer).** Every PR/release builds **both** products in
  CI (matrix, `fail-fast: false`). **Product-neutrality arch tests** (e.g. the
  brand-literal guard, `src/lib/product/__tests__/brand-literals.arch.test.ts`)
  assert the default (`cosmos`) face is preserved. Shared-schema changes are
  **additive and backward-compatible** (new tables/columns; no destructive change to
  shared ones). A change that breaks either product fails before it can ship.

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
- ⚠️ The shared image carries every product's code, even gated-off (see open decision).
- ⚠️ Discipline required: changes to shared code must stay **neutral + additive**; the
  CI matrix + arch tests + fail-open entitlements are what enforce it.

## Open / revisitable decisions

- **Gated code in the gov build (supply chain).** The gov (DoD) image carries A&E
  code it never runs. **Decision: accept (gated-but-present) for now**; design for
  **build-time sector exclusion** (tree-shake per `PRODUCT`) if/when an in-boundary
  supply-chain review requires it.
- **Upgrade cadence.** Each deployment pins a version and upgrades on its own
  schedule (gov change-control is slower than commercial). "Adjacent" means the same
  version is *available* to both, not that upgrades are simultaneous.

## References

- Profiles — `src/lib/product/profiles.ts`
- Entitlements (modules + sectors, fail-open) — `src/lib/entitlements/`
- Skins (scoped per product) — `src/lib/theme/skins.ts`
- Release (tags-only, `PRODUCT` matrix, per-product signing) — `.github/workflows/release.yml`
