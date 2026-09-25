// The `docs/v1-carryover/` plans are executable instructions: they are written to
// be handed to an agentic worker task-by-task, so a wrong line in one of them is
// not a stale comment — it is a defect with a delay on it, and the worker that
// trips over it will do exactly what it was told. Four such lines shipped at
// cutover: a plan that told the executor NOT to restructure a layout into
// Suspense (Cache Components forbids the dynamic read it asked for), a page
// snippet that awaited `params` at the top of the default export, a convention
// bullet asserting `OrgMember.permissions` is `BigInt` (it is decimal-string
// TEXT), and a "component smoke test" that never rendered its component.
//
// Source-level rather than behavioural because these docs have no runtime: the
// text as written IS the artifact. Follows the existing *.arch.test.ts pattern
// (see src/lib/compliance/classification.arch.test.ts, which asserts on
// schema.prisma for the same reason).
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const CARRYOVER = join(ROOT, "docs/v1-carryover");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(full);
    return e.isFile() && e.name.endsWith(".md") ? [full] : [];
  });
}

const docs = markdownFiles(CARRYOVER).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));

/** Files whose text matches, as repo-relative paths. */
function offenders(re: RegExp): string[] {
  return docs.filter((d) => re.test(d.text)).map((d) => d.path);
}

describe("carry-over plans do not instruct violations of AGENTS.md", () => {
  it("finds the carry-over plans at all", () => {
    // Guards the guard: if the directory moves, every assertion below starts
    // passing vacuously and this test says so.
    expect(docs.length).toBeGreaterThan(8);
    expect(docs.map((d) => d.path)).toContain("docs/v1-carryover/README.md");
  });

  it("never claims a permission mask is BigInt", () => {
    // AGENTS.md: masks are decimal-string TEXT (`permissions String @default("0")`)
    // and cross the DB boundary via maskFromDb()/maskToDb(). An executor told
    // "permissions is BigInt" writes `BigInt(row.permissions)`, which throws on
    // the bits >= 63 the bitfield actually assigns.
    expect(offenders(/permissions`?\s+is\s+BigInt/i)).toEqual([]);
  });

  it("never tells the executor to skip a Suspense boundary", () => {
    // AGENTS.md: "No dynamic API reads outside a <Suspense> boundary." Matches a
    // negated instruction to INTRODUCE one ("do NOT restructure … into Suspense"),
    // not a negated instruction to read outside one ("do NOT await X at the top …
    // fetch it inside a Suspense-wrapped child"), which is the correct advice.
    expect(
      offenders(
        /(?:do\s+NOT|don't|never)\s+(?:restructure|refactor|wrap|move|put|add|introduce)[^.\n]*Suspense/i,
      ),
    ).toEqual([]);
  });

  it("never awaits params at the top of a page's default export", () => {
    // AGENTS.md: "Pages that `await params` at the top break instant validation.
    // Pass `params` as a Promise into a Suspense child." A synchronous default
    // export is the tell that the pattern was followed.
    expect(offenders(/export default async function \w*Page\b/)).toEqual([]);
  });

  it("bumps the version with release:bump, not npm version", () => {
    // AGENTS.md: `npm version` skips the special staging the composed-plugin tree
    // needs, and a bump with no same-commit changelog entry fails CI's Config
    // assertions job. CLEANUP-2 fixed phases 2 and 5; phases 3 and 4 were outside
    // its scope and are the known remainder. Tighten this list, never grow it.
    expect(offenders(/npm version (?:major|minor|patch)\b/).sort()).toEqual([
      "docs/v1-carryover/superpowers/plans/2026-06-03-classification-phase-3-document-markings.md",
      "docs/v1-carryover/superpowers/plans/2026-06-03-classification-phase-4-chat-attachments.md",
    ]);
  });
});

describe("carry-over plan test steps are not vacuous", () => {
  /** Each `Create \`src/components/…/x.test.tsx\`` step paired with its code fence. */
  const snippets = docs.flatMap((d) => {
    const re =
      /Create `src\/components\/[\w-]+\/([\w-]+)\.test\.tsx`:?\s*\n+```tsx\n([\s\S]*?)\n```/g;
    return [...d.text.matchAll(re)].map((m) => ({
      doc: d.path,
      component: m[1]
        .split("-")
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join(""),
      body: m[2],
    }));
  });

  it("finds the prescribed component tests at all", () => {
    expect(snippets.length).toBeGreaterThanOrEqual(4);
  });

  it("every prescribed component test renders the component it names", () => {
    // AGENTS.md: "A test that passes either way is worse than no test, because it
    // reads as coverage." A component test that only re-asserts a pure helper
    // already covered elsewhere passes unchanged even if the component is deleted.
    const vacuous = snippets
      .filter((s) => !s.body.includes(s.component) || !s.body.includes("render("))
      .map((s) => `${s.doc} → ${s.component}`);
    expect(vacuous).toEqual([]);
  });
});

describe("carry-over plans for features v2 already shipped are deleted", () => {
  // docs/v1-carryover/README.md: "When a carried plan is implemented in v2, fold
  // it into a fresh docs/superpowers doc and delete the carry-over copy."
  const plans = docs
    .map((d) => d.path)
    .filter((p) => p.includes("/superpowers/plans/"));

  it("has no bank-feeds import/inbox plan, because src/lib/bank ships both", () => {
    const shipped = [
      "src/lib/bank/import.ts",
      "src/lib/bank/reconcile.ts",
      "src/components/banking/banking-inbox.tsx",
    ].filter((f) => existsSync(join(ROOT, f)));
    // Guards the guard: if the implementation is ever removed, the plans become
    // forward-looking again and this assertion must not silently keep passing.
    expect(shipped).toHaveLength(3);
    expect(plans.filter((p) => /bank-feeds-2[ab]-/.test(p))).toEqual([]);
  });

  it("does not describe shipped bank feeds as absent from src/", () => {
    const readme = docs.find((d) => d.path === "docs/v1-carryover/README.md");
    expect(readme?.text).not.toMatch(/no bank-feeds UI\/logic/);
  });
});
