# Classification Phase 2 — Project Banner + Card Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface each project's effective classification — a prominent banner on every project page and a level chip on every project card/table row — using the Phase 1 `src/lib/classification/` lib.

**Architecture:** Two presentational components (`ClassificationChip`, `ClassificationBanner`) driven by the Phase 1 lib. The banner mounts once in the project **layout** (`[projectKey]/layout.tsx`), so it covers the board view, the empty state, and every project sub-page automatically. The card chip flows through the existing `getActiveProjectsForOrg` cache query via a single batched classification read (no N+1). A small client-bundle-safety refactor of the Phase 1 pure modules precedes the UI.

**Tech Stack:** Next.js 16 (App Router, Cache Components — `"use cache"`), React server + client components, Vitest 4 + @testing-library/react (jsdom), Prisma 6, Tailwind.

---

## Conventions for the executor (read first)

- Branch is `feat/classification-propagation` (already checked out). Phase 1 is committed (`src/lib/classification/` lib + the `Project ↔ DataClassification` relation/migration). Do NOT redo Phase 1.
- Test runner: `npm test` = `vitest run`. Single file: `npx vitest run <path>`. jsdom is the default env; component tests use `@testing-library/react` (`render`, `screen`).
- **Client-bundle rule (critical):** `src/lib/classification/effective.ts` imports Prisma (`@/lib/db/client`). A **client** component must NEVER transitively import it. Client/presentational components import ONLY from `@/lib/classification/format` and `@/lib/classification/rank` (pure), and import `ClassificationLevel` / `EffectiveClassification` as **`import type`** (type-only imports are erased at build, so `@prisma/client` is not bundled). NEVER import from the `@/lib/classification` barrel (`index.ts`) in a client component — it re-exports `effective.ts`.
- `project-card.tsx` is a `"use client"` file. The existing `src/components/security/classification-manager.tsx` is also client and deliberately uses a local string-union for levels — same reasoning.
- The husky pre-commit hook runs `lint-staged` (eslint/prettier) on staged files; it may reformat. That's fine. Stage only the files each task lists — there is unrelated uncommitted WIP in the tree (notes editor, a stray pdf, `prisma/seed/demo-defense-extra.ts`); never `git add -A`/`git add .`.
- Cache Components: the project layout already does dynamic reads (`getAuthContext`, `prisma`) at the top without a Suspense boundary — this is the established pattern for that file. Follow it (await the classification there too); do NOT restructure the layout into Suspense.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/classification/rank.ts`, `format.ts` | Pure level helpers | Make `ClassificationLevel` import type-only (client-safe) |
| `src/components/security/classification-chip.tsx` | Small inline level chip (client-safe, presentational) | Create |
| `src/components/security/classification-banner.tsx` | Prominent project banner; suppressed for PUBLIC/UNCLASSIFIED | Create |
| `src/app/(dashboard)/[orgSlug]/projects/[projectKey]/layout.tsx` | Mounts the banner for all project pages | Modify |
| `src/lib/cache/queries.ts` | Add `classificationLevel` to `ProjectRollup` via one batched read | Modify |
| `src/components/projects/project-card.tsx` | Render the chip on cards + table rows | Modify |
| `package.json` | Minor version bump (user-visible feature) | Modify |

---

## Task 1: Make the pure classification modules client-safe

**Files:**
- Modify: `src/lib/classification/rank.ts` (line 1)
- Modify: `src/lib/classification/format.ts` (line 1)

`ClassificationLevel` is used only as a **type** in both files (in `Record<…>`, array, and signatures — never as a runtime value). Making the import type-only guarantees `@prisma/client` is never pulled into a client bundle that imports these modules.

- [ ] **Step 1: Edit `rank.ts` import**

Change line 1 of `src/lib/classification/rank.ts` from:
```ts
import { ClassificationLevel } from "@prisma/client";
```
to:
```ts
import type { ClassificationLevel } from "@prisma/client";
```

- [ ] **Step 2: Edit `format.ts` import**

Change line 1 of `src/lib/classification/format.ts` from:
```ts
import { ClassificationLevel } from "@prisma/client";
```
to:
```ts
import type { ClassificationLevel } from "@prisma/client";
```

- [ ] **Step 3: Verify the lib still passes**

Run: `npx vitest run src/lib/classification/`
Expected: PASS — 3 files, 20 tests. (Behavior is unchanged; this is a build-boundary refactor. The client-safety itself is verified later by Tasks 4–5 compiling cleanly.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/classification/rank.ts src/lib/classification/format.ts
git commit -m "refactor(classification): type-only level import in pure modules (client-safe)"
```

---

## Task 2: `ClassificationChip` component

**Files:**
- Create: `src/components/security/classification-chip.tsx`
- Test: `src/components/security/classification-chip.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/security/classification-chip.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClassificationChip } from "./classification-chip";

describe("ClassificationChip", () => {
  it("renders the level label when there are no markings", () => {
    render(<ClassificationChip level="CUI" />);
    expect(screen.getByText("CUI")).toBeTruthy();
  });

  it("includes control markings when provided", () => {
    render(<ClassificationChip level="CUI" markings={["NOFORN"]} />);
    expect(screen.getByText("CUI//NOFORN")).toBeTruthy();
  });

  it("applies the per-level color class", () => {
    render(<ClassificationChip level="CONFIDENTIAL" />);
    expect(screen.getByText("CONFIDENTIAL").className).toContain("red");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/security/classification-chip.test.tsx`
Expected: FAIL — cannot resolve `./classification-chip`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/security/classification-chip.tsx`:

```tsx
import { cn } from "@/lib/utils";
import { bannerColor, formatMarking } from "@/lib/classification/format";
import type { ClassificationLevel } from "@prisma/client";

/**
 * Small inline classification chip. Presentational and client-safe: imports only
 * the pure formatter modules (no Prisma), so it can be rendered inside client
 * components like the project card.
 */
export function ClassificationChip({
  level,
  markings = [],
  className,
}: {
  level: ClassificationLevel;
  markings?: string[];
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        bannerColor(level),
        className,
      )}
    >
      {formatMarking(level, markings)}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/security/classification-chip.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/security/classification-chip.tsx src/components/security/classification-chip.test.tsx
git commit -m "feat(classification): ClassificationChip presentational component"
```

---

## Task 3: `ClassificationBanner` component

**Files:**
- Create: `src/components/security/classification-banner.tsx`
- Test: `src/components/security/classification-banner.test.tsx`

The banner shows the descriptive sentence + handling instructions, color-coded, but is **suppressed (renders null) for PUBLIC/UNCLASSIFIED** to avoid banner fatigue on routine projects (threshold = FOUO).

- [ ] **Step 1: Write the failing test**

Create `src/components/security/classification-banner.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ClassificationLevel } from "@prisma/client";
import { ClassificationBanner } from "./classification-banner";

function eff(
  level: ClassificationLevel,
  markings: string[] = [],
  handlingInstructions = "",
) {
  return { level, markings, handlingInstructions, source: "project" as const };
}

describe("ClassificationBanner", () => {
  it("renders nothing for UNCLASSIFIED", () => {
    const { container } = render(
      <ClassificationBanner classification={eff("UNCLASSIFIED")} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for PUBLIC", () => {
    const { container } = render(
      <ClassificationBanner classification={eff("PUBLIC")} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the descriptive sentence for CUI with markings", () => {
    render(<ClassificationBanner classification={eff("CUI", ["NOFORN"])} />);
    expect(
      screen.getByText("Highest classification for this project: CUI//NOFORN"),
    ).toBeTruthy();
  });

  it("shows handling instructions when present", () => {
    render(
      <ClassificationBanner
        classification={eff("CONFIDENTIAL", [], "Store in approved enclave")}
      />,
    );
    expect(screen.getByText("— Store in approved enclave")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/security/classification-banner.test.tsx`
Expected: FAIL — cannot resolve `./classification-banner`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/security/classification-banner.tsx`. Note the handling instructions are rendered as a single template-literal text node (so the test's `getByText` matches one node):

```tsx
import { cn } from "@/lib/utils";
import { ShieldAlert } from "lucide-react";
import {
  bannerColor,
  describeClassification,
} from "@/lib/classification/format";
import { rankOf } from "@/lib/classification/rank";
import type { EffectiveClassification } from "@/lib/classification/effective";

/** Below this rank (FOUO) a project is routine — no prominent banner. */
const BANNER_THRESHOLD = rankOf("FOUO");

/**
 * Prominent project classification banner. Client-safe: imports only the pure
 * formatter/rank modules plus a type-only `EffectiveClassification`.
 */
export function ClassificationBanner({
  classification,
}: {
  classification: EffectiveClassification;
}) {
  const { level, markings, handlingInstructions } = classification;
  if (rankOf(level) < BANNER_THRESHOLD) return null;

  return (
    <div
      role="note"
      aria-label="Project classification"
      className={cn(
        "flex flex-wrap items-center gap-2 px-4 py-1.5 text-xs font-semibold",
        bannerColor(level),
      )}
    >
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{describeClassification(level, markings)}</span>
      {handlingInstructions ? (
        <span className="font-normal opacity-80">{`— ${handlingInstructions}`}</span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/security/classification-banner.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/security/classification-banner.tsx src/components/security/classification-banner.test.tsx
git commit -m "feat(classification): ClassificationBanner (suppressed below FOUO)"
```

---

## Task 4: Mount the banner in the project layout

**Files:**
- Modify: `src/app/(dashboard)/[orgSlug]/projects/[projectKey]/layout.tsx`

The layout already loads `ctx` and `project` and renders a header followed by the board tabs. Add the banner between them. No unit test (server layout); verified by `tsc` + the suite.

- [ ] **Step 1: Add imports**

At the top of `layout.tsx`, after the existing `import { ProjectBoardTabs } from "./board-tabs";` line, add:

```ts
import { effectiveClassification } from "@/lib/classification/effective";
import { ClassificationBanner } from "@/components/security/classification-banner";
```

- [ ] **Step 2: Resolve the classification after the project is loaded**

Immediately after the `if (!project) notFound();` line, add:

```ts
  const classification = await effectiveClassification(ctx.orgId, project.id);
```

- [ ] **Step 3: Render the banner between the header and the tabs**

In the returned JSX, locate the closing `</div>` of the "Project header" block (the one right before the `{/* Board tabs */}` comment) and insert the banner immediately after it, so the structure reads:

```tsx
      {/* Project header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        {/* …unchanged header content… */}
      </div>

      <ClassificationBanner classification={classification} />

      {/* Board tabs */}
      <ProjectBoardTabs
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If it OOMs, rerun with `NODE_OPTIONS=--max_old_space_size=4096 npx tsc --noEmit`.) Confirm no `@prisma/client`-in-client-bundle error is reported for the banner import.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/layout.tsx"
git commit -m "feat(classification): show classification banner on all project pages"
```

---

## Task 5: Project card + table classification chip

**Files:**
- Modify: `src/lib/cache/queries.ts` (the `ProjectRollup` interface ~line 72 and `getActiveProjectsForOrg` ~lines 109–235)
- Modify: `src/components/projects/project-card.tsx` (`ProjectCardProject` ~line 48; card chips row ~line 226; table name cell ~line 563)

The cards are fed by the cached `getActiveProjectsForOrg`. Add the effective level per project via ONE extra batched query (all the org's classification rows), then compute in memory with the Phase 1 `effectiveCeiling`.

> **Known limitation (document, don't silently cap):** `getActiveProjectsForOrg` is `"use cache"` with `cacheLife("minutes")` tagged `org:${orgId}:projects`. Classification changes are NOT wired to revalidate that tag, so a card chip may lag a classification change by up to a few minutes. The prominent **banner** (Task 4) is computed live and is always current. Add `revalidateTag(\`org:${orgId}:projects\`)` to the classification mutation routes as a follow-up if immediate chip freshness is required.

- [ ] **Step 1: Add the import + extend the `ProjectRollup` type in `queries.ts`**

Add to the imports near the top of `src/lib/cache/queries.ts`:

```ts
import { effectiveCeiling } from "@/lib/classification/effective";
import type { ClassificationLevel } from "@prisma/client";
```

In the `ProjectRollup` interface, add a field after `nextDueDate`:

```ts
  /** Effective classification = max(org-wide floor, this project's level). */
  classificationLevel: ClassificationLevel;
```

- [ ] **Step 2: Add the batched classification query**

In `getActiveProjectsForOrg`, change the `Promise.all` destructuring line from:

```ts
  const [totals, dones, nextDues, activeCycles, leadMembers] =
    await Promise.all([
```
to:
```ts
  const [totals, dones, nextDues, activeCycles, leadMembers, classRows] =
    await Promise.all([
```

Then add this query as the **last element** of that `Promise.all([...])` array — i.e. immediately after the closing `}),` of the `prisma.projectMember.findMany({…})` block and before the `]);`:

```ts
      // All classification rows for the org (org-wide floor + per-project).
      prisma.dataClassification.findMany({
        where: { orgId },
        select: { projectId: true, level: true },
      }),
```

- [ ] **Step 3: Build the per-project lookup**

After the existing `const leadByProject = …` map construction (just before `return projects.map<ProjectRollup>(...)`), add:

```ts
  const orgFloor =
    classRows.find((c) => c.projectId === null)?.level ?? "UNCLASSIFIED";
  const classByProject = new Map<string, ClassificationLevel>();
  for (const c of classRows) {
    if (c.projectId) classByProject.set(c.projectId, c.level);
  }
```

- [ ] **Step 4: Populate the field in the returned object**

In the `return projects.map<ProjectRollup>((p) => { … return { … } })` object, add after `nextDueDate: nextDueByProject.get(p.id) ?? null,`:

```ts
      classificationLevel: effectiveCeiling(orgFloor, classByProject.get(p.id) ?? null),
```

- [ ] **Step 5: Extend `ProjectCardProject` + render the chip**

In `src/components/projects/project-card.tsx`:

(a) Add the chip import after the existing `Badge` import (around line 23):
```ts
import { ClassificationChip } from "@/components/security/classification-chip";
import type { ClassificationLevel } from "@prisma/client";
```

(b) Add the field to the `ProjectCardProject` interface (after `nextDueDate`):
```ts
  classificationLevel: ClassificationLevel;
```

(c) In the card's status-chips row, render the chip first. Change:
```tsx
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Badge variant={progressVariant(project.percentComplete)}>
```
to:
```tsx
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <ClassificationChip level={project.classificationLevel} />
              <Badge variant={progressVariant(project.percentComplete)}>
```

(d) In the table name cell, render the chip after the project name. Change:
```tsx
                  <span className="truncate font-medium">{p.name}</span>
                  {p.archived && (
```
to:
```tsx
                  <span className="truncate font-medium">{p.name}</span>
                  <ClassificationChip level={p.classificationLevel} />
                  {p.archived && (
```

- [ ] **Step 6: Verify**

Run: `npx vitest run src/components/security/` (the chip/banner tests still pass) and `npx tsc --noEmit` (no type errors — `ProjectRollup` now satisfies `ProjectCardProject`; no client-bundle Prisma error).
Expected: tests PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cache/queries.ts src/components/projects/project-card.tsx
git commit -m "feat(classification): classification chip on project cards + table"
```

---

## Task 6: Version bump (user-visible feature)

**Files:**
- Modify: `package.json` (+ `package-lock.json`)

Phase 2 ships visible UI, so per `AGENTS.md` this is a **minor** bump (current `3.36.4` → `3.37.0`). No git tag on a feature branch.

- [ ] **Step 1: Bump**

Run: `npm version minor --no-git-tag-version`
Expected: prints `v3.37.0`; `package.json` `version` is now `3.37.0`.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(release): 3.37.0 — project classification banner + card chips"
```

---

## Self-Review

**Spec coverage (spec §6 Phase 2 + §4.3 display split + §12):**
- Banner on board view AND empty state → Task 4 mounts in the shared layout, covering both (and all sub-pages) ✓
- Level chip on project cards → Task 5 (card grid + table) ✓
- Suppress prominent banner for PUBLIC/UNCLASSIFIED → Task 3 (`BANNER_THRESHOLD = rankOf("FOUO")`) ✓
- Descriptive in-app banner vs formal marking → banner uses `describeClassification`; chip uses `formatMarking` ✓
- Server-side fetch of effective classification → Task 4 (layout) + Task 5 (cache query) ✓
- Reuse the Settings color palette → via `bannerColor` (Phase 1, already synced) ✓
- Version bump → Task 6 ✓
- Deferred/documented (not built here): cache revalidation on classification change (Task 5 note); per-doc/attachment classification (Phases 4–5).

**Placeholder scan:** none — every step has exact code/commands/expected output.

**Type consistency:** `classificationLevel: ClassificationLevel` is added to BOTH `ProjectRollup` (queries.ts) and `ProjectCardProject` (project-card.tsx) so the page's `projects={getActiveProjectsForOrg(...)}` assignment stays valid. `ClassificationChip` prop `level: ClassificationLevel` matches. `ClassificationBanner` consumes `EffectiveClassification` (type-only import) which matches `effectiveClassification`'s return. `effectiveCeiling(orgFloor, level | null)` matches its Phase 1 signature `(ClassificationLevel, ClassificationLevel | null | undefined)`.

**Client-safety check:** every client-reachable import (`classification-chip.tsx`, `classification-banner.tsx`, `project-card.tsx`) uses only `@/lib/classification/format` + `@/lib/classification/rank` (pure) and type-only `@prisma/client` / `effective` imports — never the barrel or a runtime `effective.ts` import. Task 1 makes the pure modules' level import type-only to guarantee this.
