import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Work items have ONE writer: `write.server.ts`, which only the change service
 * may use for status fields.
 *
 * Seven write paths each used to carry their own copy of what a status change
 * does, and they disagreed: a bulk move stamped no dates and wrote no history,
 * the assistant decided "done" from the column's spelling, and the Kanban-only
 * guards were skipped by everything else. Moving them onto
 * `applyWorkItemChange` fixed that once; this test keeps it fixed, because the
 * next route that reaches for `prisma.workItem.update` would quietly start an
 * eighth.
 *
 * The workflow engine and automations build on this: a transition rule or an
 * outbox event is only enforced if no write can go around it.
 */

/** Direct row writes, through the client or raw SQL. */
const DIRECT_WRITE = /\.workItem\.(?:update|updateMany|create|createMany|upsert)\s*\(|\b(?:UPDATE|INSERT\s+INTO)\s+"?work_items\b/i;

/** The module every write goes through. */
const WRITER = "src/lib/work-items/write.server.ts";

/** Test-only fixture helper: never reaches a build. */
const ALLOWED = new Set([WRITER, "src/lib/testing/db-fixtures.ts"]);

/** May write status fields without a transition: the change service itself, and
 *  an import restoring another system's recorded state. */
const UNCHECKED_CALLERS = new Set([
  "src/lib/work-items/apply-change.server.ts",
  "src/lib/import/import-engine.ts",
]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(relative(process.cwd(), full));
    }
  }
  return acc;
}

/** `src/…` paths whose source matches `pattern`, minus `allowed`. */
function offenders(files: Map<string, string>, pattern: RegExp, allowed: Set<string>): string[] {
  return [...files].filter(([path, src]) => !allowed.has(path) && pattern.test(src)).map(([path]) => path);
}

const files = new Map(sourceFiles("src").map((f) => [f, readFileSync(f, "utf8")]));

describe("work items have a single writer", () => {
  it("no module outside write.server.ts writes work_items rows directly", () => {
    expect(offenders(files, DIRECT_WRITE, ALLOWED)).toEqual([]);
  });

  it("only the change service and the import write status fields unchecked", () => {
    expect(offenders(files, /\bupdateWorkItemsUnchecked\b/, new Set([WRITER, ...UNCHECKED_CALLERS]))).toEqual([]);
  });

  it("recognises the writes it guards against", () => {
    // The guard is only as good as its pattern: prove it fires on each shape.
    const planted = new Map([
      ["a.ts", "await prisma.workItem.update({ where: { id } })"],
      ["b.ts", "await tx.workItem.updateMany({ where: {} })"],
      ["c.ts", "await db.workItem.create({ data })"],
      ["d.ts", "await tx.workItem.upsert({})"],
      ["e.ts", "await db.$executeRaw`UPDATE work_items SET tags = '{}'`"],
      ["f.ts", "await prisma.workItem.findMany({})"],
    ]);
    expect(offenders(planted, DIRECT_WRITE, new Set())).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });
});
