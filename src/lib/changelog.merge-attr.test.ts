/**
 * `src/lib/changelog.ts` must NOT have a union merge driver.
 *
 * ## The defect this guards, in full
 *
 * On 2026-09-15 `.gitattributes` gained `src/lib/changelog.ts merge=union`, to
 * stop a long-lived branch colliding with every release that landed while it
 * sat. The reasoning sounded right — the changelog is append-only and sorted at
 * runtime, so two branches adding entries "have no reason to conflict" — and the
 * comment asserted it was "safe for ADDING entries".
 *
 * It is not safe, and it broke a release the next day.
 *
 * `merge=union` operates on LINES with no notion of nesting. Both sides insert
 * immediately after `const RELEASES: Release[] = [`, and the two inserted blocks
 * share many identical lines (`    version: "…",`, `    date: "…",`, `      {`,
 * `        kind: "fix",`). Git aligns on those shared lines, so the union keeps
 * one entry's opening brace and the other entry's closing brace and splices them:
 *
 *       {
 *         kind: "improvement",
 *         text: "…",
 *     version: "2.372.6",        <- the NEXT entry begins mid-object
 *
 * From there the array is unbalanced. Measured on `auto/COSMOS-176` vs `main`:
 *
 *     git merge-file          → exit 1, 1 conflict marker    (wanted)
 *     git merge-file --union  → exit 0, silently corrupt     (what shipped)
 *
 * ## Why it is HARMFUL rather than merely useless
 *
 * By exiting 0, union hides the file from `git diff --name-only --diff-filter=U`.
 * The ship path's `resolveMechanicalRebase` only resolves files that appear
 * there — and `src/lib/changelog.ts` is in `VERSION_RACE_TRIO`, so a real
 * conflict is handled correctly: take main's copy, re-apply the branch's entry
 * via `prependChangelogEntry`, which is valid TypeScript by construction.
 *
 * Union replaced a conflict the machine resolves correctly with a corruption
 * nothing catches until the post-rebase typecheck — the LAST gate before merge,
 * which reports a cluster of TS1005s near the END of the array, far from the
 * damage. COSMOS-176 parked on exactly that:
 *
 *     COSMOS-176 approve → merge FAILED (post-rebase typecheck failed …
 *     src/lib/changelog.ts(6076,42): error TS1005: ',' expected.)
 *
 * ## Why this test asserts the PROPERTY, not the line
 *
 * Re-adding the driver under a glob (`*.ts merge=union`, `src/lib/* merge=union`)
 * would re-create the defect while leaving any exact-line assertion green. So
 * this parses the attribute file and rejects a union driver on ANY pattern that
 * could match a TypeScript source file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ATTR = join(process.cwd(), ".gitattributes");

/** `[pattern, attrs]` for each non-comment, non-blank rule. */
function rules(src: string): Array<{ pattern: string; attrs: string[] }> {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => {
      const [pattern, ...attrs] = l.split(/\s+/);
      return { pattern, attrs };
    });
}

describe(".gitattributes", () => {
  it("exists and is readable — anti-vacuity for everything below", () => {
    // Without this, deleting the file would make every assertion below pass.
    expect(existsSync(ATTR), ".gitattributes is gone — that is itself a change worth reviewing").toBe(true);
    expect(readFileSync(ATTR, "utf8").length).toBeGreaterThan(200);
  });

  it("applies NO union merge driver to any TypeScript path", () => {
    // THE REGRESSION, as a property over every pattern rather than the one line
    // that was wrong. `*.ts`, `src/lib/*`, and the bare path all re-create it.
    const offenders = rules(readFileSync(ATTR, "utf8"))
      .filter((r) => r.attrs.some((a) => a === "merge=union"))
      .filter((r) => /\.ts$|\*$|^\*|\/$/.test(r.pattern) || r.pattern.endsWith(".ts"))
      .map((r) => `${r.pattern} ${r.attrs.join(" ")}`);
    expect(
      offenders,
      `union merge on TypeScript splices object literals together — see this file's header: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });

  it("names changelog.ts, so the reasoning is not lost to a silent deletion", () => {
    // ANTI-VACUITY partner: the test above also passes against an EMPTY file.
    // The whole value here is the recorded reasoning, so require it to survive.
    const src = readFileSync(ATTR, "utf8");
    expect(src).toContain("src/lib/changelog.ts");
    expect(src).toMatch(/merge-file --union/);
  });
});
