// Third in the trio that guards the hand-testing checklists, and separate only
// because the repair protocol forbids editing a sibling test to extend it — fold
// this into validation-docs-claims.arch.test.ts when someone is free to touch
// both. The axis here is the HTTP VERB a step attributes to a route.
//
// Repointing the Phase 5c embed-on-write steps off the retired legacy token-bag
// column introduced a fresh false step in the same breath: the replacement said a
// note update re-embeds "via PATCH", and
// src/app/api/v1/orgs/[orgId]/notes/[noteId]/route.ts exports GET, PUT and DELETE
// — no PATCH at all. A tester would have sent one, got 405, and recorded that
// embed-on-update is broken when it is not. Checking the deleted claim is not the
// same as checking the one written to replace it, so the rule is derived from the
// routes that actually embed.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PLAN = "docs/AI-CHAT-TEST-PLAN.md";
const plan = readFileSync(join(ROOT, PLAN), "utf8");

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, acc);
    else if (name === "route.ts") acc.push(p);
  }
  return acc;
}

/** table → the HTTP methods exported by the API routes that embed that table. */
function embedVerbsByTable(): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  for (const file of routeFiles(join(ROOT, "src/app"))) {
    const src = readFileSync(file, "utf8");
    const tables = [...src.matchAll(/storeEmbedding\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    if (!tables.length) continue;
    const verbs = [...src.matchAll(/^export async function ([A-Z]+)\b/gm)].map((m) => m[1]);
    for (const t of tables) {
      byTable.set(t, new Set([...(byTable.get(t) ?? []), ...verbs]));
    }
  }
  return byTable;
}

/** The "Embed-on-write" subsection of the Phase 5c plan, row by row. */
function embedRows(): string[] {
  const section = plan.match(/### Embed-on-write\n([\s\S]*?)\n### /)?.[1] ?? "";
  return section.split("\n").filter((l) => /^\| 5c\.\d/.test(l));
}

const VERB = /\b(GET|POST|PUT|PATCH|DELETE)\b/g;

describe("embed-on-write steps name verbs the embedding routes export", () => {
  const byTable = embedVerbsByTable();
  const rows = embedRows();
  const everyEmbedVerb = new Set([...byTable.values()].flatMap((s) => [...s]));

  it("finds the embedding routes and the steps at all", () => {
    // Guards the guard: if storeEmbedding moves out of the route layer, or the
    // subsection is renamed, every assertion below passes vacuously.
    expect([...byTable.keys()].sort()).toEqual(["notes", "work_items"]);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // The specific fact the bad step got wrong, asserted directly so this test
    // starts failing the day a PATCH handler is genuinely added.
    expect(byTable.get("notes")).toContain("PUT");
    expect(byTable.get("notes")).not.toContain("PATCH");
  });

  it("every verb the subsection names is exported by a route that embeds", () => {
    const offenders = rows.flatMap((row) =>
      [...row.matchAll(VERB)].map((m) => m[1]).filter((v) => !everyEmbedVerb.has(v)),
    );
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("a row that names its table only names verbs that table's route exports", () => {
    // Sharper where the row is specific: `SELECT … FROM notes` binds the row to
    // the notes route, so POST/PUT must come from that route, not from any route
    // that happens to embed something.
    const offenders = rows.flatMap((row) => {
      const table = row.match(/FROM\s+"?(\w+)"?/)?.[1];
      const verbs = byTable.get(table ?? "");
      if (!verbs) return [];
      return [...row.matchAll(VERB)]
        .map((m) => m[1])
        .filter((v) => !verbs.has(v))
        .map((v) => `${table}: ${v}`);
    });
    expect([...new Set(offenders)]).toEqual([]);
  });
});
