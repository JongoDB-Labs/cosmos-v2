// Every `new PrismaClient(...)` names the default options type explicitly.
//
// `new PrismaClient({ adapter, log })` infers its own options type, so the result is
// `PrismaClient<{ adapter: PrismaPg; log: ... }>`, a different instantiation from the
// `PrismaClient` every helper, `Db` alias and transaction client is typed against. The
// first time such a client meets a `PrismaClient`-typed slot (an `??`, an argument, a
// return), tsc compares the two structurally, every model delegate and every method,
// and keeps the result. Measured on 2026-10-24: one such site cost 14 s of checking and
// created 42% of all the types in the program (580K of 1.38M), and fixing it alone
// only moved the cost to the next unpinned client. Pinning all of them took
// `tsc --noEmit` from ~5.1 GB to ~4.4 GB, with types -41% and instantiations -57%.
//
// `Prisma.PrismaClientOptions` is the class's own default type argument, so the pinned
// client IS the plain `PrismaClient` type and nothing has to be compared.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Everything tsconfig.json compiles: it includes every .ts/.tsx outside node_modules
// and plugins.
const ROOTS = ["src", "prisma", "scripts", "e2e", "docs"];
const SKIP = new Set(["node_modules", ".next", "plugins"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

// Comments mention `new PrismaClient()` while explaining things; don't count them.
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("PrismaClient instantiation", () => {
  it("is constructed somewhere (the scan is looking at real files)", () => {
    const files = ROOTS.flatMap(walk).filter((p) => /new PrismaClient\b/.test(code(p)));
    expect(files).toContain(join("src", "lib", "db", "client.ts"));
  });

  it("always names Prisma.PrismaClientOptions, so no inferred options type leaks out", () => {
    const offenders = ROOTS.flatMap(walk).filter((p) =>
      /new PrismaClient\s*(?!<\s*Prisma\.PrismaClientOptions\s*>)[(<]/.test(code(p)),
    );
    expect(
      offenders,
      "Write `new PrismaClient<Prisma.PrismaClientOptions>({...})`. Each inferred client " +
        "instantiation costs ~0.7 GB of tsc memory (see the header of this file).",
    ).toEqual([]);
  });
});
