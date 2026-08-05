import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the schema against silently re-acquiring a classification default.
 *
 * The original bug was invisible precisely because it lived in a default: no
 * code wrote `classification`, so no code review would ever surface it, and
 * every commercial tenant's records read CUI on screen. A future model added by
 * copy-paste from Risk or Deliverable would reintroduce it just as quietly.
 *
 * This asserts on the schema text rather than the generated client because the
 * default is a schema-level artifact — it has no runtime representation to
 * assert against until a row already exists with the wrong marking on it.
 */

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

/**
 * CONTROLLED markings assert that handling restrictions apply. Defaulting to
 * one claims an authority the tenant may not hold. UNCLASSIFIED and PUBLIC
 * assert the opposite — no restriction — so defaulting to those is harmless and
 * is deliberately NOT forbidden here (`Document.classificationLevel` and
 * `DataClassification.level` both do it legitimately).
 */
const CONTROLLED = ["CUI", "FOUO", "CONFIDENTIAL"];

describe("classification is opt-in at the schema level", () => {
  it("no model defaults a classification to a CONTROLLED marking", () => {
    const offenders = schema
      .split("\n")
      .filter((l) =>
        CONTROLLED.some((m) =>
          new RegExp(`ClassificationLevel\\s+@default\\(${m}\\)`).test(l),
        ),
      )
      .map((l) => l.trim());
    expect(offenders).toEqual([]);
  });

  it("still covers the four PM register models it was written for", () => {
    // Guards the guard: if these models are renamed away, the assertions above
    // start passing vacuously and this test says so.
    for (const model of ["Risk", "Deliverable", "Blocker", "ChangeRequest"]) {
      const block = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0];
      expect(block, `model ${model} not found`).toBeDefined();
      expect(block).toMatch(/classification\s+ClassificationLevel\?/);
    }
  });
});
