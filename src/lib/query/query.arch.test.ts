// Structural guarantees of the CQL layer that no feature test would notice
// going wrong, because every query would still "work".
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SRC = walk("src");
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.includes("__tests__");

describe("CQL architecture", () => {
  it("only execute.server.ts imports the compiler, so nothing can compile without the scope envelope", () => {
    const importers = SRC.filter((f) => !isTest(f))
      .filter((f) => /from ["'](@\/lib\/query\/compile|\.\/compile)["']/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(/\\/g, "/"));
    expect(importers).toEqual(["src/lib/query/execute.server.ts"]);
  });

  it("nothing under src/lib/query builds SQL from strings", () => {
    const offenders = walk("src/lib/query").filter((f) =>
      /\$(queryRawUnsafe|executeRawUnsafe)|Prisma\.raw\(/.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")),
    );
    expect(offenders).toEqual([]);
  });

  it("the client-safe modules import nothing server-side (the editor runs them in the browser)", () => {
    const clientSafe = ["ast", "fields", "functions", "lexer", "parser", "print", "normalize", "typecheck", "errors", "dates", "env", "adapters", "flag", "basic", "complete", "evaluate", "aggregate", "history", "describe"];
    for (const name of clientSafe) {
      const src = readFileSync(`src/lib/query/${name}.ts`, "utf8");
      expect(src, name).not.toMatch(/from ["']@\/lib\/db|from ["']@prisma\/client["'](?!;\s*$)|\.server["']|from ["']next\/server["']/m);
      // Type-only Prisma imports are erased; a runtime import is not.
      expect(src, name).not.toMatch(/^import \{[^}]*\} from ["']@prisma\/client["']/m);
    }
  });

  it("no route reads CQL without the shared gate", () => {
    const routes = SRC.filter((f) => /src\/app\/api\/.*\/(cql|work-items\/query)\/.*route\.ts$/.test(f.replace(/\\/g, "/")));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(readFileSync(r, "utf8"), r).toMatch(/cqlGate\(/);
  });
});
