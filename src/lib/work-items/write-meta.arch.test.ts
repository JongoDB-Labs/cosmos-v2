import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Every write through the single writer says who made it.
 *
 * The primitives record each change in the domain-event outbox with an actor
 * and a source. Their `meta` argument is optional, but only so the private
 * plugins composed into the product keep compiling against them (they record
 * as PLUGIN). Inside this repository a missing `meta` would silently file a
 * person's edit as a plugin's, so every call here must pass it. Parsed with the
 * TypeScript compiler, not matched by regex: a call's arguments can span lines
 * and nest other calls.
 */

/** Each primitive and how many arguments a call must pass for `meta` to be one of them. */
export const META_ARITY: Readonly<Record<string, number>> = {
  createWorkItemRow: 3,
  updateWorkItems: 4,
  updateWorkItemsUnchecked: 4,
  rebuildTagMirror: 3,
  recomputeTagMirror: 3,
  setWorkItemLabels: 5,
  setLabelsForMany: 5,
};

const ROOT = join(__dirname, "../../..");
const SCAN = ["src", "prisma/seed", "scripts"];

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Calls of a primitive with too few arguments to carry `meta`, as "file:line name". */
export function callsWithoutMeta(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const arity = name ? META_ARITY[name] : undefined;
      // A spread could carry anything; none of these are called that way.
      const line = () => `${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${name}`;
      // A test of the plugin form itself says so on the line above.
      const marked = (() => {
        const n = sf.getLineAndCharacterOfPosition(node.getStart()).line;
        return n > 0 && source.split("\n")[n - 1].includes("write-meta: plugin form");
      })();
      if (arity !== undefined && !marked && node.arguments.length < arity && !node.arguments.some(ts.isSpreadElement)) {
        found.push(line());
      }
      // The change service takes its actor in the input object: it must name one (null for the system).
      if (name === "applyWorkItemChange") {
        const input = node.arguments[1];
        const named =
          input &&
          (!ts.isObjectLiteralExpression(input) ||
            input.properties.some(
              (p) => ts.isSpreadAssignment(p) || ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === "actor"),
            ));
        if (!named) found.push(line());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("every in-repo write through the single writer names its actor and source", () => {
  it("passes meta on every call", () => {
    const missing = SCAN.flatMap((d) => files(join(ROOT, d)))
      .filter((f) => !f.endsWith("write-meta.arch.test.ts"))
      .flatMap((f) => callsWithoutMeta(readFileSync(f, "utf8"), relative(ROOT, f)));
    expect(missing, "pass a WriteMeta ({ actorId, source }) or RECORDED_BY_CALLER").toEqual([]);
  });

  it("catches the shapes a call takes", () => {
    const planted = `
      await createWorkItemRow(tx, { data });
      await updateWorkItems(
        tx,
        ids.map((i) => i.id),
        { intervalId: null },
      );
      await labels.setWorkItemLabels(tx, orgId, id, names);
      await createWorkItemRow(tx, { data }, { actorId: null, source: "SYSTEM" });
      await updateWorkItemsUnchecked(tx, ids, data, RECORDED_BY_CALLER);
      // write-meta: plugin form
      await createWorkItemRow(tx, { data });
      await applyWorkItemChange(tx, { actorId, orgId, projectId, itemIds, patch, source: "API" });
      await applyWorkItemChange(tx, { actorId, orgId, projectId, itemIds, patch, source: "SYSTEM", actor: null });
    `;
    expect(callsWithoutMeta(planted, "x.ts")).toEqual([
      "x.ts:2 createWorkItemRow",
      "x.ts:3 updateWorkItems",
      "x.ts:8 setWorkItemLabels",
      "x.ts:13 applyWorkItemChange",
    ]);
  });
});
