import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITY_DEFS } from "./entity-fields";
import { TARGET_FIELDS } from "./work-item-fields";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * The import contracts describe UI and plumbing that must actually exist.
 * Each of these properties/comments outlived the thing it described — a field
 * nothing renders reads as a feature, and a comment nothing enforces reads as
 * a guarantee. Guard the removals so they don't grow back.
 */
describe("import field contracts carry nothing dead", () => {
  it("TARGET_FIELDS entries expose only id + label", () => {
    const extras = TARGET_FIELDS.flatMap((t) =>
      Object.keys(t)
        .filter((k) => k !== "id" && k !== "label")
        .map((k) => `${t.id}.${k}`),
    );
    expect(
      extras,
      `hint/valueMapped/unique are read nowhere — the wizard renders only t.label and hardcodes its value-mapped targets:\n${extras.join("\n")}`,
    ).toEqual([]);
  });

  it("no ImportField declares a hint — the generic wizard renders none", () => {
    const withHint = ENTITY_DEFS.flatMap((e) =>
      e.fields.filter((f) => "hint" in f).map((f) => `${e.key}.${f.key}`),
    );
    expect(withHint).toEqual([]);
  });

  it("EntityEngineCtx carries no userId, and the import route passes none", () => {
    const engine = read("src/lib/import/entity-import.ts");
    const ctxBlock = engine.slice(
      engine.indexOf("export interface EntityEngineCtx"),
      engine.indexOf("}", engine.indexOf("export interface EntityEngineCtx")),
    );
    expect(ctxBlock).not.toMatch(/userId/);
    expect(
      read("src/app/api/v1/orgs/[orgId]/projects/[projectId]/import/route.ts"),
    ).not.toMatch(/userId:\s*ctx\.userId/);
  });

  it("the parent-link cycle guard is described as a cycle, not an interval", () => {
    expect(read("src/lib/import/import-engine.ts")).not.toMatch(/in-batch interval/);
  });

  it("parseWorkbook does not promise whitespace collapsing it never does", () => {
    // flattenHeader collapses HEADER cells only; data cells stay byte-for-byte.
    expect(read("src/lib/import/parse-file.ts")).not.toMatch(/internal whitespace collapsed/);
  });
});

/**
 * Every ImportField key names a real column on its model.
 *
 * This file exists to stop dead import fields, and it did not stop one. It
 * checked `hint` properties, a `userId` absence and three comment wordings —
 * never the thing in the name. `Deliverable.branch_owner` was dropped by
 * migration 20260812093000; `entity-fields.ts` kept offering users a "Branch
 * owner" column to map and `entity-import.ts` kept writing it, so EVERY
 * deliverable import failed with `Unknown argument 'branchOwner'`.
 *
 * Three things hid it, and the third is why this test is shaped like this:
 *   - `s()` returns NULL when a column is unmapped, not undefined, and Prisma
 *     strips `undefined` but validates `null` — so the dead key rode along on
 *     every row, not just rows that mapped it;
 *   - tsc cannot see it: Prisma's generated XOR input types defeat excess
 *     property checking (see the tsc-is-blind-to-Prisma-selects class);
 *   - the guard that should have caught it was narrower than its own name.
 *
 * So this reads the schema rather than trusting a hand-kept list. The only
 * entries below are a key→model map where the names differ, and the single
 * lookup-only field key that resolves to a relation rather than a column.
 */
describe("import fields name real columns", () => {
  const MODEL_FOR: Record<string, string> = {
    // `vendor` imports subcontract AGREEMENTS, which are Contract rows.
    vendor: "Contract",
  };
  // Keys that are deliberately NOT columns: they are resolved to a relation.
  const LOOKUP_ONLY: Record<string, readonly string[]> = {
    vendor: ["partnerName"], // looked up to Partner, stored as partnerId
  };

  function columnsOf(model: string): string[] {
    const schema = read("prisma/schema.prisma");
    const block = schema.match(new RegExp(`^model ${model} \\{\\n([\\s\\S]*?)^\\}`, "m"));
    if (!block) throw new Error(`model ${model} not found in schema.prisma`);
    return [...block[1].matchAll(/^\s{2}(\w+)\s+\S/gm)].map((m) => m[1]);
  }

  it("has entity definitions to check", () => {
    // Guards the guard: an empty list would make the rule below vacuous, which
    // is how a schema-reading arch rule usually dies.
    expect(ENTITY_DEFS.length).toBeGreaterThan(5);
    expect(ENTITY_DEFS.flatMap((d) => d.fields).length).toBeGreaterThan(40);
  });

  it.each(ENTITY_DEFS.map((d) => [d.key, d] as const))(
    "%s: every field key is a column on its model",
    (key, def) => {
      const model = MODEL_FOR[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
      const columns = columnsOf(model);
      const exempt = new Set(LOOKUP_ONLY[key] ?? []);

      const dead = def.fields.map((f) => f.key).filter((k) => !exempt.has(k) && !columns.includes(k));

      expect(
        dead,
        `${key} import offers field(s) that are not columns on ${model}. Either the column was dropped by a migration and the import field must go too, or it belongs in LOOKUP_ONLY with a note saying what it resolves to.`,
      ).toEqual([]);
    },
  );
});
