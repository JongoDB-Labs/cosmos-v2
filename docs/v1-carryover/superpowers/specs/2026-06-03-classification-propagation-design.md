# Classification Propagation — Design

**Date:** 2026-06-03
**Status:** Approved (design); ready for implementation planning
**Author:** COSMOS Agent (with fightingsmartcyber@gmail.com)
**Approach:** A — *marking/labeling layer* (not access-enforcement). See "Approach decision" below.

---

## 1. Problem

Cosmos already lets an org define a **data classification** per project (and one org-wide
default) on the **Settings → Classifications** page. The capability exists but is
**siloed in Settings** — it never reaches the surfaces where people actually work:

- **No project banner.** The project detail page (`src/app/(dashboard)/[orgSlug]/projects/[projectKey]/page.tsx`)
  is a stub that redirects to the first board; project cards
  (`src/components/projects/project-card.tsx`) show status/progress only. Neither reads
  classification.
- **No per-document labeling.** There is no document/file entity at all. The only
  upload-like model is `ChatMessageAttachment` (chat uploads), which carries no
  classification. The only generated artifact is the contract PDF
  (`src/lib/pdf/contract.ts`), which carries no marking.
- **No "highest level" concept.** Nothing ranks the levels or computes a project's
  effective classification. `DataClassification.projectId` is a bare nullable UUID with
  **no Prisma relation** to `Project`, so a project cannot even see "its own"
  classification without a manual side query.

**Goal:** propagate classification into the project surfaces — a project banner, a new
Documents/Files module, classified chat attachments, and markings on generated documents —
so the classification an org already defines becomes **visible and usable inside each
project**.

---

## 2. Current state (ground truth)

| Concern | Today |
|---|---|
| Levels | `enum ClassificationLevel { PUBLIC, UNCLASSIFIED, FOUO, CUI, CONFIDENTIAL }` (`prisma/schema.prisma:1051`) |
| Record | `DataClassification` — `orgId`, nullable `projectId`, `level`, `markings String[]`, `handlingInstructions`, `appliedById`; `@@unique([orgId, projectId])` (`prisma/schema.prisma:1093`) |
| Relation | Only `Organization.dataClassifications` (`schema.prisma:122`). **No `Project` relation.** |
| Settings UI | `src/components/security/classification-manager.tsx` at `.../settings/classifications/page.tsx` — create/edit one org-wide + one per-project record; dropdown shows all 5 levels |
| API | `src/app/api/v1/orgs/[orgId]/classifications/route.ts` — GET (`CLASSIFICATION_READ`), POST upsert (`CLASSIFICATION_MANAGE`) |
| Permissions | `CLASSIFICATION_READ = 1n << 100n`, `CLASSIFICATION_MANAGE = 1n << 101n` (`src/lib/rbac/permissions.ts`) |
| Storage | `getStorage()` adapter — `put/delete/stream`, pluggable via `STORAGE_ADAPTER` env, local now, `vercel-blob` planned (`src/lib/storage/index.ts`) |
| Upload pattern | `src/app/api/v1/orgs/[orgId]/chat/attachments/route.ts` — formData → 25 MB cap → magic-byte sniff (`file-type`) → MIME whitelist → `storageKey = ${orgId}/${id}/${name}` → `getStorage().put` → DB row → **serve-route URL (auth-checked), never the raw storage URL** → lazy GC |
| Generated docs | `src/lib/pdf/contract.ts` (pdfkit, externalized in `next.config.ts`); CSV/JSON exports under `.../export/*` |

### Data-model quirks to respect
- `@@unique([orgId, projectId])` with a **nullable** `projectId`: Postgres treats NULLs
  as distinct, so the unique does **not** enforce a single org-wide row. The existing API
  already handles the org-wide case with `findFirst({ projectId: null })` + manual
  create/update — preserve that pattern; do not assume the unique guarantees a singleton.

---

## 3. Approach decision

Two fundamentally different meanings of "classification" were considered:

- **Approach A — Marking/labeling layer (CHOSEN).** Classification *labels* content,
  *caps* what level content can be marked at (the project ceiling), renders banners and
  document markings, drives handling guidance, and is fully audited. It does **not** gate
  read access — marking a document "CUI" labels it; it does not stop a project member from
  opening it.
- **Approach B — Access-enforcing.** Classification gates *read access* via a per-user
  **clearance** model, ABAC on every read, break-glass, and denial auditing. Materially
  heavier; deferred as documented future work (§9).

**Rationale:** A matches the data model already in place, ships visible value across all
project surfaces quickly, and is the foundation B would build on. The marking-vs-access
distinction is called out explicitly so no one assumes a "CUI" label restricts access in v1.

---

## 4. Core library — `src/lib/classification/`

Everything below depends on a small, well-bounded core (mirrors the existing
`src/lib/storage/` and `src/lib/compliance/` conventions).

### 4.1 Ranking — `rank.ts`
Explicit rank map (do **not** rely on enum declaration order):

```ts
export const CLASSIFICATION_RANK: Record<ClassificationLevel, number> = {
  PUBLIC: 0,
  UNCLASSIFIED: 10,
  FOUO: 20,
  CUI: 30,
  CONFIDENTIAL: 40,
};
```

- Spaced by 10 so `SECRET`/`TOP SECRET` can be inserted later without renumbering.
- This is intentionally a **CUI-and-below** system — appropriate, since true classified
  national-security information must not live in commercial SaaS. Extensibility is noted,
  not built.
- Helpers: `rankOf(level)`, `maxLevel(a, b)`, `isAtOrBelow(level, ceiling)`,
  `levelsUpTo(ceiling)` (returns the allowed dropdown options ≤ ceiling).

### 4.2 Effective ceiling — `effective.ts`
```ts
// org-wide row = floor/default; project row may only raise at/above it.
effectiveCeiling(orgLevel, projectLevel?) => maxLevel(orgLevel, projectLevel ?? orgLevel)
```
- `effectiveClassification(projectId)` — server helper returning
  `{ level, markings, handlingInstructions, source: "project" | "org" | "default" }`,
  computed from the project row (if any) and the org-wide row, defaulting to
  `UNCLASSIFIED` when neither exists. `markings` come from the row that determined the
  effective level.

### 4.3 Banner formatting — `format.ts`
- `formatMarking(level, markings)` → **formal** banner string:
  `CUI//NOFORN/FEDCON` (level, then control markings joined by `/` after `//`). For
  `PUBLIC`/`UNCLASSIFIED`, just the level. Aligns to the DoD/CUI Marking Handbook
  banner-line convention (overall level first, control markings after `//`).
- `describeClassification(effective)` → **descriptive** UI sentence, e.g.
  *"Highest classification for this project: CUI // NOFORN"* (per user direction — not a
  bare chip).
- `bannerColor(level)` → reuse the palette already in `classification-manager.tsx`
  (PUBLIC emerald, UNCLASSIFIED blue, FOUO amber, CUI orange, CONFIDENTIAL red).

**Display split:** in-app surfaces use `describeClassification` (friendly); generated
documents use `formatMarking` centered top + bottom of every page (formal).

### 4.4 Tests
Unit tests for rank ordering, `maxLevel`, `levelsUpTo`, `effectiveCeiling` (org floor vs
project raise vs default), and both formatters (with/without markings).

---

## 5. Schema changes

```prisma
model Project {
  // ...existing...
  dataClassification DataClassification?   // the project-scoped row (0..1)
}

model DataClassification {
  // ...existing...
  projectId String? @map("project_id") @db.Uuid
  project   Project? @relation(fields: [projectId], references: [id], onDelete: Cascade)
}
```

New permission bits (next free after 101 — 102/103 are unused):
```ts
DOCUMENT_READ:  1n << 102n,
DOCUMENT_WRITE: 1n << 103n,
```
Add to the appropriate default role grants (mirror how `CLASSIFICATION_*` is granted in
`permissions.ts`).

Phase-specific models (`ChatMessageAttachment` fields, `Document`/`DocumentVersion`) are
defined in their phases below. Each schema change ships its own Prisma migration.

---

## 6. Phases

### Phase 1 — Foundation
- Build `src/lib/classification/` (§4) with tests.
- Add the `Project ↔ DataClassification` relation (§5) + migration.
- Add `effectiveClassification(projectId)` server helper.
- **No UI yet.** This phase is pure substrate + tests.

**Done when:** core lib is unit-tested green; relation migrates cleanly; helper returns
correct effective levels for project-row / org-floor / default cases.

### Phase 2 — Project banner + card chips
- `<ClassificationBanner>` (`src/components/security/classification-banner.tsx`): renders
  `describeClassification` with `bannerColor`, plus handling instructions when present.
- Mount on the project detail surfaces — **both** the board view and the "No boards yet"
  empty state (`.../projects/[projectKey]/page.tsx` and the board page). Fetch effective
  classification server-side; follow the Cache-Components Suspense rules in `AGENTS.md`
  (dynamic reads inside a Suspense child).
- Level chip on `project-card.tsx` next to the status chip.
- `PUBLIC`/`UNCLASSIFIED`: render a muted chip but **no** prominent banner (avoid banner
  fatigue on unclassified projects).

**Done when:** a project with a CUI ceiling shows the descriptive banner on its pages and
a chip on its card; an unclassified project shows only the muted chip.

### Phase 3 — Generated-document markings
- Stamp `formatMarking(effective.level, effective.markings)` as a **centered header and
  footer on every page** of the contract PDF (`src/lib/pdf/contract.ts`). Thread the
  project's effective classification into `ContractPdfInput`.
- Add the same marking line to CSV/JSON exports (`.../export/csv/[entity]`,
  `.../export/json`) — as a leading marking row (CSV) / top-level `classification` field
  (JSON).
- No new model; depends only on the Phase 1 formatter.

**Done when:** a generated contract PDF for a CUI project shows `CUI//…` top and bottom of
each page; exports carry the marking.

### Phase 4 — Classified chat attachments
- Extend `ChatMessageAttachment`:
  ```prisma
  classificationLevel ClassificationLevel @default(UNCLASSIFIED)
  markings            String[]            @default([])
  ```
- On upload (`.../chat/attachments/route.ts`): resolve the channel's project ceiling
  (channels tied to a project; org floor otherwise) and **reject** an attachment marked
  above the ceiling (`isAtOrBelow`). Default marking = the ceiling (§7, decision 1).
- Render a marking chip on the file/image bubble in chat.
- Reclassify endpoint guarded per §8.

**Done when:** a file shared in a CUI project's channel shows a `CUI` chip and cannot be
marked `CONFIDENTIAL`.

### Phase 5 — Documents/Files module
- New models:
  ```prisma
  model Document {
    id                  String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    orgId               String   @map("org_id") @db.Uuid
    projectId           String   @map("project_id") @db.Uuid
    title               String
    classificationLevel ClassificationLevel @default(UNCLASSIFIED)
    markings            String[] @default([])
    currentVersionId    String?  @map("current_version_id") @db.Uuid
    createdById         String   @map("created_by_id") @db.Uuid
    createdAt           DateTime @default(now()) @map("created_at")
    updatedAt           DateTime @updatedAt @map("updated_at")
    // relations: org, project, versions, currentVersion
    @@index([orgId, projectId])
    @@map("documents")
  }

  model DocumentVersion {
    id           String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    documentId   String   @map("document_id") @db.Uuid
    version      Int
    storageKey   String   @map("storage_key")
    filename     String
    contentType  String   @map("content_type")
    size         Int
    uploadedById String   @map("uploaded_by_id") @db.Uuid
    createdAt    DateTime @default(now()) @map("created_at")
    @@unique([documentId, version])
    @@map("document_versions")
  }
  ```
- **Upload** mirrors the chat-attachment route exactly: size cap, magic-byte sniff, MIME
  whitelist, `getStorage().put`, `storageKey = ${orgId}/${documentId}/${filename}`.
- **Serve route** (`.../documents/[documentId]/route.ts`) streams via the adapter behind
  an auth + project-membership check — clients fetch through the API, **never** the raw
  storage URL (same rule the chat serve route follows for private channels).
- **Per-doc classification dropdown capped at the ceiling**: the picker offers
  `levelsUpTo(effectiveCeiling)`; levels above the ceiling are disabled. Default = ceiling
  (§7, decision 1).
- **Documents tab** on the project (new route under `.../projects/[projectKey]/documents`).
  Each row shows its marking chip; the page shows the project banner (Phase 2 component).

**Done when:** a user can upload a document into a CUI project, the dropdown disallows
`CONFIDENTIAL`, the file lists with its marking, and downloads go through the auth-checked
serve route.

---

## 7. Decisions (approved)

1. **Per-document/attachment default marking = the project ceiling** (fail-safe: never
   accidentally under-mark). The user may lower it down to the org floor.
2. **Approach A (marking, not access-enforcement).** Marking does not gate read access in
   v1. (See §3, §9.)
3. **Project ceiling cannot be set below the org floor** — enforce on write in the
   classifications POST handler (today it blindly upserts the posted level).

---

## 8. ABAC / audit

| Action | Permission |
|---|---|
| View banner / documents / attachments | `CLASSIFICATION_READ` (+ project membership for doc list/serve) |
| Upload a document / mark content **≤ ceiling** | `DOCUMENT_WRITE` |
| Set / **raise** the project ceiling | `CLASSIFICATION_MANAGE` |
| **Downgrade** content below its current marking (declassify) | `CLASSIFICATION_MANAGE` (stricter than write) |

- Reuse `requirePermission(ctx, …)` from `src/lib/rbac/check.ts`.
- Every apply / raise / lower (project ceiling, document marking, attachment marking) is
  recorded via `logAudit` with a `classification.*` action and the before/after level —
  consistent with the existing classification API and the new compliance audit mapping.

---

## 9. Future work (documented, NOT in scope)

- **Approach B:** per-user clearance model + read-access enforcement + break-glass +
  denial auditing.
- **True high-water-mark banner:** derive the project banner from the highest marking of
  any content actually inside it (vs. the explicit ceiling), recomputed on content change.
- **Declassification two-person rule** for downgrades.
- **`SECRET` / `TOP SECRET`** levels (rank map already spaced for insertion).
- **Aggregation warnings** (classification-by-compilation).

---

## 10. Out of scope

- Changing how classifications are *created* in Settings (that UI stays; we only add the
  org-floor guard from decision 3 and the Project relation).
- Migrating existing chat attachments to a classification (they default to `UNCLASSIFIED`).
- Any access-control / clearance enforcement (Approach B).

---

## 11. Testing strategy

- **Unit:** core lib (§4.4) — rank, ceiling, formatters, `levelsUpTo`.
- **Integration:** classifications POST rejects a project level below the org floor;
  attachment/document upload rejects a marking above the ceiling; serve route 403s a
  non-member.
- **Component:** `<ClassificationBanner>` renders descriptive text + color per level and
  suppresses the prominent banner for PUBLIC/UNCLASSIFIED.
- **Manual:** generated contract PDF shows the formal `CUI//…` marking top + bottom.

---

## 12. Versioning

Per `AGENTS.md`: each phase is a **minor** bump (new, non-breaking feature) except where a
migration changes existing data semantics. Bump `package.json` `version` per phase.
