// Six built-in sector templates shipped `enabledFeatures` keys that were not
// real settings — "risk", "decision", "meeting_note". The project settings PUT
// filters anything outside TOGGLEABLE_FEATURES, so those flags were written to
// the template, handed to every project created from it, and silently did
// nothing: the promised board tab simply never appeared.
//
// project-features.ts makes divergence between the two feature LISTS a compile
// error, but the sector seeds hand out plain `string[]`, so nothing stops the
// same dead key being reintroduced there. That is the recurrence this guards.
//
// Source-level rather than importing the templates: they are module-private
// consts (only `seedX` is exported), and the literal as written in the file is
// exactly what ships. Follows the existing *.arch.test.ts pattern.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TOGGLEABLE_FEATURES } from "@/lib/project-features";

const SECTORS_DIR = join(process.cwd(), "prisma/seed/sectors");

/** Every `enabledFeatures: [...]` literal in a file, as string arrays. */
function enabledFeatureLiterals(source: string): string[][] {
  const out: string[][] = [];
  const re = /enabledFeatures:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(
      m[1]
        .split(",")
        .map((s) => s.trim().replace(/^["'`]|["'`]$/g, ""))
        .filter(Boolean),
    );
  }
  return out;
}

const sectorFiles = readdirSync(SECTORS_DIR).filter((f) => f.endsWith(".ts"));

describe("sector templates only enable features that exist", () => {
  it("finds the sector seed files at all", () => {
    // A rename would otherwise make every assertion below vacuously pass.
    expect(sectorFiles.length).toBeGreaterThanOrEqual(6);
  });

  it.each(sectorFiles)("%s hands out only real feature keys", (file) => {
    const source = readFileSync(join(SECTORS_DIR, file), "utf8");
    const literals = enabledFeatureLiterals(source);
    const unknown = literals
      .flat()
      .filter((k) => !(TOGGLEABLE_FEATURES as readonly string[]).includes(k));

    // Named so the failure says WHICH key in WHICH template is dead.
    expect(unknown, `dead feature key(s) in ${file}`).toEqual([]);
  });

  it("rejects a key that only looks plausible", () => {
    // Proves the matcher would actually catch a regression rather than passing
    // because the regex found nothing. "risk" is the real historical culprit —
    // the register key is "risk-register", so bare "risk" reads as valid.
    const fake = `enabledFeatures: ["goal", "risk", "meeting_note"],`;
    const unknown = enabledFeatureLiterals(fake)
      .flat()
      .filter((k) => !(TOGGLEABLE_FEATURES as readonly string[]).includes(k));
    expect(unknown).toEqual(["risk", "meeting_note"]);
  });
});
