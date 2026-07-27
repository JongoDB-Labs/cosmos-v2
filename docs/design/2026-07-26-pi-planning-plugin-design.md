# PI Planning plugin — design

- **Status:** Approved (design); implementation not started
- **Date:** 2026-07-26
- **Slug:** `pi-planning` — private plugin repo `cosmos-plugin-pi-planning`
- **Related:** ADR 0003 (plugin system), `AGENTS.md`

## 1. Context

A realtime, multi-user collaborative workspace for running SAFe 6.0 PI Planning
events, delivered as an ADR-0003 plugin rather than core edits. Target is parity
with the established virtual-whiteboard PI planning experience, plus the things a
real PM substrate makes possible that a generic whiteboard cannot: computed
capacity, structured business value, typed dependencies with a cycle guard,
audit trail, and predictability metrics.

The plugin is **product- and tenant-agnostic**. Any org may enable it and run
events spanning one or more of its projects, using the teams and members within
those projects.

### Constraints verified against the tree (not assumed)

| Claim | Evidence |
|---|---|
| Realtime is SSE-only | `src/app/api/v1/orgs/[orgId]/events/route.ts` |
| Cross-instance fan-out is Postgres `LISTEN/NOTIFY`, 6 KB cap, `__overflow` downgrade | `src/lib/realtime/adapter-pg.ts:6,107` |
| Topic vocabulary is closed (`org:`/`user:`/`channel:`) | `src/lib/realtime/topics.ts` |
| Presence is per-instance and user-scoped | `src/lib/realtime/presence.ts:16-19` |
| `BoardType.PROGRAM` renders a dashboard rollup, not a team grid | `board-renderer.tsx:75-78` |
| No first-class Team model exists | `prisma/schema.prisma` (only `ProgramBranch`) |
| PI→sprint hierarchy already exists | `Interval.parentId` + `IntervalKind.PROGRAM_INCREMENT` |
| Only `Organization` and `Project` are marker-exposed for back-relations | `prisma/schema.prisma:210,641` |

**A gap not previously recorded:** the plugin SDK cannot ship npm dependencies.
`scripts/plugins/sync.mjs` composes `overlay/**`, the Prisma fragment,
back-relations, and the two registry files — it never merges `package.json`, and
an overlay cannot contain one (the collision guard at `sync.mjs:121` throws on
tracked core paths). Evidence this is a real gap rather than an oversight: the
Foreman extraction left `@anthropic-ai/claude-agent-sdk` and `tsx` in the public
core's `package.json`.

## 2. Decisions

| # | Decision |
|---|---|
| 1 | Target the full parity tier; 6+ week horizon |
| 2 | Size for >150 concurrent users (multi-ART / solution train) |
| 3 | Self-hosted Yjs sidecar; extend `sync.mjs` with plugin dependency merging |
| 4 | Deploy to the production instance; plugin stays company-agnostic |
| 5 | First-class team entity, org-scoped, optionally linked to a project |
| 6 | Fully remote / distributed attendance |
| 7 | New **private** plugin repo, matching the established pattern |
| 8 | No external SaaS for realtime, auth, or storage (airgap posture) |

## 3. Architecture — three layers

Each layer has a different consistency model. The load-bearing rule: **layer 2 is
a projection, never a source of truth.** Anything that must survive the event is
written through layer 0.

### Layer 0 — DB-canonical domain

Features, dependencies, objectives, business value, risks, votes, teams. Real
core entities where they exist; additive plugin tables where they don't. Audited
via `logAudit`.

- *Customization:* per-org `PluginConfigField` — iteration count, IP-iteration
  on/off, BV scale, whether Business Owners alone may set BV.
- *Tailorability:* the card taxonomy is **data, not code**. `PiPlanningCardType`
  is seeded with Feature/Enabler, Significant Dependency, and Milestone/Event, so
  an org can add its own type without a deploy. Same for ROAM states and vote scales.
- *Scalability:* every table is `orgId`-scoped and indexed on
  `(eventId, teamId, intervalId)` — the program board is one indexed query, not N×M.

### Layer 1 — coarse domain events

Existing bus + SSE. Discrete events: feature moved, dependency added, objective
committed, risk ROAMed, agenda advanced.

- *Customization:* per-org toggles for which domain events broadcast.
- *Tailorability:* the agenda is a row-per-phase table, so an RTE can re-time,
  reorder, or drop phases. The conditional rework gate is a declarative
  `entryCondition` (`avgConfidence < 3`), not an `if` statement.
- *Scalability:* **this is the layer at risk.** The core SSE route subscribes
  every connection to the whole `org:` topic (`events/route.ts:29-33`), so 150
  users means every event fans out to every connection. Mitigation: event-type
  filtering at the subscription, and ref-only payloads (`{id, type}`) that force a
  client refetch — sidestepping the 6 KB cap by design rather than by luck.

### Layer 2 — CRDT canvas

Yjs over the sidecar: cursors, drag streams, sticky text, shapes. Never touches
`NOTIFY`.

- *Customization:* board templates — the standard frame set (Program Board,
  Teamboards, ROAM, Retro, Scrum-of-Scrums) is seedable and instantiated per event.
- *Tailorability:* **the lock primitive.** Scaffolding objects (grid, headers,
  swimlanes) carry `locked` + `structural`; only facilitation roles may unlock.
  Breakout chaos cannot destroy the board structure.
- *Scalability:* one Yjs doc per **board**, never per event. A 12-team ART is ~16
  docs, so cursor traffic shards naturally and breakouts scale for free. Cursors
  ride Yjs *awareness* — ephemeral, never persisted. The sidecar evicts empty rooms.

## 4. Data model

### The federation problem

An event spans N projects, but `Interval` is project-scoped
(`@@unique([projectId, number])`), so there is no single PI row.

- `PiPlanningEvent` (org-scoped root) → `PiPlanningEventProject`
  (event × project × that project's `PROGRAM_INCREMENT` interval).
- `PiPlanningIteration` gives the board **one canonical column set** (index, name,
  dates, `isInnovationPlanning`); `PiPlanningIterationInterval` maps each column to
  the correct child sprint `Interval` per project. Capacity and load resolve per
  (team, column) through real core intervals.

### Reused wholesale

`Interval` / `IntervalCapacity`; `WorkItem` (`workCategory`, `storyPoints`,
`intervalId`, `parentId`); `WorkItemLink` + `src/lib/work-items/dependency-graph.ts`
for dependency edges and the cycle guard; `Objective` / `KeyResult`; `Risk`;
`WorkRole` / `OrgMemberWorkRole` for SAFe roles; `Comment` / `Activity` /
`Reference`; `PmLink`; `logAudit`.

### Extended, not replaced

- `PiPlanningObjective` wraps a core `Objective` with `commitment`
  (COMMITTED/UNCOMMITTED), `plannedBv`, `actualBv`, `bvSetById/At`. Because the
  objective *is* a core `Objective`, one-click objective→OKR needs no conversion.
- `PiPlanningRisk` wraps a core `Risk` with `roamState` and owner (ROAM is not in
  core's `RiskStatus`).

### New tables

All `PiPlanning*`-prefixed, `orgId String @db.Uuid`, cascading from `Organization`,
snake_case `@@map`/`@map`:

`Event`, `EventProject`, `Iteration`, `IterationInterval`, `Team` (org-level, so it
survives across PIs), `EventTeam`, `TeamMember`, `Board`, `CardType`, `Card`,
`Connector`, `Doc`, `DocUpdate`, `AgendaPhase`, `BreakoutRoom`, `Vote`,
`VoteBallot`, `BoardPresence`.

### A constraint that shapes all of it

Only `Organization` and `Project` are marker-exposed. References to `WorkItem`,
`Objective`, `Risk`, `Interval`, and `User` must therefore be **bare indexed UUIDs
with no foreign key** — exactly how core's own `PmLink` and `Reference` handle
polymorphic targets. Consequence: deleting a work item leaves a dangling card that
resolves to nothing at render, like a stale `Reference`. A reconcile pass handles
cleanup; we do not pretend the FK exists.

## 5. Realtime, persistence, recovery

**Sidecar:** Hocuspocus (MIT, self-hosted), a compose service beside the app,
behind the existing reverse proxy.

**Auth — minted room tokens.** Core sessions are opaque DB ids in a cookie
(`src/lib/auth/session.ts:58`), so there is nothing for the sidecar to verify and
no session store to replicate. A plugin endpoint runs the full guard chain
(`getAuthContext` → `requirePermission` → `requirePluginEnabled`) and returns a
5-minute HMAC-signed token carrying `{userId, boardId, orgId, caps}`.
`onAuthenticate` verifies the signature — no DB round-trip per connection, and
RBAC plus fail-closed enablement are enforced in exactly one place. The shared
secret is runtime env on both services: never a `PluginConfigField`, never
`NEXT_PUBLIC_*`, never baked into an image.

**Sharding:** one Yjs doc per board. Awareness is per-doc, so a team in breakout
exchanges cursor traffic only within its own room.

**The binding constraint.** Cursor fan-out is O(N²) in room size. Worst case is
Final Plan Review with all users on the program board. At a naive 30 Hz and 150
users that is ~675k messages/sec. Mitigations in order of effect: throttle
awareness to 10 Hz; viewport-cull so updates go only to peers whose viewport
intersects; cap rendered cursors with an overflow count. Awareness is never
persisted.

**Persistence.** Dragging streams through *awareness*; only the drop commits a
document update — so the persisted update rate is human-scale, not frame-scale.
Every doc update appends to `PiPlanningDocUpdate`; a debounced snapshot lands in
`PiPlanningDoc.state`; a compaction pass merges and truncates. Clients keep
`y-indexeddb` locally, so a client that loses connectivity buffers edits and merges
on reconnect.

**Dual authority, one rule: the DB wins for semantics, Yjs wins for pixels.**
Which cell a feature occupies, which work item it binds to, whether it is locked —
canonical in Postgres, written through a plugin API that audits and emits the
coarse event. Free-form position and sticky text live in the doc. On load,
disagreement is resolved in the DB's favour and the doc is corrected.

**Degradation is the P0 guarantee.** Sidecar unreachable → banner, cursors and
live text disabled, everything still editable through layer 0 forms with layer 1
refetch. The event can run to completion with the sidecar dead.

### Recovery matrix

| Failure | Mechanism | Loss |
|---|---|---|
| Page reload | Refetch DB + load doc from sidecar | None |
| Sidecar restart | Reload snapshot, replay update tail | Bounded by append cadence |
| App replica restart | Canvas unaffected; SSE reconnects | None |
| Client network drop | `y-indexeddb` buffers, merges on reconnect | None |

## 6. Surface

One manifest module, group `pi-planning`, three static nav leaves. Deep pages hang
off event ids and are not nav entries.

| Leaf | href | `anyOf` (core bits only) |
|---|---|---|
| Events | `/pi-planning` | `PROJECT_READ` |
| Teams & Roles | `/pi-planning/teams` | `PROJECT_MANAGE` |
| Facilitate | `/pi-planning/facilitate` | `SPRINT_UPDATE` |

Permission bits gate *access*; `WorkRole` assignment gates *authority* — only a
Business Owner sets BV, only the RTE advances the agenda. Plugins do not mint
permission bits.

## 7. Slices

| # | Slice | Demo |
|---|---|---|
| 0 | Repo + composition + dependency-merge core PR | Nav appears when enabled, 404s when off; arch green neutral *and* composed |
| 1 | Events, projects, iterations, teams, SAFe roles | Stand up an ART end to end |
| 2 | Program board, layer 0 only | Team×iteration grid on real work items; capacity/load computed; drag→DB→audit; two browsers in sync via SSE |
| 3 | Dependencies + milestone swimlane | Connector → real `WorkItemLink`; cycle guard fires; cross-team edges highlighted |
| 4 | PI objectives + BV, risks + ROAM, confidence vote | **The event is runnable** |
| 5 | CRDT canvas — sidecar, tokens, cursors, stickies, lock | Multi-cursor, concurrent text, structure locked |
| 6 | Breakout boards + rooms, agenda/timer/presentation | Facilitator walks the two-day flow; rework gate fires |
| 7 | Parity finish — templates, dot-vote/estimation, private mode, comments, export, a11y | Parity checklist |
| 8 | Differentiators — auto dependency detection, predictability metrics, objective→OKR, cross-PI carry-forward, AI tools | — |

**Sequencing principle:** the event becomes runnable at slice 4, and the canvas is
purely additive after it. If the canvas work slips, the event still runs — with
forms and a live-updating grid instead of cursors. This ordering also forces the
degradation path to be shipped, demoed code rather than an untested fallback.

Every slice verifies both ways: neutral core after `sync.mjs --clean`
(`tsc --noEmit`, `npm test`, `npm run test:arch`, `npm run build`) and composed
after `sync.mjs` + `prisma generate` (adding `prisma validate`). The additive
migration is generated offline with
`prisma migrate diff --from-schema <old> --to-schema <composed> --script` — never
`migrate dev` — and tested with `migrate deploy` against a fresh database.

## 8. Deploy

Four repos move in order: **core** (dependency merging + isolation-guard fix) →
**assembly** (checkout step, token scope, dispatch filter) → **plugin repo** →
**host deploy scripts**.

The sidecar image follows the existing `-migrate` precedent: assembly already
builds a second image per instance because the slim runtime lacks the Prisma CLI.
The sync sidecar gets the same treatment, built from the composed tree so it picks
up `yjs` and `@hocuspocus/server` from the merged dependencies. No new build
pattern is invented.

Two host-side touches: the app-only deploy script recreates `cosmos reverse-proxy`
today — the sync service joins that line (a small edit to the vaulted deploy
scripts, re-installed via their `install.sh`); and the reverse proxy needs a
WebSocket route to the sidecar.

Enablement stays per-org via Settings → Plugins, fail-closed.

## 9. Rehearsal

In increasing realism: a synthetic harness driving 150+ headless websocket clients
against the real sidecar (ships *with* slice 5, not after it) → a kill-the-sidecar
drill proving the event continues on layers 0+1 → reconnect and reload drills → a
full dress rehearsal with real participants on the real instance.

## 10. Risks

1. **150 cursors in one room during Final Plan Review.** Top technical risk. The
   load harness ships with slice 5 so the number is measured in week ~4, not
   discovered during the event.
2. **Dual authority (DB vs Yjs).** Top correctness risk and the most likely source
   of a data-loss bug. Gets a dedicated adversarial review before the event.
3. **Full parity tier in six weeks is aggressive.** Slices 7–8 are compressible;
   slices 0–6 are not.
4. **The autonomous delivery daemon is live on the target host** and deploys on
   `v*` tags. Version bumps will trigger composed rebuilds and a real production
   deploy — correct behaviour, but it must be deliberate.
5. **Airgap posture.** Production is docker-compose; the Helm chart needs an
   equivalent sidecar Deployment for the airgap path. Follow-on, not event-blocking.

## 11. Core changes required (small, generic, client-neutral)

1. **`plugin.json.dependencies` merging in `scripts/plugins/sync.mjs`** — without
   it no plugin can ship an npm dependency. Benefits every future plugin.
2. **Isolation-guard slug normalization.** `plugin-isolation.arch.test.ts:116`
   builds `new RegExp("\\bprisma\\." + slug + "[A-Z]")`. For a hyphenated slug like
   `pi-planning` that yields `prisma.pi-planning[A-Z]`, which can never match the
   real accessor `prisma.piPlanningCard` — so the "shared code never queries
   plugin-owned models" guard silently becomes a no-op. It works today only because
   existing slugs are single words. Fix: camelCase-normalize the slug in the test.

## Appendix — reference model

Derived from the canonical SAFe PI planning board and agenda.

**Program board:** columns are iterations, with an explicit Innovation & Planning
iteration last; row 0 is a Milestone/Event swimlane; rows are teams; cells hold
typed cards; connectors are first-class objects spanning cells. Card taxonomy:
Features and Enablers, Significant Dependency, Milestone/Event.

**Team board:** team backlog; per-iteration story cards; **capacity and load per
iteration**; Committed and Uncommitted PI Objectives, each with Planned BV and
Actual BV; team risks; Fibonacci estimation chips (0, 1, 2, 3, 5, 8, 13, 21).

**Predictability rule (exact):** Total Planned BV counts **committed objectives
only**, fixed after PI planning. Total Actual BV counts **all objectives including
uncommitted**, measured after the PI System Demo. This asymmetry is why stretch
objectives allow a team to exceed 100% predictability.

**Standard two-day agenda:**

| Day 1 | Duration | Day 2 | Duration |
|---|---|---|---|
| Business Context | 60m | Planning Adjustments | 60m |
| Product/Solution Vision | 90m | Team Breakouts | 120m |
| Architecture Vision & Dev Practices | 60m | Final Plan Review & Lunch | 120m |
| Planning Context & Lunch | 90m | Program Risks | 60m |
| Team Breakouts | 180m | Confidence Vote | 15m |
| Draft Plan Review | 60m | Plan Rework (conditional) | open |
| Management Review & Problem Solving | 60m | Planning Retrospective & Moving Forward | — |

"Plan Rework" is question-marked and open-ended in the canonical agenda — it is a
**conditional phase gated on the confidence vote**, which is why `AgendaPhase`
carries a declarative `entryCondition`.
