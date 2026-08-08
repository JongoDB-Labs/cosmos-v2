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

### Tier 1 — Generic plugins ship in ONE IMAGE, gated by a signed licence

**Amended.** This tier originally said generic plugins move *into the public
`cosmos-v2` repo*. Under AGPL that is self-defeating, and dual licensing does not
rescue it: anything published in the public repo is published under AGPL to the
world, so forking it and deleting the gate is lawful. The gate would protect
nothing against the public.

What survives — and it is the part that motivated the tier — is separating **one
image** from **one repo**:

| | Where it lives | Who receives it | Under what licence |
|---|---|---|---|
| Core | public repo | everyone | AGPL-3.0 |
| Core | build output | customers | commercial |
| Generic paid plugins | **private** repos | customers only | commercial |
| Client-specific plugins | private repos | that client only | commercial |

Whiteboard, PI Planning, the delivery console and anything else with no client
specifics stay in private repos and are composed into **one image for every
customer**, rather than one image per client. They stay fail-closed and per-org
toggleable exactly as today. The build matrix still collapses; a plugin change
still ships once.

**Consequence that must be enforced: any PUBLIC artifact must be AGPL-clean.**
The image is published to a registry and may be public. A public image carrying
proprietary plugins combined with an AGPL core invites precisely the claim this
tier exists to avoid — a recipient reads `LICENSE`, concludes AGPL, and asks for
the plugin source. Anything carrying proprietary plugins is private and
commercial-only. That is a registry and pipeline change, cheap now and expensive
later.

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

## Licensing — keep AGPL-3.0, and dual-license

**This supersedes an earlier recommendation in this document's history to
relicense to ELv2.** That was the right answer to "which single licence should
the core carry" and the wrong answer to the question actually being asked, which
is "how do we keep AGPL and still ship closed plugins". Both are available.
Nothing needs to be relicensed.

**AGPL binds licensees, not the licensor.** Copyright in the core sits with a
small, known set of contributors, all of whom have now agreed in writing, with
legal sign-off. A copyright owner may license the same work to different
recipients under different terms, simultaneously — that is not a loophole, it is
the oldest commercial open-source model there is (MySQL, Qt, Sidekiq, iText).

- **The public** receives the core under **AGPL-3.0**. Unchanged. §13 keeps its
  teeth against a SaaS competitor, which is stronger deterrence than ELv2's
  managed-service clause, because AGPL is the licence competitors' counsel
  already refuse to go near.
- **Paying customers** receive the same core under a **commercial licence**
  carrying no copyleft, expressly permitting combination with proprietary
  plugins and prohibiting circumvention of the licence-key check.

A customer holding the commercial licence is not an AGPL recipient, so nothing
obliges anyone to publish the plugins. Combining our own core with our own
plugin is not a licensing event at all — we own both sides. This also disposes
of the procurement objection rather than working around it: buyers who reject
AGPL on policy sign the commercial licence, which is the artifact their
procurement wanted anyway.

**An AGPL §7 additional permission** (a plugin/linking exception) is the
alternative shape, and composes with the above. It would let *anyone* write
proprietary plugins against the documented interface — right for growing an
ecosystem, wrong for protecting revenue, and it does nothing for the gate. It
would also need careful drafting, because today's plugins share the generated
Prisma client in-process, which is about as far from arm's-length as coupling
gets.

**Inbound dependencies: checked.** 781 production packages; no strong copyleft,
so nothing blocks dual licensing. One finding, and it is real: `@nangohq/node`
is **Elastic License 2.0** — the published package ships no LICENSE file, its
`license` field says only "SEE LICENSE IN LICENSE FILE IN GIT REPOSITORY", and
GitHub reports the source repo as NOASSERTION, which is why nothing had ever
flagged it. ELv2 imposes usage restrictions and AGPL-3.0 §7 forbids imposing
further restrictions on recipients, so it conflicts with conveying the combined
work under AGPL. The public *repo* is fine; the exposure is the distributed
*image*. Recorded as accepted risk pending legal review, and CI now gates
dependency licences so the next one is caught on arrival rather than years later.

This is a legal step, not an engineering one; treat the above as the shape of the
decision, not as advice.

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
- ~~Generic plugin code becomes visible in the public core.~~ **Resolved, in the
  opposite direction to how it was framed.** Generic plugin code stays private;
  what becomes shared is the *image*, not the *repository*. Visibility was never
  the thing worth trading — the build matrix was.
- **A CLA or copyright assignment must be in place before the first outside
  contribution.** This is what kills dual-licensed projects later: once an
  external contributor holds copyright in part of the core and has not assigned
  it, the whole work can no longer be licensed commercially. Costless today, when
  the contributor set is two people who have both agreed; unfixable in
  retrospect.
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
