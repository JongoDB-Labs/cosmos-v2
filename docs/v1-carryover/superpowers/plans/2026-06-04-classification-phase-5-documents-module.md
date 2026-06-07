# Classification Phase 5 — Documents/Files Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project Documents module — upload/list/download files, each carrying a classification capped at the project's effective ceiling, with a Documents tab on every project.

**Architecture:** A single-version `Document` model (storage via the existing `getStorage()` adapter, served through an auth-checked route, never the raw URL). New `DOCUMENT_READ`/`DOCUMENT_WRITE` permission bits. A pure `cappedLevel` policy helper enforces "≤ project ceiling, default = ceiling" for both upload and reclassify. A client `DocumentsPanel` (list + upload-with-level-dropdown + per-doc reclassify dropdown capped at the ceiling) mounts on a new Documents tab.

**Tech Stack:** Prisma 6, Next.js App Router, React Query (`useOrgQueryKey`/`useOrgMutation`), `@base-ui` Select, Vitest.

---

## v1 scope decisions (YAGNI — read first)

- **No `DocumentVersion`** (the spec's versioning is deferred). `Document` holds `storageKey`/`filename`/`contentType`/`size` directly; re-upload = a new `Document`.
- **Access model = org-scoped + `DOCUMENT_*` permission**, NOT strict project-membership. This matches the codebase: project sub-pages (cycles/goals) and boards gate on `getAuthContext` + org scoping only, never project membership. (Spec said "project-membership"; that's inconsistent with the app and is corrected here.)
- **Reclassify** (changing a doc's level after upload) requires `DOCUMENT_WRITE` and is capped at the ceiling. The stricter "downgrade needs declassification authority" nuance is deferred (noted).
- **No delete endpoint** in v1 (deferred).
- Default new-doc level = the project's effective ceiling; a user may pick any level **≤ ceiling**.

## Conventions for the executor (read first)

- Working dir: the worktree `/home/defcon/cosmos-saas/.claude/worktrees/classification-propagation` (branch `worktree-classification-propagation`, v3.41.0). `.env.local` is symlinked. Prefix DB/Prisma commands with `set -a && . ./.env.local && set +a`.
- Vitest: `npm test` = `vitest run`; single file `npx vitest run <path>`. `npx tsc --noEmit` is the type gate (use `NODE_OPTIONS=--max_old_space_size=8192` if it OOMs).
- **Migrations:** `prisma migrate dev` WILL demand a reset on this DB (pre-existing `content_tsv` drift) — do NOT reset. Use the surgical path in Task 1.
- **Client-bundle rule:** client files import only `@/lib/classification/rank`/`format` (+ `ClassificationChip`) and `ClassificationLevel` as `import type`. Never the `@/lib/classification` barrel or `effective.ts`.
- `OrgMember.permissions` is BigInt — never include it in a Prisma select returned via `success()`.
- Commit after each task; stage only listed files (never `git add -A`).

## File structure

| File | Change |
|---|---|
| `prisma/schema.prisma` | + `Document` model; `documents` relation on `Organization` + `Project` |
| `prisma/migrations/<ts>_add_documents/migration.sql` | CREATE TABLE documents |
| `src/lib/rbac/permissions.ts` | + `DOCUMENT_READ`/`DOCUMENT_WRITE` bits + grants |
| `src/lib/documents/policy.ts` (+ test) | pure `cappedLevel(requested, ceiling)` |
| `src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/route.ts` | GET list + POST upload |
| `src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[documentId]/content/route.ts` | GET serve (stream) |
| `src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[documentId]/route.ts` | PATCH reclassify |
| `src/app/(dashboard)/[orgSlug]/projects/[projectKey]/board-tabs.tsx` | + Documents tab |
| `src/app/(dashboard)/[orgSlug]/projects/[projectKey]/documents/page.tsx` | server page |
| `src/components/documents/documents-panel.tsx` | client list/upload/reclassify |
| `package.json` | bump to 3.42.0 |

---

## Task 1: Schema — `Document` model + migration

**Files:** `prisma/schema.prisma`; new migration dir.

- [ ] **Step 1: Add the model + relations**

In `prisma/schema.prisma`, add the `documents` relation to BOTH `Organization` and `Project` model relation blocks:
- In `model Organization`, after `dataClassifications DataClassification[]`, add: `documents            Document[]`
- In `model Project`, after `dataClassifications DataClassification[]`, add: `documents          Document[]`

Then add the new model (place it right after the `DataClassification` model):
```prisma
model Document {
  id                  String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId               String              @map("org_id") @db.Uuid
  projectId           String              @map("project_id") @db.Uuid
  title               String
  classificationLevel ClassificationLevel @default(UNCLASSIFIED) @map("classification_level")
  storageKey          String              @map("storage_key")
  filename            String
  contentType         String              @map("content_type")
  size                Int
  uploadedById        String              @map("uploaded_by_id") @db.Uuid
  createdAt           DateTime            @default(now()) @map("created_at")
  updatedAt           DateTime            @updatedAt @map("updated_at")

  org     Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  project Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([orgId, projectId])
  @@map("documents")
}
```

- [ ] **Step 2: Validate**

Run: `set -a && . ./.env.local && set +a && npx prisma validate`
Expected: `valid 🚀`.

- [ ] **Step 3: Generate the exact SQL, keeping only the `documents` statements**

Run: `set -a && . ./.env.local && set +a && npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`

The output will include unrelated `content_tsv`/`chat_messages` drift lines — **IGNORE those**. Copy ONLY the `documents`-related statements (the `CREATE TABLE "documents"`, its `CREATE INDEX`, and the two `ALTER TABLE "documents" ADD CONSTRAINT ... FOREIGN KEY` lines) into a new migration file. Create the file:
```bash
set -a && . ./.env.local && set +a
mkdir -p prisma/migrations/20260604130000_add_documents
```
Write `prisma/migrations/20260604130000_add_documents/migration.sql` containing ONLY the documents statements from the diff. They should look like (use the EXACT text the diff emits):
```sql
-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "classification_level" "ClassificationLevel" NOT NULL DEFAULT 'UNCLASSIFIED',
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_org_id_project_id_idx" ON "documents"("org_id", "project_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply + record + generate**

```bash
set -a && . ./.env.local && set +a
npx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20260604130000_add_documents/migration.sql
npx prisma migrate resolve --applied 20260604130000_add_documents
npx prisma generate
```
Expected: "Script executed successfully", "marked as applied", "Generated Prisma Client".

- [ ] **Step 5: Verify**

Run: `set -a && . ./.env.local && set +a && npx prisma migrate status 2>&1 | tail -3`
Expected: "Database schema is up to date!"
Then confirm the table: `set -a && . ./.env.local && set +a && node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.document.count().then(n=>{console.log('documents rows:',n);return p.\$disconnect()}).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `documents rows: 0`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260604130000_add_documents
git commit -m "feat(documents): Document model + migration"
```

---

## Task 2: Permissions — DOCUMENT_READ / DOCUMENT_WRITE

**Files:** `src/lib/rbac/permissions.ts`

- [ ] **Step 1: Add the bits**

After the `CLASSIFICATION_MANAGE:1n << 101n,` line, add:
```ts
  DOCUMENT_READ:        1n << 102n,
  DOCUMENT_WRITE:       1n << 103n,
```

- [ ] **Step 2: Grant to roles**

`OWNER` already gets all permissions via `combine(...Object.values(Permission))` — nothing to do there. Add explicit grants:
- In the `ADMIN:` block, after `Permission.CLASSIFICATION_MANAGE,` add:
```ts
    Permission.DOCUMENT_READ,
    Permission.DOCUMENT_WRITE,
```
- In the `MEMBER:` block, after `Permission.CLASSIFICATION_READ,` add:
```ts
    Permission.DOCUMENT_READ,
    Permission.DOCUMENT_WRITE,
```
- In the `VIEWER:` block, after `Permission.CLASSIFICATION_READ,` add:
```ts
    Permission.DOCUMENT_READ,
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/rbac/permissions.ts
git commit -m "feat(documents): DOCUMENT_READ/WRITE permissions + role grants"
```

---

## Task 3: `cappedLevel` policy helper

**Files:** `src/lib/documents/policy.ts`; `src/lib/documents/policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/documents/policy.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { cappedLevel } from "./policy";

describe("cappedLevel", () => {
  it("defaults to the ceiling when no level is requested", () => {
    expect(cappedLevel(undefined, "CUI")).toBe("CUI");
  });

  it("accepts a requested level at or below the ceiling", () => {
    expect(cappedLevel("FOUO", "CUI")).toBe("FOUO");
    expect(cappedLevel("CUI", "CUI")).toBe("CUI");
  });

  it("returns null when the requested level exceeds the ceiling", () => {
    expect(cappedLevel("CONFIDENTIAL", "CUI")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/documents/policy.test.ts`
Expected: FAIL — cannot resolve `./policy`.

- [ ] **Step 3: Implement**

Create `src/lib/documents/policy.ts`:
```ts
import type { ClassificationLevel } from "@prisma/client";
import { isAtOrBelow } from "@/lib/classification/rank";

/**
 * Resolve the classification to store for a document, given the project's ceiling.
 * Defaults to the ceiling when none is requested; returns null when the requested
 * level exceeds the ceiling (caller should reject with 400).
 */
export function cappedLevel(
  requested: ClassificationLevel | undefined | null,
  ceiling: ClassificationLevel,
): ClassificationLevel | null {
  const level = requested ?? ceiling;
  return isAtOrBelow(level, ceiling) ? level : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/documents/policy.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documents/policy.ts src/lib/documents/policy.test.ts
git commit -m "feat(documents): cappedLevel policy helper (≤ ceiling, default ceiling)"
```

---

## Task 4: List + upload routes

**Files:** `src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/route.ts`

- [ ] **Step 1: Create the route**

Create `src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/route.ts`:
```ts
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { fileTypeFromBuffer } from "file-type";
import { effectiveClassification } from "@/lib/classification/effective";
import { cappedLevel } from "@/lib/documents/policy";
import { ClassificationLevel } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const MIME_WHITELIST = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf", "text/plain", "text/csv", "application/zip",
  "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

function jsonError(error: string, status: number, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.DOCUMENT_READ);

    const documents = await prisma.document.findMany({
      where: { orgId, projectId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, title: true, filename: true, contentType: true, size: true,
        classificationLevel: true, uploadedById: true, createdAt: true,
      },
    });
    return success(documents);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.DOCUMENT_WRITE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { id: true },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return jsonError("missing_file", 400);
    if (file.size > MAX_BYTES) return jsonError("too_large", 413, { maxBytes: MAX_BYTES });

    const title = (formData.get("title") as string | null)?.trim() || file.name;
    const requestedLevel = formData.get("classificationLevel") as string | null;

    const eff = await effectiveClassification(orgId, projectId);
    const level = cappedLevel(
      requestedLevel ? (requestedLevel as ClassificationLevel) : undefined,
      eff.level,
    );
    if (!level) return jsonError("classification_exceeds_ceiling", 400, { ceiling: eff.level });

    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = await fileTypeFromBuffer(buffer);
    let contentType: string;
    if (sniffed) contentType = sniffed.mime;
    else if (file.type === "text/plain" || file.type === "text/csv") contentType = file.type;
    else contentType = file.type || "application/octet-stream";
    if (!MIME_WHITELIST.has(contentType)) return jsonError("unsupported_mime", 415, { contentType });

    const documentId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
    const storageKey = `${orgId}/documents/${documentId}/${safeName}`;
    await getStorage().put(storageKey, buffer, { contentType, filename: file.name });

    const doc = await prisma.document.create({
      data: {
        id: documentId, orgId, projectId, title,
        classificationLevel: level, storageKey,
        filename: file.name, contentType, size: file.size,
        uploadedById: ctx.userId,
      },
      select: {
        id: true, title: true, filename: true, contentType: true, size: true,
        classificationLevel: true, uploadedById: true, createdAt: true,
      },
    });

    await logAudit({
      orgId, userId: ctx.userId, action: "document.created", entity: "document",
      entityId: doc.id, metadata: { projectId, classificationLevel: level },
      ipAddress: getIpAddress(req),
    });

    return created(doc);
  } catch (e) {
    return handleApiError(e);
  }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/route.ts"
git commit -m "feat(documents): list + upload routes (classification capped at ceiling)"
```

---

## Task 5: Serve + reclassify routes

**Files:**
- `src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[documentId]/content/route.ts`
- `src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[documentId]/route.ts`

- [ ] **Step 1: Serve route (stream)**

Create `.../documents/[documentId]/content/route.ts`:
```ts
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; documentId: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, documentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.DOCUMENT_READ);

    const doc = await prisma.document.findFirst({
      where: { id: documentId, orgId, projectId },
      select: { storageKey: true, contentType: true, filename: true, size: true },
    });
    if (!doc) return new Response("Not found", { status: 404 });

    const stream = await getStorage().stream(doc.storageKey);
    if (!stream) return new Response("Not found", { status: 404 });

    return new Response(stream, {
      headers: {
        "Content-Type": doc.contentType,
        "Content-Length": String(doc.size),
        "Content-Disposition": `inline; filename="${encodeURIComponent(doc.filename)}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
```

- [ ] **Step 2: Reclassify route (PATCH)**

Create `.../documents/[documentId]/route.ts`:
```ts
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { effectiveClassification } from "@/lib/classification/effective";
import { cappedLevel } from "@/lib/documents/policy";
import { z } from "zod";
import { ClassificationLevel } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; documentId: string }> };

const patchSchema = z.object({ classificationLevel: z.nativeEnum(ClassificationLevel) });

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, documentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.DOCUMENT_WRITE);

    const existing = await prisma.document.findFirst({
      where: { id: documentId, orgId, projectId },
      select: { id: true },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await req.json();
    const { classificationLevel } = patchSchema.parse(body);

    const eff = await effectiveClassification(orgId, projectId);
    const level = cappedLevel(classificationLevel, eff.level);
    if (!level) {
      return new Response(
        JSON.stringify({ error: "classification_exceeds_ceiling", ceiling: eff.level }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const doc = await prisma.document.update({
      where: { id: documentId },
      data: { classificationLevel: level },
      select: {
        id: true, title: true, filename: true, contentType: true, size: true,
        classificationLevel: true, uploadedById: true, createdAt: true,
      },
    });

    await logAudit({
      orgId, userId: ctx.userId, action: "document.classification_updated",
      entity: "document", entityId: doc.id,
      metadata: { projectId, classificationLevel: level },
      ipAddress: getIpAddress(req),
    });

    return success(doc);
  } catch (e) {
    return handleApiError(e);
  }
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[documentId]/content/route.ts" "src/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[documentId]/route.ts"
git commit -m "feat(documents): auth-checked serve route + reclassify (capped at ceiling)"
```

---

## Task 6: Documents tab + page + panel

**Files:**
- `src/app/(dashboard)/[orgSlug]/projects/[projectKey]/board-tabs.tsx` (add tab)
- `src/app/(dashboard)/[orgSlug]/projects/[projectKey]/documents/page.tsx` (create)
- `src/components/documents/documents-panel.tsx` (create)

- [ ] **Step 1: Add the Documents tab**

In `board-tabs.tsx`, add a static Documents tab immediately BEFORE the `New Board` `<Link>` (after the Cycles IIFE block):
```tsx
      {(() => {
        const docsHref = `/${orgSlug}/projects/${projectKey}/documents`;
        const isDocsActive = pathname === docsHref;
        return (
          <Link
            key="documents"
            href={docsHref}
            className={cn(
              "relative px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
              isDocsActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Documents
            {isDocsActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
            )}
          </Link>
        );
      })()}
```
Also update the early-return guard so the tab bar still renders for projects with no boards/features. Change:
```tsx
  if (boards.length === 0 && featureTabs.length === 0) return null;
```
to:
```tsx
  // Documents tab is always available, so the tab bar always renders.
```
(delete the early return entirely).

- [ ] **Step 2: Create the server page**

Create `src/app/(dashboard)/[orgSlug]/projects/[projectKey]/documents/page.tsx`:
```tsx
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { effectiveClassification } from "@/lib/classification/effective";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { DocumentsPanel } from "@/components/documents/documents-panel";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function DocumentsPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project) notFound();

  const eff = await effectiveClassification(ctx.orgId, project.id);

  // requirePermission throws on denial; wrap it for a boolean (check.ts has no
  // ctx-based boolean checker).
  let canWrite = true;
  try {
    requirePermission(ctx, Permission.DOCUMENT_WRITE);
  } catch {
    canWrite = false;
  }

  return (
    <DocumentsPanel
      orgId={ctx.orgId}
      projectId={project.id}
      ceiling={eff.level}
      canWrite={canWrite}
    />
  );
}
```

- [ ] **Step 3: Create the client panel**

Create `src/components/documents/documents-panel.tsx`:
```tsx
"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Paperclip, Upload, Download } from "lucide-react";
import type { ClassificationLevel } from "@prisma/client";
import { levelsUpTo } from "@/lib/classification/rank";
import { ClassificationChip } from "@/components/security/classification-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";

interface DocumentDto {
  id: string;
  title: string;
  filename: string;
  contentType: string;
  size: number;
  classificationLevel: ClassificationLevel;
  uploadedById: string;
  createdAt: string;
}

export function DocumentsPanel({
  orgId,
  projectId,
  ceiling,
  canWrite,
}: {
  orgId: string;
  projectId: string;
  ceiling: ClassificationLevel;
  canWrite: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<ClassificationLevel>(ceiling);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const base = `/api/v1/orgs/${orgId}/projects/${projectId}/documents`;
  const queryKey = useOrgQueryKey("project-documents", projectId);

  const { data: documents = [], refetch } = useQuery<DocumentDto[]>({
    queryKey,
    queryFn: () => jsonFetch(base),
  });

  const allowed = levelsUpTo(ceiling);

  const reclassify = useOrgMutation<DocumentDto, Error, { id: string; classificationLevel: ClassificationLevel }>({
    mutationFn: ({ id, classificationLevel }) =>
      jsonFetch(`${base}/${id}`, { method: "PATCH", body: JSON.stringify({ classificationLevel }) }),
    invalidate: [["project-documents", projectId]],
  });

  async function onUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (title.trim()) fd.append("title", title.trim());
      fd.append("classificationLevel", level);
      const r = await fetch(base, { method: "POST", body: fd });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        setError(body?.error ?? `Upload failed (${r.status})`);
        return;
      }
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
      setLevel(ceiling);
      await refetch();
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Documents</h2>
      </div>

      {canWrite && (
        <div className="flex flex-wrap items-end gap-2 rounded border p-3">
          <input
            ref={fileRef}
            type="file"
            aria-label="File"
            className="max-w-xs text-sm"
          />
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            aria-label="Document title"
            className="max-w-xs"
          />
          <Select value={level} onValueChange={(v) => setLevel(v as ClassificationLevel)}>
            <SelectTrigger aria-label="Classification" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowed.map((l) => (
                <SelectItem key={l} value={l}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={onUpload} disabled={uploading} className="gap-1">
            <Upload className="h-4 w-4" /> {uploading ? "Uploading…" : "Upload"}
          </Button>
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      )}

      {documents.length === 0 ? (
        <EmptyState title="No documents" description="Upload a file to get started." />
      ) : (
        <ul className="divide-y rounded border">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate flex-1 text-sm">{d.title}</span>
              <ClassificationChip level={d.classificationLevel} />
              {canWrite && (
                <Select
                  value={d.classificationLevel}
                  onValueChange={(v) =>
                    reclassify.mutate({ id: d.id, classificationLevel: v as ClassificationLevel })
                  }
                >
                  <SelectTrigger aria-label="Reclassify" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allowed.map((l) => (
                      <SelectItem key={l} value={l}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <a
                href={`${base}/${d.id}/content`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: no errors. (`jsonFetch`/`useOrgQueryKey`/`useOrgMutation` and `Select`/`Input`/`Button`/`EmptyState` are used exactly as in `src/components/projects/project-card.tsx`; the file picker is a native `<input>` to sidestep ref-forwarding. `useOrgMutation` generics are `<TData, TError, TVariables>` per that file.)

- [ ] **Step 5: Component smoke test (capped dropdown)**

Create `src/components/documents/documents-panel.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { levelsUpTo } from "@/lib/classification/rank";

// The upload + reclassify dropdowns are built from levelsUpTo(ceiling); this locks
// the cap contract the panel relies on (full DOM render needs a QueryClient + fetch
// mock, covered by manual verification).
describe("DocumentsPanel classification options", () => {
  it("offers only levels at or below the project ceiling", () => {
    expect(levelsUpTo("CUI")).toEqual(["PUBLIC", "UNCLASSIFIED", "FOUO", "CUI"]);
    expect(levelsUpTo("FOUO")).not.toContain("CUI");
  });
});
```

Run: `npx vitest run src/components/documents/documents-panel.test.tsx`
Expected: PASS — 1 test.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/board-tabs.tsx" "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/documents/page.tsx" src/components/documents/documents-panel.tsx src/components/documents/documents-panel.test.tsx
git commit -m "feat(documents): Documents tab + panel (upload/list/reclassify capped at ceiling)"
```

---

## Task 7: Version bump + final verify

- [ ] **Step 1:** `npm version minor --no-git-tag-version` → `v3.42.0`.
- [ ] **Step 2:** Commit: `git add package.json package-lock.json && git commit -m "chore(release): 3.42.0 — per-project Documents module"`
- [ ] **Step 3:** Final: `set -a && . ./.env.local && set +a && npx vitest run` (all green) and `NODE_OPTIONS=--max_old_space_size=8192 npx tsc --noEmit` (clean).

---

## Self-Review

**Spec coverage (spec §6 Phase 5):**
- New document entity → Task 1 (single-version `Document`; `DocumentVersion` deferred per v1 scope) ✓
- Upload via `getStorage()` adapter, MIME/size guards like chat attachments → Task 4 ✓
- Per-doc dropdown capped at the ceiling → Task 3 (`cappedLevel`) + Task 6 (`levelsUpTo` dropdowns) ✓
- Auth-checked serve route (never raw storage URL) → Task 5 ✓
- Documents tab per project → Task 6 ✓
- `DOCUMENT_READ/WRITE` bits → Task 2 ✓
- Default = ceiling, audit on apply/raise/lower → Tasks 4–5 (`logAudit`) ✓
- Deferred (documented): `DocumentVersion`, delete endpoint, declassification-authority on downgrade, strict project-membership gating (uses the app's org-scoped model).

**Placeholder scan:** none — full code/commands in every step. The two formerly-uncertain symbols are resolved in-plan: the page uses `requirePermission` in a try/catch for `canWrite` (check.ts exposes no ctx-based boolean checker), and the panel uses a native file `<input>` (base-ui `Input` ref-forwarding is unconfirmed).

**Type consistency:** `cappedLevel(requested, ceiling): ClassificationLevel | null` is used identically in the upload + reclassify routes; `ClassificationLevel` flows from schema → routes → `DocumentDto` → panel; `levelsUpTo(ceiling)` (Phase 1) drives both dropdowns; `effectiveClassification(orgId, projectId)` supplies the ceiling everywhere.

**Note for executor:** all symbols are verified against the codebase — `requirePermission` (check.ts), `hasPermission(bitmask, required)` (permissions.ts, unused here), `Input` (base-ui, plain fn component → native file input used), `useOrgMutation<TData,TError,TVariables>` / `useOrgQueryKey` / `jsonFetch` (per project-card.tsx). Do not invent APIs.
