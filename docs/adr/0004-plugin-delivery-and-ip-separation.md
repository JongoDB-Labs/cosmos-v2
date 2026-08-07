# ADR 0004 — Plugin delivery and client-IP separation

**Status:** proposed. Amends ADR 0003, which stands on everything except how
plugins are *delivered*.
**Date:** 2026-08-07.

## Context

ADR 0003 gave us fail-closed capability bundles composed into the tree at build
time, and that part works: `OrgPluginState` is a real runtime toggle, nothing
appears until an org opts in, and plugin code stays out of the public core.

What has since become visible is the *delivery* cost. Composition happens per
**client**, producing one image per client (`cosmos-v2-<client>`), each containing the
core plus that client's plugin set.
So:

- every client rebuilds on every core release — builds are O(clients);
- a change to one generic plugin rebuilds **every** client that has it;
- two clients with identical plugin sets still get two images;
- and a plugin cannot be delivered to a client without a build.

The requirement that prompted this: *cosmos-v2 should be deployable to any
client as a core, and clients should pull the plugins they have paid for, with
authentication proving both identity and entitlement.*

## The distinction this ADR turns on

The requirement above contains **two problems that need different mechanisms**,
and conflating them is what makes the current architecture feel unavoidable.

**A. Entitlement — "a client must not *use* what they did not buy."**
Runtime data. Solved by a licence check.

**B. Confidentiality — "client A must never *see* client B's code."**
Physical separation. No runtime flag achieves it; the bytes are either on the
disk or they are not.

**Today we pay the price of (B) for plugins that only need (A).** The whiteboard,
PI planning and Foreman contain no client specifics whatsoever, yet each is
delivered by the mechanism designed to keep client IP apart.

## What the industry does

Worth stating plainly, because the dominant answer is unglamorous.

**Self-hosted commercial software: one artifact, licence-gated at runtime.**
GitLab ships EE code in every image and unlocks by licence. Grafana Enterprise is
OSS plus enterprise plugins in one binary. Elastic, Sentry and Metabase are the
same shape. The code is present on disk; the licence is a **legal** control, not
a technical one. Effectively nobody ships per-customer builds for tiered
features.

**Genuine third-party ecosystems: out-of-process, over a stable ABI.**
Terraform providers are separate binaries over gRPC. Grafana backend plugins use
`hashicorp/go-plugin`. Atlassian Connect runs the app on the vendor's own infra
and integrates over REST + iframes + JWT. The consistent lesson is that real
runtime plugin systems **never share an ORM schema in-process** — they cannot,
which is precisely why they went out-of-process.

**Module Federation** solves UI delivery only, never the data layer.

## Why "ship schema+routes in core, download only the UI" is half right

It is technically sound: it puts all three build-time couplings in the core,
which is exactly where they have to live if plugins are to be added without a
rebuild.

It fails for **client IP**, because the schema *is* the IP. A client's Prisma
fragment names their entities and workflows — the most revealing artifact in the
plugin. Shipping that to every client and withholding the buttons protects
nothing.

It is exactly right for **generic paid plugins**, where there is no secret to
keep and the only requirement is that unpaid orgs cannot switch it on.

## What actually blocks runtime plugins here

| Coupling | Why it is build-time | What would unlock it |
|---|---|---|
| **Prisma** | The client is *generated*; a model cannot be added at runtime | Plugin owns its own schema, migrates at enable time, and does **not** use core's generated client (raw SQL / Kysely) |
| **Next routes** | The route manifest is built, not discovered | One catch-all `/api/plugins/[slug]/[...path]` dispatching to registered handlers |
| **npm deps** | `plugin.json` deps are merged into `package.json` | Plugin ships pre-bundled with its own dependencies |

Each is solvable. Together they are a real plugin ABI — a project, not a
refactor — and worth doing only for a **third-party** ecosystem, not for plugins
we write ourselves.

## Decision

Split delivery by **whether the plugin is client IP**, not by whether it is a
plugin.

### Tier 1 — Generic plugins ship in the neutral core, gated by a signed licence

Whiteboard, PI Planning, the delivery console, and anything else with no
client specifics move
into `cosmos-v2` itself. They stay fail-closed and per-org toggleable exactly as
today.

The enforcement path already exists (`OrgPluginState` + `isPluginEnabled`). What
it lacks is an **unforgeable input**: today an operator can flip the row and
enable anything. Tier 1 adds a licence:

- an **entitlement token** — org id, plugin slugs, issue/expiry, plan tier —
  signed with the vendor's private key;
- verified **offline**, with the public key baked into the image. No phone-home:
  this platform runs air-gapped, and a licence that needs the internet is a
  licence that fails in the deployments that matter most;
- checked at **enable time and at boot**, so a revoked or expired licence
  disables cleanly instead of failing mid-request;
- installed as a file or pasted in Settings, never fetched as the only path.

Consequences: the build matrix collapses to *one* image for everyone on generic
plugins. A plugin change ships once. And the code is on disk for every client —
accepted deliberately, exactly as GitLab and Grafana accept it, because for
generic functionality the licence is the control.

### Tier 2 — Client-specific plugins stay build-time composed

Every bespoke, client-specific plugin keeps today's mechanism, unchanged.
This is the right tool for (B), and the cost people fear does not apply: each
has exactly **one** consumer, so N stays at 1 per client forever. Bespoke work
does not fan out.

### Tier 3 — A runtime plugin ABI, only if we want outsiders building on cosmos

Not now, and explicitly not for our own plugins. If it is ever built, the shape
is the industry one: plugin owns its schema and migrates at enable time, exposes
one dispatch endpoint, ships its own dependencies, and delivers UI by federation
— with a signed bundle that can be **sideloaded**, because a registry pull
cannot be the only path in an air-gapped install.

## Consequences

- The whiteboard is the natural first Tier 1 case: brand new, entirely generic,
  and not yet in any client's image. It should move before it ships anywhere.
- Tier 1 requires a key-management story — where the signing key lives, how a
  licence is issued, how revocation is communicated to an offline instance
  (short expiry + reissue is the usual answer).
- Repeating the client name as a **tag** suffix on an already client-specific
  **repo** (`cosmos-v2-<client>:2.275.0-<client>`) is redundant, and it is what
  caused a host's deploy scripts to silently target the wrong repository. Tier 2
  should drop it.
- Generic plugin code becomes visible in the public core. That is a **business**
  decision, not a technical one, and it is the single question this ADR needs
  answered before Tier 1 proceeds.
- ADR 0003's isolation contract, fail-closed default, registry invariants and
  arch tests are unchanged and still apply in all three tiers.
