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
