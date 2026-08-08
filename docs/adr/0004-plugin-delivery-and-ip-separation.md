# ADR 0004 — Plugin delivery and client-IP separation

**Status:** accepted (2026-08-07). Amends ADR 0003, which stands on everything
except how plugins are *delivered*.
**Date:** 2026-08-07.

## Decisions taken

1. **Tier 1 is approved.** Generic plugin code may live in the neutral core.
   The concern is each client's own IP, not the generic functionality around it.
2. **Client IP is the bespoke client verticals**, which stay Tier 2 and keep
   build-time composition. One current plugin is a *jointly agreed* buildout
   with an external partner rather than a single client's confidential work —
   that one needs its own answer (see "Open: the joint buildout" below) and must
   not be filed under either tier by default.
3. **This is anticipatory.** There is no paid plugin today. That shapes the
   build: the mechanism ships first and enforcement is opt-in per plugin, so
   nothing already running changes.

## Two corrections to the record

Both were asserted earlier in weaker form and are wrong as stated; the facts
below were checked against the repository and GitHub rather than assumed.

**The core is PUBLIC and licensed AGPL-3.0.** An earlier note in this workstream
said it had no licence file at all. It does — `LICENSE` on `main`, GNU AGPL v3.

That materially changes Tier 1, and not in the comfortable direction. **AGPL-3.0
and a licence-gated paid feature are fundamentally incompatible.** The AGPL
grants every recipient the right to run, study, modify and redistribute. A
licence check shipped in AGPL code may therefore be *lawfully removed* by anyone
who receives it — §13 obliges them to offer their modified source when they run
it over a network, which is real protection against a SaaS competitor, but it is
no protection at all for an entitlement gate. Shipping paid plugin source under
AGPL would mean publishing the feature and the right to unlock it in the same
commit. AGPL is also routinely excluded outright by enterprise and government
procurement policy, which is its own reason to revisit it for a platform sold
into exactly those buyers.

**There was no asymmetric signing primitive anywhere in the codebase.** The
existing crypto is symmetric — a sealed-credential vault and webhook HMAC — and
image signing is cosign *keyless*. None can back a licence the customer must not
be able to mint: an HMAC secret has to ship inside the image to be verified
there, and a secret on the customer's disk is a secret the customer can sign
with. Tier 1 therefore introduces the first long-lived private key this project
has to own and protect. That is a real operational commitment, not a footnote.

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

## Relicensing — required before Tier 1 ships anything paid

Recommendation: **move the core off AGPL-3.0 to a source-available licence that
permits a licence gate**, and do it before the first paid plugin lands.

- **Elastic License 2.0 (ELv2)** is the closest fit and the recommendation. It
  permits use, modification and redistribution, and prohibits exactly two
  things: providing the software to third parties as a managed service, and
  **circumventing the licence-key functionality**. That second clause is the
  legal half of the technical control built here — without it, the gate is a
  speed bump; with it, removing the gate is a licence violation. Elastic, and
  others since, use it for precisely this shape of product.
- **BSL 1.1** is the alternative if an eventual open-source conversion matters:
  source-available now, converting to Apache-2.0 on a fixed change date.
- Staying AGPL and keeping every paid plugin in Tier 2 is coherent too — it just
  means giving up the single-image benefit that motivated Tier 1.

Feasibility: copyright sits with a small, known set of contributors, so a
relicence is practical, but it needs each of their agreement in writing before
the change lands. Dependencies must also be re-checked — anything inbound under
a copyleft licence constrains what the combined work may be distributed under.
This is a legal step, not an engineering one; treat the above as the shape of
the decision, not as advice.

## Distribution of a paid plugin

For Tier 1 there is nothing to distribute: the code is already in the image and
the licence unlocks it. Distribution only matters for anything sideloaded later
(Tier 3), and for the licence file itself.

Recommended, and cheap: a static site plus a small edge function in front of
private object storage, issuing short-lived signed URLs against a licence token.
Free tiers cover this comfortably at the volumes in question. Two constraints
that must survive the choice: **artifacts must remain sideloadable** — an
air-gapped install cannot pull from anything, so a registry can never be the
only path — and **the edge must never hold the signing key**. Licences are
minted offline by the vendor and merely *served* by the edge; a signing key on
someone else's compute is the one mistake that makes all of this decorative.

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

## Built (2.276.0)

The entitlement mechanism exists, ahead of any decision about placement:
`src/lib/licensing/` verifies an Ed25519-signed token entirely offline, and
`scripts/licensing/license.mjs` generates the keypair and issues licences with
no dependency on a built app or a database. Enforcement is opt-in per plugin via
`requiresEntitlement` on the manifest, checked both at enable time and on the
read path — so a licence that later expires closes the plugin cleanly instead of
running forever on a stale row. No plugin declares it yet, so nothing in the
field changed.

## Open: the joint buildout

One plugin is a jointly agreed development with an external partner rather than
either a generic capability or a single client's confidential work. Tier 1 would
publish it; Tier 2 keeps it private but treats a partner as a client. Neither is
obviously right, and the answer is contractual — who owns the output, and what
each side may do with it — so it is recorded here as open rather than guessed.
Until it is settled, it stays where it is: Tier 2, build-time composed.
