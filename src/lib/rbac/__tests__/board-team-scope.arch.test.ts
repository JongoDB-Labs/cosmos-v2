// @vitest-environment node
//
// Every surface that reads boards must apply the TEAM axis.
//
// The rule, not the call sites. `visibleBoards` was correct from the day it
// shipped and was called by exactly ONE of the five places that reach a board;
// the other four returned another team's board in full. Re-fixing those four is
// worth little on its own, because the sixth surface — whoever adds one next —
// has nothing stopping it repeating the same omission.
//
// So this scans for board reads and fails when one is not accompanied by the
// shared helper. Exemptions are BY NAME with a reason, never a silent pass:
// a blanket skip would make this file read as coverage while catching nothing.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** Reading boards in a way that could disclose one. */
const READS_BOARDS = /prisma\.board\.(findMany|findFirst|findUnique)/;

/**
 * Any of the shared helpers — all of them forward to `visibleBoards`.
 *
 * The trailing `\(` is load-bearing: matching the bare name also matched the
 * IMPORT line, so a file that imported the helper and never called it passed.
 * Caught by mutation — deleting the call from the boards list route left the
 * import behind and this rule stayed green.
 */
const APPLIES_TEAM_GATE = /\b(narrowBoards|isBoardVisible|requireBoardRead|visibleBoards)\s*\(/;

/**
 * Files that read boards WITHOUT the team gate, on purpose.
 *
 * Both analytics routes select `{ id: true }` only, to look up the board's
 * COLUMN keys so work items can be classified done / in-progress. They never
 * expose a board's name, and never break results down per board.
 *
 * Narrowing them by team would be actively wrong, not merely unnecessary: a
 * project's completion percentage would change depending on which teams the
 * viewer belongs to, so two people would read different numbers off the same
 * project. Team scoping governs which boards you can OPEN, not which work
 * counts toward a rollup.
 */
const ALLOWED: Record<string, string> = {
  "app/api/v1/orgs/[orgId]/analytics/portfolio/route.ts":
    "reads board ids only, to resolve column semantics for a project-level rollup; narrowing would make completion % differ per viewer",
  "app/api/v1/orgs/[orgId]/analytics/projects/[projectId]/route.ts":
    "reads board ids only, to resolve column semantics for a project-level rollup; narrowing would make completion % differ per viewer",
  "lib/templates/slugify.ts":
    "uniqueBoardSlug reads existing slugs to avoid a collision when CREATING a board; it returns a slug, never board data, and the caller has already passed the create gate",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("board team-scoping is applied wherever boards are read", () => {
  const offenders: { file: string }[] = [];

  for (const file of walk(SRC)) {
    const body = readFileSync(file, "utf8");
    if (!READS_BOARDS.test(body)) continue;

    const rel = file.slice(SRC.length + 1).split(/[\\/]/).join("/");
    if (rel in ALLOWED) continue;
    if (APPLIES_TEAM_GATE.test(body)) continue;

    offenders.push({ file: rel });
  }

  it("has no board read that skips the team gate", () => {
    expect(
      offenders.map((o) => o.file),
      "These files read boards without narrowBoards/isBoardVisible/requireBoardRead. " +
        "Either apply the gate, or add the file to ALLOWED with the reason it is safe.",
    ).toEqual([]);
  });

  it("keeps the allowlist honest — every entry still reads boards", () => {
    // An allowlist entry that no longer reads boards is dead, and dead
    // exemptions are how a real one gets added later without anyone noticing.
    const stale = Object.keys(ALLOWED).filter((rel) => {
      const full = join(SRC, ...rel.split("/"));
      try {
        return !READS_BOARDS.test(readFileSync(full, "utf8"));
      } catch {
        return true; // file gone
      }
    });

    expect(stale, "stale allowlist entries — remove them").toEqual([]);
  });
});
