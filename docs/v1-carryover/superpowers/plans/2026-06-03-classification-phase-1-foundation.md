# Classification Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `src/lib/classification/` core library (rank, effective-ceiling, banner/marking formatting) and add the missing `Project ↔ DataClassification` Prisma relation — the substrate every later classification phase depends on.

**Architecture:** A small, well-bounded core lib of pure functions (`rank.ts`, `format.ts`) plus one prisma-reading resolver (`effective.ts`), re-exported via a barrel (`index.ts`). No UI in this phase. The spec is `docs/superpowers/specs/2026-06-03-classification-propagation-design.md` (Approach A — marking layer, not access-enforcement).

**Tech Stack:** TypeScript, Prisma 6 (`@prisma/client`), Vitest 4 (`vitest run`, jsdom default env; `// @vitest-environment node` + `vi.hoisted`/`vi.mock` for prisma-dependent tests). Co-located `*.test.ts`.

---

## Conventions for the executor (read first)

- **Test runner:** `npm test` runs `vitest run` over `src/**/*.test.{ts,tsx}`. Run a single file with `npx vitest run src/lib/classification/<file>.test.ts`.
- **Classification levels** come from Prisma: `import { ClassificationLevel } from "@prisma/client"` — it is **both** a TS type and a runtime object (`ClassificationLevel.CUI === "CUI"`), exactly as used in `src/app/api/v1/orgs/[orgId]/classifications/route.ts`. String literals like `"CUI"` are valid `ClassificationLevel` values.
- **Pure-function test files** (`rank.test.ts`, `format.test.ts`) use the default jsdom env — no pragma needed.
- **Prisma-dependent test files** (`effective.test.ts`) MUST start with the `// @vitest-environment node` pragma and mock prisma with the `vi.hoisted` + `vi.mock("@/lib/db/client", …)` pattern (see `src/lib/ai/tool-executor.test.ts` for the canonical example).
- **No version bump in this phase.** Per `AGENTS.md`, bump `package.json` `version` only for *user-visible* changes. Phase 1 is internal substrate with no UI — the bump happens in Phase 2 when the banner ships.
- **Migrations** require a running Postgres and a valid `DATABASE_URL`. Prisma migrate auto-runs `prisma generate`.
- The husky pre-commit hook is non-executable in this environment (git prints a warning and skips it) — that is expected; commits still succeed.

## File structure (locked)

| File | Responsibility |
|---|---|
| `src/lib/classification/rank.ts` | Severity ranking of levels; ceiling/cap helpers (`rankOf`, `maxLevel`, `isAtOrBelow`, `levelsUpTo`) |
| `src/lib/classification/rank.test.ts` | Unit tests for ranking (pure) |
| `src/lib/classification/format.ts` | Banner/marking strings + chip colors (`formatMarking`, `describeClassification`, `bannerColor`) |
| `src/lib/classification/format.test.ts` | Unit tests for formatting (pure) |
| `src/lib/classification/effective.ts` | `effectiveCeiling` (pure) + `effectiveClassification(orgId, projectId)` (reads prisma) |
| `src/lib/classification/effective.test.ts` | Unit tests with mocked prisma (node env) |
| `src/lib/classification/index.ts` | Barrel re-export — the lib's public entry |
| `prisma/schema.prisma` | Add `Project ↔ DataClassification` relation + `@@index([projectId])` |
| `prisma/migrations/<ts>_add_project_classification_relation/` | Generated migration (FK constraint + index) |

---

## Task 1: Ranking core (`rank.ts`)

**Files:**
- Create: `src/lib/classification/rank.ts`
- Test: `src/lib/classification/rank.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/classification/rank.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_RANK,
  ORDERED_LEVELS,
  rankOf,
  maxLevel,
  isAtOrBelow,
  levelsUpTo,
} from "./rank";

describe("classification rank", () => {
  it("orders levels least → most sensitive", () => {
    expect(rankOf("PUBLIC")).toBeLessThan(rankOf("UNCLASSIFIED"));
    expect(rankOf("UNCLASSIFIED")).toBeLessThan(rankOf("FOUO"));
    expect(rankOf("FOUO")).toBeLessThan(rankOf("CUI"));
    expect(rankOf("CUI")).toBeLessThan(rankOf("CONFIDENTIAL"));
  });

  it("spaces ranks by 10 so SECRET/TOP SECRET can be inserted later", () => {
    for (const lvl of ORDERED_LEVELS) {
      expect(CLASSIFICATION_RANK[lvl] % 10).toBe(0);
    }
  });

  it("maxLevel returns the more sensitive level (tie returns either equal)", () => {
    expect(maxLevel("UNCLASSIFIED", "CUI")).toBe("CUI");
    expect(maxLevel("CUI", "FOUO")).toBe("CUI");
    expect(maxLevel("PUBLIC", "PUBLIC")).toBe("PUBLIC");
  });

  it("isAtOrBelow respects the ceiling", () => {
    expect(isAtOrBelow("FOUO", "CUI")).toBe(true);
    expect(isAtOrBelow("CUI", "CUI")).toBe(true);
    expect(isAtOrBelow("CONFIDENTIAL", "CUI")).toBe(false);
  });

  it("levelsUpTo returns allowed dropdown options in order", () => {
    expect(levelsUpTo("FOUO")).toEqual(["PUBLIC", "UNCLASSIFIED", "FOUO"]);
    expect(levelsUpTo("CONFIDENTIAL")).toEqual(ORDERED_LEVELS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/classification/rank.test.ts`
Expected: FAIL — `Failed to resolve import "./rank"` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/classification/rank.ts`:

```ts
import { ClassificationLevel } from "@prisma/client";

/**
 * Severity rank for classification levels. EXPLICIT — do not rely on Prisma enum
 * declaration order. Spaced by 10 so SECRET/TOP SECRET can be inserted later
 * without renumbering. Higher number = more sensitive.
 */
export const CLASSIFICATION_RANK: Record<ClassificationLevel, number> = {
  PUBLIC: 0,
  UNCLASSIFIED: 10,
  FOUO: 20,
  CUI: 30,
  CONFIDENTIAL: 40,
};

/** Levels from least to most sensitive (rank order). */
export const ORDERED_LEVELS: ClassificationLevel[] = [
  "PUBLIC",
  "UNCLASSIFIED",
  "FOUO",
  "CUI",
  "CONFIDENTIAL",
];

export function rankOf(level: ClassificationLevel): number {
  return CLASSIFICATION_RANK[level];
}

/** The higher (more sensitive) of two levels. Ties return `a`. */
export function maxLevel(
  a: ClassificationLevel,
  b: ClassificationLevel,
): ClassificationLevel {
  return rankOf(a) >= rankOf(b) ? a : b;
}

/** True when `level` is at or below `ceiling` (allowed under the ceiling). */
export function isAtOrBelow(
  level: ClassificationLevel,
  ceiling: ClassificationLevel,
): boolean {
  return rankOf(level) <= rankOf(ceiling);
}

/** Allowed levels for a dropdown capped at `ceiling`, least → most sensitive. */
export function levelsUpTo(ceiling: ClassificationLevel): ClassificationLevel[] {
  return ORDERED_LEVELS.filter((l) => isAtOrBelow(l, ceiling));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/classification/rank.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/classification/rank.ts src/lib/classification/rank.test.ts
git commit -m "feat(classification): rank map + ceiling helpers"
```

---

## Task 2: Banner/marking formatting (`format.ts`)

**Files:**
- Create: `src/lib/classification/format.ts`
- Test: `src/lib/classification/format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/classification/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatMarking, describeClassification, bannerColor } from "./format";

describe("classification formatting", () => {
  it("renders the bare level when there are no markings", () => {
    expect(formatMarking("UNCLASSIFIED", [])).toBe("UNCLASSIFIED");
    expect(formatMarking("CUI")).toBe("CUI");
  });

  it("appends control markings after // joined by /", () => {
    expect(formatMarking("CUI", ["NOFORN", "FEDCON"])).toBe("CUI//NOFORN/FEDCON");
  });

  it("upper-cases, trims, and de-dupes markings (order preserved)", () => {
    expect(formatMarking("CUI", [" noforn ", "NOFORN", "fedcon"])).toBe(
      "CUI//NOFORN/FEDCON",
    );
  });

  it("describeClassification wraps the marking in the standard sentence", () => {
    expect(describeClassification("CUI", ["NOFORN"])).toBe(
      "Highest classification for this project: CUI//NOFORN",
    );
  });

  it("bannerColor returns a tailwind class per level", () => {
    expect(bannerColor("CONFIDENTIAL")).toContain("red");
    expect(bannerColor("PUBLIC")).toContain("emerald");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/classification/format.test.ts`
Expected: FAIL — `Failed to resolve import "./format"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/classification/format.ts`. The color map is copied verbatim from
`src/components/security/classification-manager.tsx:69-73` so banners and the Settings
table read identically:

```ts
import { ClassificationLevel } from "@prisma/client";

/**
 * Tailwind chip classes per level — kept in sync with the Settings classification
 * manager (src/components/security/classification-manager.tsx) so banners and the
 * management table read identically.
 */
export const CLASSIFICATION_COLORS: Record<ClassificationLevel, string> = {
  PUBLIC: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  UNCLASSIFIED: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  FOUO: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  CUI: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  CONFIDENTIAL: "bg-red-500/15 text-red-700 dark:text-red-400",
};

export function bannerColor(level: ClassificationLevel): string {
  return CLASSIFICATION_COLORS[level];
}

/**
 * Formal banner-line marking (DoD/CUI Marking Handbook convention): overall level
 * first, control markings after `//` joined by `/`. PUBLIC/UNCLASSIFIED with no
 * markings render the bare level. Markings are trimmed, upper-cased, and de-duped;
 * first-seen order is preserved.
 *   formatMarking("CUI", ["NOFORN","FEDCON"]) => "CUI//NOFORN/FEDCON"
 *   formatMarking("UNCLASSIFIED")             => "UNCLASSIFIED"
 */
export function formatMarking(
  level: ClassificationLevel,
  markings: string[] = [],
): string {
  const clean = Array.from(
    new Set(
      markings.map((m) => m.trim().toUpperCase()).filter((m) => m.length > 0),
    ),
  );
  return clean.length === 0 ? level : `${level}//${clean.join("/")}`;
}

/** Friendly, in-app sentence for the project banner. */
export function describeClassification(
  level: ClassificationLevel,
  markings: string[] = [],
): string {
  return `Highest classification for this project: ${formatMarking(level, markings)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/classification/format.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/classification/format.ts src/lib/classification/format.test.ts
git commit -m "feat(classification): banner/marking formatting + chip colors"
```

---

## Task 3: Effective classification resolver (`effective.ts`)

**Files:**
- Create: `src/lib/classification/effective.ts`
- Test: `src/lib/classification/effective.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/classification/effective.test.ts` (note the node-env pragma + prisma mock,
mirroring `src/lib/ai/tool-executor.test.ts`):

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    dataClassification: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { effectiveCeiling, effectiveClassification } from "./effective";

const ORG = "11111111-1111-1111-1111-111111111111";
const PROJ = "22222222-2222-2222-2222-222222222222";

function row(level: string, markings: string[] = [], handlingInstructions = "") {
  return { level, markings, handlingInstructions };
}

describe("effectiveCeiling", () => {
  it("returns the org floor when there is no project level", () => {
    expect(effectiveCeiling("FOUO")).toBe("FOUO");
    expect(effectiveCeiling("FOUO", null)).toBe("FOUO");
  });

  it("raises to the project level when it is higher", () => {
    expect(effectiveCeiling("UNCLASSIFIED", "CUI")).toBe("CUI");
  });

  it("keeps the org floor when the project level is lower", () => {
    expect(effectiveCeiling("CUI", "FOUO")).toBe("CUI");
  });
});

describe("effectiveClassification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to UNCLASSIFIED when no rows exist", async () => {
    prisma.dataClassification.findFirst.mockResolvedValue(null);
    prisma.dataClassification.findUnique.mockResolvedValue(null);
    const eff = await effectiveClassification(ORG, PROJ);
    expect(eff).toEqual({
      level: "UNCLASSIFIED",
      markings: [],
      handlingInstructions: "",
      source: "default",
    });
  });

  it("uses the project row (and its markings) when at/above the org floor", async () => {
    prisma.dataClassification.findFirst.mockResolvedValue(row("UNCLASSIFIED"));
    prisma.dataClassification.findUnique.mockResolvedValue(
      row("CUI", ["NOFORN"], "Store in approved enclave"),
    );
    const eff = await effectiveClassification(ORG, PROJ);
    expect(eff.level).toBe("CUI");
    expect(eff.markings).toEqual(["NOFORN"]);
    expect(eff.handlingInstructions).toBe("Store in approved enclave");
    expect(eff.source).toBe("project");
  });

  it("falls back to the org floor (and its markings) when higher than the project", async () => {
    prisma.dataClassification.findFirst.mockResolvedValue(row("CUI", ["ORGWIDE"]));
    prisma.dataClassification.findUnique.mockResolvedValue(row("FOUO", ["PROJ"]));
    const eff = await effectiveClassification(ORG, PROJ);
    expect(eff.level).toBe("CUI");
    expect(eff.markings).toEqual(["ORGWIDE"]);
    expect(eff.source).toBe("org");
  });

  it("uses the org row and skips the project query when no projectId is given", async () => {
    prisma.dataClassification.findFirst.mockResolvedValue(row("FOUO"));
    const eff = await effectiveClassification(ORG);
    expect(prisma.dataClassification.findUnique).not.toHaveBeenCalled();
    expect(eff.level).toBe("FOUO");
    expect(eff.source).toBe("org");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/classification/effective.test.ts`
Expected: FAIL — `Failed to resolve import "./effective"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/classification/effective.ts`:

```ts
import { ClassificationLevel } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { maxLevel } from "./rank";

export interface EffectiveClassification {
  level: ClassificationLevel;
  markings: string[];
  handlingInstructions: string;
  /** Which row determined the effective level. */
  source: "project" | "org" | "default";
}

/**
 * The org-wide row is a floor/default; a project row may only raise at/above it.
 * Pure: the higher of the org floor and the (optional) project level.
 */
export function effectiveCeiling(
  orgLevel: ClassificationLevel,
  projectLevel?: ClassificationLevel | null,
): ClassificationLevel {
  return projectLevel ? maxLevel(orgLevel, projectLevel) : orgLevel;
}

/**
 * Resolve a project's effective classification from its project-scoped row (if any)
 * and the org-wide row, defaulting to UNCLASSIFIED. Markings/handling come from the
 * row that set the effective (higher) level; a project tied with the effective level
 * wins over the org row.
 *
 * Uses findFirst for the org-wide row because @@unique([orgId, projectId]) does not
 * constrain rows where projectId IS NULL (Postgres treats NULLs as distinct) — this
 * matches the existing classifications API.
 */
export async function effectiveClassification(
  orgId: string,
  projectId?: string | null,
): Promise<EffectiveClassification> {
  const orgRow = await prisma.dataClassification.findFirst({
    where: { orgId, projectId: null },
  });
  const projectRow = projectId
    ? await prisma.dataClassification.findUnique({
        where: { orgId_projectId: { orgId, projectId } },
      })
    : null;

  if (!orgRow && !projectRow) {
    return {
      level: "UNCLASSIFIED",
      markings: [],
      handlingInstructions: "",
      source: "default",
    };
  }

  const orgLevel: ClassificationLevel = orgRow?.level ?? "UNCLASSIFIED";
  const level = projectRow ? maxLevel(orgLevel, projectRow.level) : orgLevel;

  // Tie (project == effective) goes to the project row's markings/handling.
  const fromProject = projectRow != null && projectRow.level === level;
  const determining = fromProject ? projectRow : (orgRow ?? projectRow!);
  const source: EffectiveClassification["source"] = fromProject
    ? "project"
    : orgRow != null
      ? "org"
      : "project";

  return {
    level,
    markings: determining.markings,
    handlingInstructions: determining.handlingInstructions,
    source,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/classification/effective.test.ts`
Expected: PASS — 7 tests (3 in `effectiveCeiling`, 4 in `effectiveClassification`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/classification/effective.ts src/lib/classification/effective.test.ts
git commit -m "feat(classification): effective-ceiling resolver"
```

---

## Task 4: Barrel export + full lib verification (`index.ts`)

**Files:**
- Create: `src/lib/classification/index.ts`

- [ ] **Step 1: Create the barrel**

Create `src/lib/classification/index.ts`:

```ts
export * from "./rank";
export * from "./format";
export * from "./effective";
```

- [ ] **Step 2: Run the whole classification suite**

Run: `npx vitest run src/lib/classification/`
Expected: PASS — 3 test files, 17 tests total.

- [ ] **Step 3: Typecheck the new library**

Run: `npx tsc --noEmit`
Expected: no errors. (If the process OOMs — the repo has a known tsc-heap sensitivity —
rerun as `NODE_OPTIONS=--max_old_space_size=4096 npx tsc --noEmit`.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/classification/index.ts
git commit -m "feat(classification): barrel export for the core lib"
```

---

## Task 5: `Project ↔ DataClassification` relation + migration

**Files:**
- Modify: `prisma/schema.prisma` (Project model `257-279`; DataClassification model `1093-1108`)
- Create: `prisma/migrations/<timestamp>_add_project_classification_relation/migration.sql` (generated)

**Pre-req:** a running Postgres with a valid `DATABASE_URL` in the environment.

- [ ] **Step 1: Add the back-relation on `Project`**

In `prisma/schema.prisma`, inside `model Project`, add a relation field alongside the
existing relations (e.g., directly after the `projectTemplate` line, before `@@unique`):

```prisma
  projectTemplate ProjectTemplate? @relation(fields: [projectTemplateId], references: [id])
  dataClassification DataClassification?

  @@unique([orgId, key])
  @@map("projects")
```

- [ ] **Step 2: Add the forward relation + FK index on `DataClassification`**

In `model DataClassification`, add the `project` relation and an index on the FK column
(Postgres does not auto-index FK columns; the existing `@@unique([orgId, projectId])`
does not cover lookups/cascades by `projectId` alone):

```prisma
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  project Project? @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@unique([orgId, projectId])
  @@index([projectId])
  @@map("data_classifications")
```

- [ ] **Step 3: Validate the schema**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`.

- [ ] **Step 4: Create + apply the migration**

Run: `npx prisma migrate dev --name add_project_classification_relation`
Expected: a new folder `prisma/migrations/<timestamp>_add_project_classification_relation/`
is created and applied; output ends with `Your database is now in sync with your schema.`
and `Generated Prisma Client`.

- [ ] **Step 5: Verify the generated SQL**

Run: `cat prisma/migrations/*_add_project_classification_relation/migration.sql`
Expected to contain (names may vary slightly) an index and a foreign key with cascade:

```sql
CREATE INDEX "data_classifications_project_id_idx" ON "data_classifications"("project_id");

ALTER TABLE "data_classifications"
  ADD CONSTRAINT "data_classifications_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 6: Confirm the lib still typechecks against the regenerated client**

Run: `npx vitest run src/lib/classification/`
Expected: PASS — 17 tests (the relation does not change the query API `effective.ts` uses;
this confirms the regenerated Prisma Client is consistent).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(classification): Project↔DataClassification relation + FK index"
```

---

## Self-Review

**Spec coverage (Phase 1 scope, spec §4, §5, §6-P1):**
- §4.1 rank map + helpers → Task 1 ✓
- §4.2 `effectiveCeiling` + `effectiveClassification` → Task 3 ✓
- §4.3 `formatMarking` / `describeClassification` / `bannerColor` → Task 2 ✓
- §4.4 unit tests → Tasks 1–3 (TDD throughout) ✓
- §5 `Project ↔ DataClassification` relation → Task 5 ✓
- §6-P1 "no UI" → respected (lib + schema only) ✓
- Deferred to later phases (correctly NOT here): `DOCUMENT_READ/WRITE` bits (P5), banner component (P2), markings on generated docs (P3).

**Placeholder scan:** none — every code/command step shows full content and expected output.

**Type consistency:** `ClassificationLevel` used identically everywhere; `EffectiveClassification` shape (`level`/`markings`/`handlingInstructions`/`source`) matches between `effective.ts` and its test; `maxLevel` signature consistent between `rank.ts` and `effective.ts`; color map matches `classification-manager.tsx`.

**Note for executor:** No `package.json` version bump in this phase (substrate only; bump lands in Phase 2 with the banner).
