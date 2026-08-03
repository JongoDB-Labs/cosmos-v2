# PI Planning on Excalidraw — architecture baseline

**Status:** baseline decided, not yet implemented. Task #38.
**Date:** 2026-08-03.
**Supersedes** the framing in task #38 item 2 (see "A correction" below).

## The question this answers

Rebase the PI Planning program board on [Excalidraw](https://github.com/excalidraw/excalidraw)
rather than the current bespoke DOM grid, targeting the reference Miro SAFe board,
without weakening multi-tenancy or the audit trail.

Everything else — which library, how to wire the socket, what the grid looks like —
follows from one decision, so that decision is made first.

## A correction, before the decision

The earlier framing said Excalidraw's collaboration model "treats the shared scene
AS the source of truth", conflicting with cosmos treating the canvas as a
projection of audited Postgres rows.

**That is true of `excalidraw-app`, the hosted product. It is not true of the
`@excalidraw/excalidraw` package we would embed.** From its own FAQ:

> The Excalidraw package does not include built-in collaboration features because
> the implementation requirements are unique to each host application. Instead,
> the library exposes specific APIs that developers can utilize to build their own
> custom collaboration logic.

The package is agnostic about transport and persistence. It hands the host:

| API | What it gives us |
|---|---|
| `customData?: Record<string, any>` on every element | the binding from a canvas element to a Postgres row id. Documented as "invaluable for linking Excalidraw elements to your application's data model" |
| `locked: boolean` | structural grid furniture participants cannot drag apart |
| `updateScene({ elements, appState, collaborators })` | externally-driven projection — we push, it renders |
| `onChange(elements, appState, files)` | the hook where a drag becomes an audited mutation |
| `collaborators: Map<SocketId, Collaborator>` + follow mode | remote cursors rendered natively, and "everyone follow the RTE" |

So the supposed conflict is much smaller than recorded. The decision below is
therefore not a compromise between two incompatible models; it is the model the
package was designed for.

## Decision: (c) hybrid — with the durability moved to cosmos

Of the three options previously written down:

- **(a) scene purely ephemeral** — rejected. Freeform annotation would vanish when
  the last person leaves the room. In the Miro board we are targeting, annotation
  persists; losing it is a product regression, not a purity win.
- **(b) scene durable in the sidecar** — rejected, and the reason matters more
  than the option. The sidecar is deliberately unprivileged: *"no database
  connection, so a compromise here reads no planning data; no session cookies, so
  it cannot act as a user against the app."* Giving it a durable store hands it
  exactly the asset that design removes.
- **(c) hybrid** — adopted, with one refinement that resolves (a) vs (b): freeform
  content IS durable, but it is persisted **by cosmos, through an audited
  endpoint** — never by the sidecar. The sidecar stays a dumb ephemeral relay and
  keeps its "reads no planning data" property.

### The resulting shape

```
  Postgres (audited)          cosmos app                    sidecar (dumb relay)
  ────────────────────        ──────────────────────        ────────────────────
  PiPlanningCard         ──▶  project → Excalidraw     ◀──▶  Yjs awareness
  PiPlanningObjective         elements (customData)          (cursors, selection)
  PiPlanningRisk         ◀──  onChange → hit-test →           Yjs doc
  PiPlanningVote              audited PATCH /board            (freeform elements,
                                                               in flight)
  PiPlanningCanvas       ◀──  debounced snapshot ────────────┘
  (new, freeform only)        via audited endpoint
```

1. **Structured objects keep flowing through the audited APIs.** Cards,
   objectives, risks and votes are unchanged. `lib/board-model.ts` (`cellKey`,
   `computeCellLoad`, `groupByCell`, `isCrossTeam`) stays exactly as it is and
   becomes the projection layer under the new renderer. It is pure and already
   unit-tested, which is why it survives a renderer swap untouched.

2. **The scene is rendered, not authored.** Cosmos projects rows into elements and
   pushes them with `updateScene`. Grid furniture (team rows, iteration columns,
   lane headers) is emitted with `locked: true`. Cards carry
   `customData: { kind: "card", cardId, rev }`.

3. **Placement is derived from geometry, then written through the API.** This is
   the one genuinely new mechanism. Today `teamId`/`iterationId` are foreign keys
   set by a drop handler. On a canvas, a drag yields x/y. So:
   `onChange` → elements whose `customData.kind === "card"` moved → hit-test the
   element centre against the grid rectangles → if the resulting
   `cellKey(teamId, iterationId)` differs from the row's → `PATCH /board`.
   **The row is truth.** On success we re-project; a scene that disagrees heals on
   the next projection rather than being reconciled in place.

4. **Freeform annotation is durable, in cosmos.** A new plugin-owned table holds
   one snapshot per event — elements WITHOUT `customData.kind`, i.e. the
   arrows/boxes/text people draw. Written debounced from `onChange` through an
   audited endpoint that applies the same permission and project-scope checks as
   every other plugin route.

5. **Multi-tenancy is untouched, because it is already correct.** Room key stays
   `pi-planning:${orgId}:${eventId}`; `onAuthenticate` still DERIVES the allowed
   room from the signed claims and refuses a mismatch, so a client cannot name its
   own room. Excalidraw maps ONTO this room. It does not get a second realtime
   path — a second path would be a second place to get isolation wrong.

6. **Cursors move to Excalidraw's own collaborator rendering.** The existing
   awareness channel feeds `updateScene({ collaborators })`; the bespoke
   `live-cursors.tsx` overlay retires. Its hard-won lesson — positions travel as
   FRACTIONS, never pixels, or two people at different zooms point at different
   cards — is obsolete in scene coordinates, which are zoom-independent by
   construction. Follow mode (`onUserFollow`) comes free and is genuinely useful
   here: "everyone follow the RTE" during a draw-out.

## The security note, stated loudly

**`locked: true` is a client-side affordance, not an access control.** A modified
client can unlock a structural element, move another team's card, or fabricate a
`customData.cardId`. That is fine — and it is fine *only* because the canvas is
never the authority. Every structured mutation still goes through the existing
audited endpoint, which already checks the permission bit and the project scope.

This is the same class of mistake found across ~30 agent tools in 2.265.3: a
second surface over the same tables that looks like it has a gate. The canvas is
a third such surface. It must not acquire its own write path.

Concretely: **no endpoint may accept a scene and trust the row ids inside it.**
The freeform snapshot endpoint must strip anything carrying `customData.kind`
before persisting, so the canvas blob can never become a back door into
structured planning data.

## Conflict semantics

| Case | Resolution |
|---|---|
| Two people drag the same card | Both derive a cell and PATCH. Server settles last-write-wins; both scenes re-project to the row. The scene is never authoritative, so there is nothing to merge. |
| Freeform edits by many people | Yjs CRDT convergence, as now. Snapshot persists the converged state. |
| Card dragged while another edits its fields | Independent columns; no conflict. Placement and content are separate mutations. |
| A card row is deleted while on-canvas | Next projection drops the element. Stale elements never survive a re-projection. |
| Sidecar unavailable | Board still renders and still mutates — realtime is an enhancement, never a dependency (the current `live-cursors` contract, preserved). Freeform collaboration degrades to single-player; structured planning is unaffected. |

## Open questions for implementation (not blockers on the baseline)

1. **Next.js integration.** Cache Components is ON. Excalidraw is client-only and
   heavy; it needs `dynamic(() => import(...), { ssr: false })` inside a Suspense
   boundary. May also need adding to `serverExternalPackages`. Verify against the
   guides in `node_modules/next/dist/docs/` — this Next.js differs from training data.
2. **Bundle size.** Excalidraw is large. It must not load on any route other than
   the event workspace.
3. **Grid geometry as a contract.** Cell rectangles must be deterministic from
   (teams × iterations) so that hit-testing is stable across clients. Derive them
   from one pure function, unit-test it, and reuse it for both emission and
   hit-testing — two implementations would drift.
4. **Reconciliation fields.** Elements carry `version`/`versionNonce`/`index`
   (fractional indexing) for collab reconciliation. Projection must not clobber
   them blindly on every push, or it will fight Excalidraw's own ordering.
5. **Does the freeform snapshot need history?** Objectives and risks are audited;
   annotation arguably is not. Simplest defensible answer: snapshot only, no
   history, documented as such.

## What NOT to do

- Do not rebuild multi-tenancy. It is solved, and correctly (isolation from the
  signature, not from trusting client input).
- Do not give the sidecar a database.
- Do not design around `PiPlanningTeam` being replaced by core `Team`. That
  migration was examined and deliberately stopped at a link (see task #35): core
  `Team.projectId` is required while `PiPlanningTeam.projectId` is nullable by
  design, and `PiPlanningTeamMember.workRoleId` carries the SAFe role that gates
  ceremony authority. `PiPlanningTeam` and `PiPlanningTeamMember` are staying.
- Do not let the canvas become a write path for structured data.
