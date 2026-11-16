// @vitest-environment node
//
// VERBATIM_REFUSALS is the list of refusals a withheld result may hand the
// model word for word (egress/refusal.ts). It is only right while it equals
// the constant refusals the executors really return:
//  - a constant refusal missing from it reaches the model as "reason withheld",
//    the blind spot this list exists to close;
//  - an entry no executor returns any more is a stale licence, and the place a
//    text built from data would be added "because it is on the list".
// So both directions are checked against the source, not against memory.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VERBATIM_REFUSALS } from "./refusal";

const ROOT = process.cwd();
const EXECUTORS = join(ROOT, "src/lib/ai/executors");
const FILES = [
  ...readdirSync(EXECUTORS)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((f) => join(EXECUTORS, f)),
  join(ROOT, "src/lib/ai/tool-executor.ts"),
];

/** Source with comments stripped, so prose about a refusal is never read as one. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The constant texts returned as `error:`: one complete string literal, with no
 * interpolation, that ends the value (`,` `}` or a line end follows). A
 * concatenation or a template with `${}` is not a constant and is not read.
 */
function constantRefusals(src: string): string[] {
  const out: string[] = [];
  const re = /\berror:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)\s*(?=[,}\n])/g;
  for (const m of code(src).matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const found = new Set(FILES.flatMap((f) => constantRefusals(readFileSync(f, "utf8"))));

describe("the refusals a withheld result may pass word for word", () => {
  it("reads the executors (guards the guard)", () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(found.has("Project not found")).toBe(true);
    expect(found.has("Insufficient permissions")).toBe(true);
  });

  it("the scanner reads a constant, and never a concatenation or an interpolation", () => {
    const sample = [
      `return { error: "Team not found" };`,
      `return { error: 'Goal not found', x: 1 };`,
      "return { error: `Meeting not found` };",
      "return { error: `Work item \"${title}\" is archived` };",
      `return { error: "That person " + name + " is not here" };`,
      `return {\n  error: "Deleting it needs an admin. " +\n    "Archive it instead." };`,
      `// return { error: "a comment, not a refusal" };`,
    ].join("\n");
    expect(constantRefusals(sample)).toEqual(["Team not found", "Goal not found", "Meeting not found"]);
  });

  it("every constant refusal an executor returns is on the list", () => {
    const missing = [...found].filter((t) => !VERBATIM_REFUSALS.has(t)).sort();
    expect(
      missing,
      "add these to VERBATIM_REFUSALS in egress/refusal.ts, or a withheld result tells the model only that the reason was withheld",
    ).toEqual([]);
  });

  it("every entry on the list is a refusal an executor still returns", () => {
    const stale = [...VERBATIM_REFUSALS].filter((t) => !found.has(t)).sort();
    expect(stale, "remove these from VERBATIM_REFUSALS: no executor returns them as a constant").toEqual([]);
  });
});
