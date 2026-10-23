import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** The ways a module can write `work_items` rows without the writer. */
const DIRECT_WRITE = new RegExp(
  [
    // Through the client: prisma.workItem.update(…), tx.workItem.createMany(…).
    String.raw`\.workItem\.(?:update|updateMany|create|createMany|upsert)\s*\(`,
    // Raw SQL, quoted or schema-qualified: UPDATE "public"."work_items" …
    String.raw`\b(?:UPDATE|INSERT\s+INTO)\s+(?:"?\w+"?\.)?"?work_items"?(?:\s|$)`,
    // Raw SQL against a table chosen at runtime: UPDATE "${table}" …
    String.raw`\b(?:UPDATE|INSERT\s+INTO)\s+"?\$\{`,
    // A nested write through a relation: project.update({ data: { workItems: { updateMany … } } }).
    String.raw`\bworkItems\s*:\s*\{\s*(?:create|createMany|connectOrCreate|update|updateMany|upsert|set|connect|disconnect|delete|deleteMany)\b`,
    // The delegate itself handed on (aliased, wrapped), where its writes can no longer be seen.
    String.raw`\b(?:prisma|tx|db|client|trx)\.workItem\b(?!\s*\.)`,
  ].join("|"),
  "i",
);

/** The module every write goes through. */
const WRITER = "src/lib/work-items/write.server.ts";

const ALLOWED = new Set([
  WRITER,
  // Writes only the `embedding` vector column, for any embeddable table.
  // Search data, not item state: no status, no history.
  "src/lib/rag/embed.ts",
  // Hands `prisma.workItem` to its mention lookup, which only calls findMany.
  "src/lib/mentions/registry.server.ts",
]);

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

// `plugins/` holds composed plugins when present (it is absent in a core checkout).
const roots = ["src", ...(existsSync("plugins") ? ["plugins"] : [])];
const files = new Map(roots.flatMap((r) => sourceFiles(r)).map((f) => [f, readFileSync(f, "utf8")]));

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
      ["f.ts", 'await db.$executeRaw`UPDATE "public"."work_items" SET x = 1`'],
      ["g.ts", 'await db.$executeRawUnsafe(`UPDATE "${table}" SET x = 1`)'],
      ["h.ts", "await tx.project.update({ where, data: { workItems: { updateMany: { where: {}, data: {} } } } })"],
      ["i.ts", "await tx.interval.update({ where, data: { workItems: { set: [] } } })"],
      ["j.ts", "const items = tx.workItem; await items.update({})"],
      // Reads, and a relation field on a loaded row, are not writes.
      ["k.ts", "await prisma.workItem.findMany({})"],
      ["l.ts", "const linked = links.map((l) => l.workItem)"],
      ["m.ts", "include: { workItems: { select: { id: true } } }"],
    ]);
    expect(offenders(planted, DIRECT_WRITE, new Set())).toEqual([
      "a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts", "j.ts",
    ]);
  });
});
