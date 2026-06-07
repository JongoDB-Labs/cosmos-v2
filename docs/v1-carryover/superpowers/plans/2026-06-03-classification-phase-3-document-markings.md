# Classification Phase 3 — Generated-Document Markings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp the org's effective classification as a formal marking on generated documents — a centered header/footer banner on every page of the contract PDF, a leading marking row on CSV exports, and a `classification` field on the JSON export.

**Architecture:** A single pure policy helper `documentMarking(level, markings)` decides *whether and what* to stamp (returns the formal `formatMarking` string at/above FOUO, else null — matching the in-app banner's suppression threshold). The contract PDF generator gains an optional `classificationMarking` and stamps it top+bottom of every page via PDFKit buffered pages. The contract PDF route and the two export routes resolve the **org-wide** effective classification (contracts/exports are org-scoped — no project) and feed the helper.

**Tech Stack:** TypeScript, PDFKit (server-externalized), Prisma 6, Vitest 4 (node env for PDF/Prisma-touching tests).

---

## Conventions for the executor (read first)

- Branch `feat/classification-propagation` (already checked out). Phases 1–2 are committed: `src/lib/classification/` lib (`rank.ts`, `format.ts`, `effective.ts`) + the project banner/chips.
- Test runner Vitest 4: `npm test` = `vitest run`; single file `npx vitest run <path>`. PDF/Prisma-touching test files need `// @vitest-environment node` at line 1.
- `effectiveClassification(orgId)` (NO projectId) returns the **org-wide** effective classification — that's what contracts and exports use (both are org-scoped; `Contract` has no `projectId`).
- These routes are server-only; importing `@/lib/classification/effective` (which imports Prisma) is fine here.
- Commit after EACH task with the exact message. Husky lint-staged may reformat staged files — fine. Stage only listed files; never `git add -A`/`git add .` (unrelated WIP exists in the tree).
- TDD where a unit test is specified; route wiring (Tasks 3–5) is verified by `npx tsc --noEmit` (route handlers need heavy request mocking, so no unit test — the tested logic lives in `documentMarking`).

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/classification/format.ts` | + `documentMarking(level, markings)` policy helper | Modify |
| `src/lib/classification/format.test.ts` | + tests for `documentMarking` | Modify |
| `src/lib/pdf/contract.ts` | + `classificationMarking` field; stamp top/bottom every page | Modify |
| `src/lib/pdf/contract.test.ts` | Smoke test: valid PDF buffer with/without marking | Create |
| `src/app/api/v1/orgs/[orgId]/contracts/[contractId]/pdf/route.ts` | Resolve org marking → pass to generator | Modify |
| `src/app/api/v1/orgs/[orgId]/export/csv/[entity]/route.ts` | Prepend marking row when classified | Modify |
| `src/app/api/v1/orgs/[orgId]/export/json/route.ts` | Add `classification` field | Modify |
| `package.json` | Minor bump 3.37.0 → 3.38.0 | Modify |

---

## Task 1: `documentMarking` policy helper

**Files:**
- Modify: `src/lib/classification/format.ts`
- Modify: `src/lib/classification/format.test.ts`

A generated document is stamped only when its level is at/above FOUO (same threshold as the in-app banner) — routine/unclassified output is left unmarked.

- [ ] **Step 1: Add the failing tests**

Append to `src/lib/classification/format.test.ts` — first extend the import on line 2, then add the describe block. Change the import line:
```ts
import { formatMarking, describeClassification, bannerColor } from "./format";
```
to:
```ts
import {
  formatMarking,
  describeClassification,
  bannerColor,
  documentMarking,
} from "./format";
```
Then add this block before the final closing `});` of the file (i.e., as a new top-level `describe`):
```ts
describe("documentMarking", () => {
  it("returns null below the FOUO threshold", () => {
    expect(documentMarking("PUBLIC")).toBeNull();
    expect(documentMarking("UNCLASSIFIED", ["IGNORED"])).toBeNull();
  });

  it("returns the formal marking at or above FOUO", () => {
    expect(documentMarking("FOUO")).toBe("FOUO");
    expect(documentMarking("CUI", ["NOFORN"])).toBe("CUI//NOFORN");
    expect(documentMarking("CONFIDENTIAL")).toBe("CONFIDENTIAL");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/classification/format.test.ts`
Expected: FAIL — `documentMarking` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/classification/format.ts`, add an import of `rankOf` at the top (after the existing `import type` line):
```ts
import { rankOf } from "./rank";
```
Then append this function at the end of the file:
```ts
/**
 * Formal marking for a GENERATED document, or null when the level is routine
 * (below FOUO) — same suppression threshold as the in-app banner, so unmarked
 * orgs don't get "UNCLASSIFIED" stamped on every export.
 */
export function documentMarking(
  level: ClassificationLevel,
  markings: string[] = [],
): string | null {
  return rankOf(level) >= rankOf("FOUO") ? formatMarking(level, markings) : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/classification/format.test.ts`
Expected: PASS (the original formatting tests + 2 new `documentMarking` tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/classification/format.ts src/lib/classification/format.test.ts
git commit -m "feat(classification): documentMarking policy helper (stamp at/above FOUO)"
```

---

## Task 2: Stamp the marking on the contract PDF

**Files:**
- Modify: `src/lib/pdf/contract.ts`
- Create: `src/lib/pdf/contract.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `src/lib/pdf/contract.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { generateContractPdf } from "./contract";

function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

describe("generateContractPdf", () => {
  it("produces a valid PDF buffer with no marking", async () => {
    const buf = await generateContractPdf({ title: "Test", partyName: "Acme" });
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("produces a valid PDF buffer when a classification marking is stamped", async () => {
    const buf = await generateContractPdf({
      title: "Test",
      partyName: "Acme",
      classificationMarking: "CUI//NOFORN",
    });
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/pdf/contract.test.ts`
Expected: FAIL — the second test passes a `classificationMarking` field that the `ContractPdfInput` type does not yet accept (TS error / compile failure). (If PDFKit cannot initialize under vitest at all — both tests error on import — report DONE_WITH_CONCERNS with the error; we will fall back to build + manual verification and drop this test file.)

- [ ] **Step 3: Implement — replace the file contents**

Replace the entire contents of `src/lib/pdf/contract.ts` with:
```ts
import PDFDocument from "pdfkit";

export interface ContractPdfInput {
  title: string;
  partyName: string;
  partyEmail?: string | null;
  value?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  body?: string | null;
  signedAt?: Date | null;
  /**
   * Formal classification banner (e.g. "CUI//NOFORN"). When set, stamped
   * centered at the top and bottom of every page. Null/undefined = unmarked.
   */
  classificationMarking?: string | null;
}

export function generateContractPdf(input: ContractPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      bufferPages: true,
    });

    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(input.title, { align: "center" });
    doc.moveDown(1);
    doc
      .fontSize(10)
      .fillColor("#666")
      .text(`Generated ${new Date().toISOString()}`, { align: "center" });
    doc.moveDown(2);
    doc.fontSize(11).fillColor("black");

    const meta: [string, string][] = [
      ["Party", input.partyName],
      ["Email", input.partyEmail ?? "—"],
      ["Value", input.value != null ? `$${input.value.toLocaleString()}` : "—"],
      ["Start", input.startDate ? input.startDate.toLocaleDateString() : "—"],
      ["End", input.endDate ? input.endDate.toLocaleDateString() : "—"],
      [
        "Status",
        input.signedAt ? `Signed ${input.signedAt.toLocaleDateString()}` : "Unsigned",
      ],
    ];
    for (const [k, v] of meta) {
      doc.font("Helvetica-Bold").text(`${k}: `, { continued: true });
      doc.font("Helvetica").text(v);
    }

    doc.moveDown(2);
    doc.font("Helvetica").fontSize(11).text(input.body ?? "");

    // Formal marking: stamp centered at top + bottom of EVERY page. Requires
    // bufferPages:true so all pages exist before we iterate them.
    const marking = input.classificationMarking;
    if (marking) {
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.font("Helvetica-Bold").fontSize(8).fillColor("black");
        doc.text(marking, 0, 36, {
          align: "center",
          width: doc.page.width,
          lineBreak: false,
        });
        doc.text(marking, 0, doc.page.height - 48, {
          align: "center",
          width: doc.page.width,
          lineBreak: false,
        });
      }
    }

    doc.end();
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/pdf/contract.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf/contract.ts src/lib/pdf/contract.test.ts
git commit -m "feat(classification): stamp classification banner on contract PDF pages"
```

---

## Task 3: Wire the marking into the contract PDF route

**Files:**
- Modify: `src/app/api/v1/orgs/[orgId]/contracts/[contractId]/pdf/route.ts`

- [ ] **Step 1: Add imports**

After the existing `import { generateContractPdf } from "@/lib/pdf/contract";` line, add:
```ts
import { effectiveClassification } from "@/lib/classification/effective";
import { documentMarking } from "@/lib/classification/format";
```

- [ ] **Step 2: Resolve the org marking and pass it to the generator**

After the `if (!contract) return new Response("Contract not found", { status: 404 });` line, add:
```ts
    const eff = await effectiveClassification(ctx.orgId);
    const classificationMarking = documentMarking(eff.level, eff.markings);
```
Then in the `generateContractPdf({ ... })` call, add this property to the object (e.g. after the `signedAt:` line):
```ts
      classificationMarking,
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/v1/orgs/[orgId]/contracts/[contractId]/pdf/route.ts"
git commit -m "feat(classification): mark contract PDFs with the org classification"
```

---

## Task 4: Marking row on CSV exports

**Files:**
- Modify: `src/app/api/v1/orgs/[orgId]/export/csv/[entity]/route.ts`

- [ ] **Step 1: Add imports**

After the existing `import { toCSV } from "@/lib/export/csv";` line, add:
```ts
import { effectiveClassification } from "@/lib/classification/effective";
import { documentMarking } from "@/lib/classification/format";
```

- [ ] **Step 2: Prepend the marking row when classified**

Replace these two lines:
```ts
    const rows = await fetcher(ctx.orgId);
    const csv = toCSV(rows as Record<string, unknown>[]);
```
with:
```ts
    const rows = await fetcher(ctx.orgId);
    const eff = await effectiveClassification(ctx.orgId);
    const marking = documentMarking(eff.level, eff.markings);
    const body = toCSV(rows as Record<string, unknown>[]);
    const csv = marking ? `CLASSIFICATION: ${marking}\n${body}` : body;
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors. (The `new NextResponse(csv, …)` return is unchanged — `csv` is still the string returned.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/v1/orgs/[orgId]/export/csv/[entity]/route.ts"
git commit -m "feat(classification): mark CSV exports with a leading classification row"
```

---

## Task 5: `classification` field on the JSON export

**Files:**
- Modify: `src/app/api/v1/orgs/[orgId]/export/json/route.ts`

- [ ] **Step 1: Add imports**

After the existing `import { checkRateLimit } from "@/lib/rate-limit/guard";` line, add:
```ts
import { effectiveClassification } from "@/lib/classification/effective";
import { documentMarking } from "@/lib/classification/format";
```

- [ ] **Step 2: Add the field to the export object**

Immediately before the `const data = {` line, add:
```ts
    const eff = await effectiveClassification(ctx.orgId);
```
Then in the `data` object, add this line right after `exportedAt: new Date().toISOString(),`:
```ts
      classification: documentMarking(eff.level, eff.markings),
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/v1/orgs/[orgId]/export/json/route.ts"
git commit -m "feat(classification): add classification field to JSON export"
```

---

## Task 6: Version bump

**Files:**
- Modify: `package.json` (+ `package-lock.json`)

New feature → **minor** bump (3.37.0 → 3.38.0).

- [ ] **Step 1: Bump**

Run: `npm version minor --no-git-tag-version`
Expected: prints `v3.38.0`.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(release): 3.38.0 — classification markings on generated documents"
```

---

## Self-Review

**Spec coverage (spec §6 Phase 3 + §4.3):**
- `formatMarking` stamped as PDF header/footer on every page → Tasks 1–3 ✓
- Same marking on CSV (leading row) and JSON (field) exports → Tasks 4–5 ✓
- Formal centered marking (not the descriptive sentence) → uses `formatMarking` via `documentMarking` ✓
- Org-scoped resolution (contracts/exports have no project) → `effectiveClassification(ctx.orgId)` ✓
- Threshold consistency with the banner (suppress below FOUO) → `documentMarking` ✓
- Version bump → Task 6 ✓

**Placeholder scan:** none — full code + commands + expected output in every step.

**Type consistency:** `documentMarking(level: ClassificationLevel, markings?: string[]): string | null` is used identically in Tasks 3/4/5; `classificationMarking?: string | null` on `ContractPdfInput` matches what `documentMarking` returns and what the route passes; `effectiveClassification(orgId)` (no projectId) returns `EffectiveClassification` whose `.level`/`.markings` feed `documentMarking`.

**Decisions to surface at review:**
- The FOUO threshold means UNCLASSIFIED/no-config orgs get **no** marking on PDFs/exports (consistent with the banner). A formal-marking purist might want "UNCLASSIFIED" stamped explicitly — that's a one-line change in `documentMarking` if desired.
- The CSV leading `CLASSIFICATION: …` line precedes the header row, so a strict re-import would need to skip line 1. This is the documented trade-off of marking a CSV; the JSON export carries the marking as structured data instead.
