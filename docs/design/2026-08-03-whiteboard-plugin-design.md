# Whiteboard plugin — design

**Status:** design, not yet built. Companion to
`2026-08-03-pi-planning-excalidraw-baseline.md`.
**Date:** 2026-08-03.

## Why this document exists

The intent was that a prior architecture/roadmap doc described how Excalidraw
should be deployed here — "separate backends per org or instance". **No such
document exists.** Searched: every cosmos repo and worktree, every repo under
`~/jondev`, GitHub code search and issues across the JongoDB-Labs org, the ADRs,
`docs/roadmap/`, and the conversation archive. The only prior Excalidraw material
is the PI-planning baseline written the same day, and one aspirational phrase in
the PI-planning design ("the established virtual-whiteboard PI planning
experience").

The recollection is almost certainly of **Nextcloud's Whiteboard app**, a copy of
which sits in `~/jondev/sp-dev/sp-shared-shelf-bundle/nextcloud/`. That app is
Excalidraw plus a **separate Node websocket backend**, and it ships precisely the
curated templates described: Sticky notes, Kanban board, Mind map, Business model
canvas, Timeline, Impact/effort, Flowchart, Venn diagram, Brainstorming, Meeting
agenda. It is a good reference. It is not a cosmos design, so this is one.

## Scope

A **general-purpose whiteboard**, as its own plugin: a person opens their own
board, starts from a curated or self-made template, and saves and shares it.

**Packaging: its own PRIVATE plugin repo** (`cosmos-plugin-whiteboard`), matching
every other plugin — all `cosmos-plugin-*` repos are private; only `cosmos-v2` is
public. It composes in at build time and appears in Settings → Plugins as its own
toggle. Fail-closed, like every plugin: no `OrgPluginState` row means off.

It is *adjacent to* — not the same as — PI planning's board, and depends on
nothing from it. Both render Excalidraw; they differ in what is authoritative:

| | PI Planning board | Whiteboard |
|---|---|---|
| Source of truth | audited Postgres rows; the canvas is a **projection** | the **scene is the document** |
| Structured objects | cards/objectives/risks/votes, written through audited APIs | none |
| Freeform | durable, persisted by cosmos | the whole product |

Those are not in conflict. The PI baseline's option (c) already splits "structured
objects stay in Postgres" from "freeform scene is durable, persisted by cosmos".
**The whiteboard is the pure-freeform half of that same substrate**, which is why
the whiteboard should follow the same PATTERNS — not depend on the same running
services. Borrow the shapes that are already proven here (ticket-derived rooms,
audited persistence, object storage for scene bytes); share no process.

## Deployment: the backend is addressable per org

This is the part the recollection was reaching for, and it needs stating
precisely, because "separate backends per org" can mean three different things.

Today: cosmos ships as a **per-client composed image** (the private image builder
composes one per customer), and the PI-planning sidecar rides inside that
composition. So *per-instance separation already exists* — one customer's sidecar
is not another's; they are different deployments entirely. Within one instance,
orgs share a sidecar and are separated by room key.

That is adequate for most tenants and inadequate for some: a customer with CUI or
a contractual isolation requirement will want their org's realtime traffic in its
own process, not merely its own room.

**The design decision: the client never learns its backend URL from config.** The
ticket-minting endpoint returns it, per org:

```
POST /api/v1/orgs/:orgId/plugins/whiteboard/boards/:boardId/realtime-ticket
  → { url: "wss://…", token: "<signed ticket>", room: "<derived>" }
```

So the backend can be:

- the **instance sidecar** (default — one process, rooms namespaced by org), or
- a **dedicated process for one org** (set a per-org override; nothing else changes), or
- **absent** (503 → the board still opens and still saves; only live co-editing is off).

Splitting an org onto its own backend becomes configuration, not a code change.
Hard-coding a single `NEXT_PUBLIC_WHITEBOARD_WS_URL` would foreclose that, and is
also forbidden: `NEXT_PUBLIC_*` is inlined into the public bundle.

### Its own sidecar, not PI planning's

**Decided 2026-08-03: the whiteboard runs its own realtime service.** An earlier
draft of this document argued for reusing the PI-planning sidecar under a second
room namespace, on the grounds that a second realtime path is a second place to
get isolation wrong. That is overruled, and for a good reason: the whiteboard is
**independent functionality**, toggled on by itself, and a plugin that cannot be
enabled without another plugin's service running is not independent. Coupling the
two would also mean PI planning's sidecar becomes a hard dependency of a product
that has nothing to do with PI planning.

The isolation objection is answered by **sharing the pattern, not the process**.
The whiteboard sidecar is built to the same contract, which is short enough to
restate and verify in its own tests:

- no database connection — a compromise there reads no board data;
- no session cookies — it cannot act as a user against the app;
- **its own secret**, used only to VERIFY tickets cosmos already authorised;
- refuses to boot without that secret (down is obvious, open is not);
- the room name is **DERIVED from the signed claims** and compared against the
  room the client asked for, so a client cannot name its own room.

That last line is the whole of multi-tenant isolation, and it is ~5 lines of
code. Copying it deliberately, with its own tests, is cheaper than a shared
service that welds two plugins together — and the parity is worth asserting: PI
planning already keeps a `realtime-token-parity` test for exactly this reason.

Room key: `whiteboard:${orgId}:${boardId}`. Separate secret, separate process,
separate failure domain.

## Persistence

The sidecar stays dumb. Cosmos persists, through audited endpoints, using the
storage abstraction that already exists (`src/lib/storage/` — `adapter-local` and
`adapter-s3`, with the `storageKey` convention used by `Document` and friends).

- **Scene bytes → object storage**, not Postgres. A busy board's Yjs state grows
  well past what belongs in a row, and there is already a MinIO container and an
  adapter for exactly this.
- **Metadata → Postgres**, plugin-owned and org-scoped (`WhiteboardBoard`:
  org, optional project, owner, title, visibility, `storageKey`, timestamps,
  `archivedAt` — archive, never delete, matching the PI-planning teams rule).
- **Autosave is debounced** from the client's `onChange`, and the endpoint is the
  only writer. A snapshot, not a revision log, unless version history is asked
  for — say so explicitly rather than leaving it ambiguous.

**Never let the sidecar hold the only copy.** Its documents are ephemeral by
design; a board that exists only in a room dies when the room empties.

## Templates

Two kinds, one model (`WhiteboardTemplate`):

- **Curated** — seeded on first enable, `isSystem`, org-visible, not editable.
  Seed the Nextcloud set; it is a genuinely good starting list.
- **Authored** — an org's own, or a person's own. "Save this board as a template."

Creating from a template is a **copy of the scene**, never a reference. A template
that keeps editing itself after ten boards derive from it is a bug wearing a
feature's clothes.

## Sharing — where the access-control discipline goes

This is the part that will be got wrong if it is written casually, and this
session has three worked examples of exactly how.

A board has an owner and a visibility. The permitted shapes:

- **private** — owner only
- **shared** — explicit grants to named users, teams, or a project
- **org** — anyone in the org who holds the read bit

**No anonymous link sharing in the first cut.** This platform is CUI-blind and
multi-tenant; a URL that grants access without an identity is a decision to make
deliberately and separately, not to inherit from Excalidraw's hosted product.

Non-negotiables, drawn from what went wrong elsewhere in this codebase:

1. **One helper, forwarded to by every consumer.** Not a pure rule called from
   whichever surface was open — that is precisely how a team-scoped board stayed
   readable by URL (2.266.1), how ~30 agent tools read past project scoping
   (2.265.3), and how the AI time tool returned the whole org (2.265.1).
2. **An arch test asserting the rule**, matching a CALL (`name\s*\(`) and not the
   bare name, or it matches the import line and catches nothing. Exemptions by
   name, with reasons.
3. **Detail surfaces answer NotFound, never Forbidden** — a 403 confirms the board
   exists.
4. **The agent is a second surface.** If Cosmo can list or read boards, its
   executor needs the same gate; `assertPermission` alone is not scope.
5. **The realtime ticket is an access decision.** Minting one must run the same
   check as opening the board — it is the one endpoint that hands out a
   capability, and it is the easiest to forget.

## Open questions

1. **Version history** — snapshot-only, or revisions? Affects storage cost and
   the "restore" affordance. Default to snapshot-only until asked.
2. **Export** — PNG/SVG export is client-side in Excalidraw and free; a
   server-side render (for reports) is not, and needs a headless browser. Out of
   scope unless wanted.
3. **Does a whiteboard belong to a project?** Optional `projectId` costs nothing
   now and, if set, should inherit project visibility — which means it must go
   through `requireProjectRead` too, i.e. two axes again.
4. **Embedding a whiteboard in a work item or meeting.** Attractive, and the
   reason to keep `WhiteboardBoard` addressable rather than nesting it under a
   project from the start.
