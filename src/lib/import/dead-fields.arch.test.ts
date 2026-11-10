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

  /**
   * INVERTED on 2026-11-10, when `programEvent` arrived: `created_by_id` is NOT
   * NULL on `program_events`, so the engine needs the acting user and the old
   * rule ("carries no userId, and the route passes none") was pinning the
   * absence of something now required. A context field nothing SUPPLIES is as
   * dead as one nothing reads, so the rule is kept and points the other way —
   * and at both doors, not just the one that prompted it.
   */
  it("EntityEngineCtx carries a userId, and both import routes pass one", () => {
    const engine = read("src/lib/import/entity-import.ts");
    const ctxBlock = engine.slice(
      engine.indexOf("export interface EntityEngineCtx"),
      engine.indexOf("}", engine.indexOf("export interface EntityEngineCtx")),
    );
    expect(ctxBlock).toMatch(/userId:\s*string/);
    for (const route of [
      "src/app/api/v1/orgs/[orgId]/projects/[projectId]/import/route.ts",
      "src/app/api/v1/orgs/[orgId]/import/entities/route.ts",
    ]) {
      const src = read(route);
      expect(src, `${route} calls the engine`).toMatch(/runEntityImport\(/);
      // Scoped to the engine CALL, not the file: the org route also hands a
      // userId to a plugin's writer, which would satisfy a file-wide match
      // while the engine itself got none.
      expect(src, `${route} passes the acting user to the engine`).toMatch(
        /runEntityImport\(\s*\{[^}]*userId:\s*ctx\.userId/,
      );
    }
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
    programEvent: [
      "category", // name → EventCategory, stored as categoryId (created if new)
      "owner", // name → Team or OrgMember, stored as ownerTeamId / ownerMemberId
      "deliverable", // title → Deliverable, stored as deliverableId
    ],
  };
  // Keys that are COMPOSED into a column rather than being one. Listed per key,
  // not per entity, so the rest of the entity's fields stay checked: these four
  // columns plus `allDay` and `timeZone` become `starts_at` / `ends_at` in
  // `program-calendar/import.ts`, which is also why they are `text` and not
  // `date` (a calendar date must not acquire the server's zone).
  const DERIVED: Record<string, readonly string[]> = {
    programEvent: ["startDate", "endDate", "startTime", "endTime"],
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
      const exempt = new Set([...(LOOKUP_ONLY[key] ?? []), ...(DERIVED[key] ?? [])]);

      const dead = def.fields.map((f) => f.key).filter((k) => !exempt.has(k) && !columns.includes(k));

      expect(
        dead,
        `${key} import offers field(s) that are not columns on ${model}. Either the column was dropped by a migration and the import field must go too, or it belongs in LOOKUP_ONLY / DERIVED with a note saying what it resolves to.`,
      ).toEqual([]);
    },
  );

  /**
   * The exemptions are a HOLE in the rule above, so they are pinned too.
   *
   * An exemption that names a field nobody reads re-opens exactly the defect
   * this file exists to stop — a column offered in the wizard and written
   * nowhere — and it would never fail, because the rule skips it by design.
   * Every exempt key must therefore (a) still be a field on that entity and
   * (b) be read by name in the server code that resolves or composes it.
   */
  it("every LOOKUP_ONLY / DERIVED exemption is a field something actually reads", () => {
    // Comments stripped first: a scan that reads prose certifies the very
    // sentence explaining a field, which is how a source-scanning guard passes
    // over its own removal.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const readers = [
      "src/lib/import/entity-import.ts",
      "src/lib/program-calendar/import.ts",
    ].map((f) => stripComments(read(f))).join("\n");

    const stale: string[] = [];
    for (const [entityKey, keys] of Object.entries({ ...LOOKUP_ONLY, ...DERIVED })) {
      const def = ENTITY_DEFS.find((d) => d.key === entityKey);
      for (const k of keys) {
        if (!def?.fields.some((f) => f.key === k)) stale.push(`${entityKey}.${k}: not a field`);
        // Quoted, because that is how the engine reads a mapped cell:
        // s(fields, "partnerName"), text(fields, "startDate"), fields.category…
        else if (!readers.includes(`"${k}"`)) stale.push(`${entityKey}.${k}: read by nothing`);
      }
    }
    expect(stale, `exemptions that no longer describe anything:\n${stale.join("\n")}`).toEqual([]);
  });
});

/**
 * Every `enumSynonyms` target names a declared value of that field's enum.
 *
 * The same blind spot as the dead column above, one level in: a synonym mapping
 * to a label the enum does not have type-checks clean (it is a
 * `Record<string, string>`), passes any test that only exercises the synonyms
 * it knows about, and then fails at the database with "Invalid value for
 * argument" on whichever row happens to use it.
 */
describe("enum synonyms name real enum values", () => {
  const withSynonyms = ENTITY_DEFS.flatMap((e) =>
    e.fields.filter((f) => f.enumSynonyms).map((f) => [`${e.key}.${f.key}`, f] as const),
  );

  it("has synonyms to check", () => {
    // Guards the guard: with none declared the rule below is vacuous, and would
    // stay green through the first wrong one anybody adds.
    expect(withSynonyms.length).toBeGreaterThan(0);
  });

  it.each(withSynonyms)("%s: every synonym maps to one of its enum's values", (_name, field) => {
    const declared = field.enum ?? [];
    const bad = Object.entries(field.enumSynonyms ?? {})
      .filter(([, label]) => !declared.includes(label))
      .map(([from, label]) => `"${from}" -> ${label}`);
    expect(
      bad,
      `maps source text to a value this field's enum does not declare:\n${bad.join("\n")}`,
    ).toEqual([]);
  });

  it("declares enumSynonyms only on enum fields", () => {
    // `coerceField` reads them in the `enum` branch only, so one declared
    // anywhere else is silently ignored.
    const misplaced = ENTITY_DEFS.flatMap((e) =>
      e.fields.filter((f) => f.enumSynonyms && f.kind !== "enum").map((f) => `${e.key}.${f.key}`),
    );
    expect(misplaced).toEqual([]);
  });
});

/**
 * Every enum ImportField offers EXACTLY the values its Prisma enum declares.
 *
 * The describe above checks that each `enumSynonyms` target is a value of the field's own
 * `enum` literal — it never asks whether that literal is COMPLETE. So an incomplete one is
 * self-consistent and passes everything: `CYCLE_KIND` listed seven of `IntervalKind`'s
 * eight values, omitting `PROGRAM_INCREMENT`, and the interval importer therefore could not
 * import a Program Increment at all. Nothing failed; the value simply was not on offer.
 *
 * tsc cannot see it either — these are `string[]`, not `IntervalKind[]`, because the module
 * is imported by a client component and so must not pull the Prisma runtime into the
 * browser bundle. That is exactly when the rule belongs in an arch test: the constraint is
 * real, the compiler is structurally unable to check it, and the cost of being wrong is a
 * feature that silently does not exist.
 *
 * Reads the schema rather than a second hand-kept list, for the same reason as the column
 * rule above.
 */
describe("enum import fields match their Prisma enum exactly", () => {
  const MODEL_FOR: Record<string, string> = { vendor: "Contract" };

  /** The Prisma enum NAME backing `model.field`, or null when the field is not an enum. */
  function enumNameFor(model: string, field: string): string | null {
    const schema = read("prisma/schema.prisma");
    const block = schema.match(new RegExp(`^model ${model} \\{\\n([\\s\\S]*?)^\\}`, "m"));
    if (!block) throw new Error(`model ${model} not found in schema.prisma`);
    const decl = block[1].match(new RegExp(`^\\s{2}${field}\\s+(\\w+)`, "m"));
    if (!decl) return null;
    const type = decl[1];
    return new RegExp(`^enum ${type} \\{`, "m").test(schema) ? type : null;
  }

  function enumValues(name: string): string[] {
    const schema = read("prisma/schema.prisma");
    const block = schema.match(new RegExp(`^enum ${name} \\{\\n([\\s\\S]*?)^\\}`, "m"));
    if (!block) throw new Error(`enum ${name} not found in schema.prisma`);
    // Values only: skip comment lines, which several of these enums carry.
    return [...block[1].matchAll(/^\s{2}(\w+)\s*$/gm)].map((m) => m[1]);
  }

  const enumFields = ENTITY_DEFS.flatMap((e) =>
    e.fields.filter((f) => f.kind === "enum").map((f) => [`${e.key}.${f.key}`, e.key, f] as const),
  );

  it("has enum fields to check", () => {
    // Guards the guard: the rule below is an equality over a discovered list, and a list
    // that discovers nothing passes it forever.
    expect(enumFields.length).toBeGreaterThan(3);
  });

  it.each(enumFields)("%s: offers exactly its schema enum's values", (name, entityKey, field) => {
    const model = MODEL_FOR[entityKey] ?? entityKey.charAt(0).toUpperCase() + entityKey.slice(1);
    const enumName = enumNameFor(model, field.key);
    if (!enumName) return; // not schema-enum-backed (a free-text or derived field)

    const declared = [...(field.enum ?? [])].sort();
    const actual = [...enumValues(enumName)].sort();
    expect(
      declared,
      `${name} offers a different value set than Prisma's ${enumName}.\n` +
        `missing (cannot be imported): ${actual.filter((v) => !declared.includes(v)).join(", ") || "none"}\n` +
        `extra (will fail at the database): ${declared.filter((v) => !actual.includes(v)).join(", ") || "none"}`,
    ).toEqual(actual);
  });
});
