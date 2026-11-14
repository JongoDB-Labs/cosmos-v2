// @vitest-environment node
//
// A project's board list has two doors: the app's `GET .../boards` and the
// assistant's `list_boards`. Each used to read the board table itself and apply
// the team gate and the reader DTO on its own, so a rule added to one (who made
// a board, a new visibility axis) had to be remembered in the other. They now
// both call the board service's `listBoards`, and this holds them to it: each
// door's function must CALL that, and must not query boards itself.
//
// Per function, not per file: the route file's POST and the executor file's
// other tools are not this rule's business. Comments are stripped first, so a
// door that only MENTIONS listBoards in prose does not pass.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = "@/lib/boards/board-service.server";
const DOORS: Array<{ file: string; fn: string }> = [
  { file: "app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route.ts", fn: "GET" },
  { file: "lib/ai/executors/boards.ts", fn: "listBoards" },
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The body of `export async function <name>(…) { … }`, braces matched. */
function functionBody(src: string, name: string): string | null {
  const start = src.search(new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  let i = src.indexOf("(", start);
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) break;
  }
  const open = src.indexOf("{", i);
  for (let j = open, depth = 0; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(open + 1, j);
  }
  return null;
}

/** The local name `listBoards` is imported under from the board service, if it is. */
function serviceListBinding(src: string): string | null {
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (m[2] !== SERVICE) continue;
    for (const part of m[1].split(",")) {
      const [imported, local] = part.trim().split(/\s+as\s+/);
      if (imported === "listBoards") return (local ?? imported).trim();
    }
  }
  return null;
}

function doorProblems(src: string, fn: string): string[] {
  const code = stripComments(src);
  const body = functionBody(code, fn);
  if (body === null) return [`no exported function ${fn}`];
  const problems: string[] = [];
  const local = serviceListBinding(code);
  if (!local) problems.push(`does not import listBoards from ${SERVICE}`);
  else if (!new RegExp(`\\b${local}\\s*\\(`).test(body)) problems.push(`${fn} does not call ${local}()`);
  if (/\bprisma\s*\.\s*board\s*\./.test(body)) problems.push(`${fn} queries the board table itself`);
  return problems;
}

describe("the board list has one path", () => {
  for (const { file, fn } of DOORS) {
    it(`${file} ${fn} lists boards through the board service`, () => {
      const src = readFileSync(join(process.cwd(), "src", file), "utf8");
      expect(doorProblems(src, fn)).toEqual([]);
    });
  }

  it("the check sees a door that queries boards itself, or only mentions the service", () => {
    const head = `import { listBoards } from "${SERVICE}";\n`;
    const good = `${head}export async function GET(a: { b: string }) { return listBoards(ctx, p); }`;
    const own = `${head}export async function GET(a: { b: string }) { return prisma.board.findMany({}); }`;
    const prose = `${head}export async function GET() { /* listBoards(ctx, p) */ return rows; }`;
    const aliased = `import { getBoard, listBoards as list } from "${SERVICE}";\nexport async function listBoards() { return list(ctx, p); }`;
    expect(doorProblems(good, "GET")).toEqual([]);
    expect(doorProblems(aliased, "listBoards")).toEqual([]);
    expect(doorProblems(own, "GET")).toEqual(["GET does not call listBoards()", "GET queries the board table itself"]);
    expect(doorProblems(prose, "GET")).toEqual(["GET does not call listBoards()"]);
  });
});
