# Entity-reference schema (@-mentions + ⌘K)

The **entity-reference schema** is the shared contract behind universal
`@`-mentions and the ⌘K quick-action palette. One canonical reference format lets
any input surface (chat, work-item comments, Lexical notes, the AI assistant)
tag any taggable object in the app — people, work items, projects, notes, and
14 more classes — and have that tag render as a deep-linking chip, power
"Mentioned in …" backlinks, and share a single search index with ⌘K.

This document is the reuse guide: import these modules instead of re-parsing
tokens or re-implementing per-type search by hand.

## Where it lives

| Concern | Module | Notes |
| --- | --- | --- |
| Token format + pure helpers | `src/lib/mentions/refs.ts` | **PURE** — no server/client deps; import anywhere (node, edge, client) |
| Plain-textarea insert helpers | `src/lib/mentions/input.ts` | **PURE**; used by chat/comment/assistant composers (Lexical uses its own plugin) |
| Deep-link URL builder | `src/lib/mentions/urls.ts` | **PURE**; server + client build identical URLs |
| Server search / resolve / backlinks | `src/lib/mentions/registry.server.ts` | Prisma index — `searchEntities`, `resolveRefs`, `resolveBacklinks` |
| Client display metadata | `src/lib/mentions/registry.client.tsx` | `ENTITY_ICON` (lucide) + re-exports `ENTITY_PREFIX` |
| Backlink recorder | `src/lib/mentions/references.ts` | `syncReferences` reconciles `entity_references` rows |
| Picker UI + hooks | `src/components/mentions/` | `entity-mention-picker.tsx`, `hooks.ts`, `mentioned-in.tsx` |

## Token format

References are stored **inline in the content string** as tokens. Two forms, for
backward-compatibility with the original people-only mentions:

- **`user`** → `<@<id>>` (no type prefix). Unchanged from the legacy format, so
  existing content, the person-notification fan-out (`src/lib/chat/mentions.ts`
  `parseMentions`), and the legacy renderer keep working untouched.
- **every other type** → `<@<type>:<id>>` — e.g. `<@workItem:UUID>`,
  `<@project:UUID>`, `<@note:UUID>`.

Tokens store the **id only** (stable + canonical). Labels are resolved at render
time, so a renamed entity always shows its current name and there is no stale
denormalized text. The id powers deep-links and backlinks.

Regex: `TOKEN_RE = /<@(?:([a-zA-Z][a-zA-Z0-9]*):)?([a-zA-Z0-9_-]+)>/g`. An id
that starts with a digit (UUIDs do) cannot be mistaken for a type prefix, so the
legacy `<@uuid>` form always resolves to `user`.

## Entity types

`ENTITY_TYPES` (in `refs.ts`) is the single source of truth — currently 19:

`user`, `workItem`, `project`, `note`, `meeting`, `board`, `milestone`,
`objective`, `goal`, `kpi`, `document`, `risk`, `deliverable`, `blocker`,
`changeRequest`, `clin`, `crmContact`, `partner`, `product`.

Each type has parallel metadata records keyed by `EntityType`: `ENTITY_PREFIX`
(inline chip glyph), `ENTITY_LABEL` / `ENTITY_LABEL_PLURAL` (picker group
headers), `ENTITY_ORDER` (result display order), and `ENTITY_ICON` (lucide icon,
client-only). A unit test (`refs.test.ts`) asserts every record covers exactly
`ENTITY_TYPES`, so adding a type to the list fails the build until the metadata
is filled in.

## Pure API (`refs.ts`)

```ts
type EntityType;                       // union of ENTITY_TYPES
type EntityRef = { type: EntityType; id: string };
type ResolvedEntity = { type; id; label; sublabel?; url: string | null };

isEntityType(s: unknown): s is EntityType;
buildToken(type, id): string;          // → canonical stored token
parseRefs(content): EntityRef[];       // extract distinct refs (deduped; unknown prefix → user)
refKey(type, id): string;              // stable, case-insensitive map key
```

`parseRefs` dedupes by `refKey` (type + lowercased id) and never throws on a
malformed/unknown token — a stray prefix falls back to `user`.

## Inserting a mention (plain textareas) — `input.ts`

```ts
detectMentionQuery(text, caret): string | null;  // the active @query, or null (closes at whitespace)
insertMentionToken(text, caret, type, id): { value, caret };  // replace @query with buildToken(...) + space
```

The Lexical notes editor uses its own node/plugin
(`src/components/notes/editor/`), not these helpers, but inserts the same tokens.

## Shared search index — `registry.server.ts`

`searchEntities` is the one index behind **both** the `@` typeahead and ⌘K:

```ts
searchEntities({ orgId, orgSlug, userId, query, types?, perType? }): Promise<EntityHit[]>
resolveRefs({ orgId, orgSlug, userId, refs }): Promise<EntityHit[]>   // stored tokens → labels + urls
resolveBacklinks({ orgId, orgSlug, userId, targetType, targetId, limit? }): Promise<Backlink[]>
```

Per-type `Handler`s do a case-insensitive `contains` search; `finalize()`
batch-resolves each hit's owning-project `key` and builds the label + deep-link
`url` (via `entityUrl`). The ⌘K route (`/api/v1/orgs/[orgId]/search`) delegates
to `searchEntities` and maps hits to the palette shape — so `@` and ⌘K can never
drift apart.

## Deep links — `urls.ts`

`entityUrl(type, { orgSlug, projectKey?, id })` returns the route for a chip, or
`null` when there is no navigable target (e.g. `user` has no profile page, or a
project-scoped entity whose key couldn't be resolved). Work items and notes use
focus params (`/issues?item=<id>`, `/notes?note=<id>`) that their views honor to
auto-open the item; item-level routes exist for meetings, documents, boards, and
projects; the remaining register types deep-link to their list page.

## Permissions

Tagging respects what the current user can see:

- **Route layer:** every mentions endpoint (`search`, `resolve`, `backlinks`)
  and the ⌘K `search` route require `Permission.ORG_READ` after resolving the
  auth context, and 401 when unauthenticated.
- **Query layer:** every handler is `orgId`-scoped, so cross-tenant entities are
  never returned. Notes are additionally visibility-scoped (`ORG` / `PROJECT`,
  or `PRIVATE` only for the author). Resolution uses the same scoped queries, so
  a token the user can't read simply doesn't resolve and its chip renders as a
  non-linking fallback label.

## Backlinks — `references.ts` + the `Reference` model

`syncReferences({ orgId, sourceType, sourceId, content, createdById? })` is
called whenever mention-bearing content is created/updated (chat message,
comment, note, work-item body). It diffs `parseRefs(content)` against the
existing rows and adds/removes `entity_references` rows accordingly. Target ids
are UUID-guarded and the call is best-effort (never fail the primary write).

The `Reference` model (`entity_references` table) is polymorphic — no FKs,
mirroring `PmLink`:

```
id, orgId, sourceType, sourceId, targetType, targetId, createdById?, createdAt
@@unique([sourceType, sourceId, targetType, targetId])
@@index([orgId, targetType, targetId])   // powers "Mentioned in …"
@@index([sourceType, sourceId])          // powers reconcile-on-save
```

`resolveBacklinks` reads the `[orgId, targetType, targetId]` index and turns each
source back into a labeled deep-link (notes/work items resolve directly;
comments resolve to their work item; chat messages resolve to their channel).

## API surface

| Method + path | Purpose |
| --- | --- |
| `GET /api/v1/orgs/[orgId]/mentions/search?q=&types=&perType=` | `@` typeahead (shares `searchEntities`) |
| `POST /api/v1/orgs/[orgId]/mentions/resolve` `{ refs: [{ type, id }] }` | batch-resolve stored tokens → chip data |
| `GET /api/v1/orgs/[orgId]/mentions/backlinks?type=&id=` | "Mentioned in …" for a target |
| `GET /api/v1/orgs/[orgId]/search?...` | ⌘K palette — delegates to `searchEntities` |

## Adding a new entity type (reuse checklist)

1. Add the type name to `ENTITY_TYPES` in `refs.ts`.
2. Fill the parallel records: `ENTITY_PREFIX`, `ENTITY_LABEL`,
   `ENTITY_LABEL_PLURAL`, `ENTITY_ORDER` (`refs.ts`) and `ENTITY_ICON`
   (`registry.client.tsx`). `refs.test.ts` fails until these are complete.
3. Add a `Handler` in `registry.server.ts` — `makeHandler({...})` covers the
   common "org-scoped, one text field, optional `code`/`ticketNumber`/
   `projectId`" shape; write it out for anything visibility-scoped (see `note`).
   Keep queries `orgId`-scoped.
4. Add a `case` to `entityUrl` in `urls.ts` (or return `null` if there is no
   route yet).
5. If content of this type can hold mentions, wire `syncReferences` into its
   create/update path and add a source resolver branch to `resolveBacklinks`.
