import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Routes read a JSON body with `readJsonBody(request)` (src/lib/api-helpers.ts),
 * never `request.json()`.
 *
 * `request.json()` throws a SyntaxError for a body that isn't JSON (empty, cut
 * short, plain text), and handleApiError has no branch for it, so a client's
 * malformed body came back as a 500 and was reported as a server fault. 260
 * reads in 251 route files were written that way. readJsonBody turns the parse
 * failure, and only that, into a 400 `invalid_request`; `{ orElse }` keeps an
 * optional body optional.
 *
 * Read from the syntax tree, so a comment or a string that mentions
 * `request.json()` is not a read, and every shape of call is: awaited, chained
 * with `.catch`, inside a thunk, through `.clone()`, on a parameter of any name
 * typed as a request.
 *
 * Sources: every non-test file under src/app/api. A composed plugin's route
 * files there are one-line re-exports; the plugin's own code lives under
 * src/plugins/<slug> and is not core's to police.
 */

const ROOT = "src/app/api";

/**
 * Files that may read a body with `.json()`, each with its reason. Empty: a
 * route that needs the raw body (a webhook checking a signature) reads it with
 * `request.text()`, which this rule does not touch.
 */
const ALLOWED: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const REQUEST_NAME = /^_?(req|request)$/i;
const REQUEST_TYPE = /\b(Next)?Request\b/;

/** Names declared as a parameter typed as a request, anywhere in the file. */
function requestParams(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.type && REQUEST_TYPE.test(n.type.getText(sf))) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** `x`, `(x)`, `x.clone()`, `x.clone().clone()` → the identifier `x`, else null. */
function receiver(e: ts.Expression): ts.Identifier | null {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (
      ts.isCallExpression(cur) &&
      cur.arguments.length === 0 &&
      ts.isPropertyAccessExpression(cur.expression) &&
      cur.expression.name.text === "clone"
    ) cur = cur.expression.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur : null;
}

/** Every `<request>.json()` call in a source text: one line number each. */
export function rawJsonReads(fileName: string, text: string): { reads: number[]; jsonCalls: number } {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const params = requestParams(sf);
  const reads: number[] = [];
  let jsonCalls = 0;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      n.arguments.length === 0 &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "json"
    ) {
      jsonCalls++;
      const id = receiver(n.expression.expression);
      if (id && (REQUEST_NAME.test(id.text) || params.has(id.text))) {
        reads.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { reads, jsonCalls };
}

describe("the scanner (positive controls)", () => {
  it("finds the read the 500 came from, as it was written", () => {
    // PUT /api/v1/orgs/:orgId/security/settings before readJsonBody.
    const original = [
      "export async function PUT(request: NextRequest, { params }: RouteParams) {",
      "  try {",
      "    requirePermission(ctx, Permission.SECURITY_MANAGE);",
      "    const body = await request.json();",
      "    const { actionRestrictions: rawRestrictions, ...data } = updateSettingsSchema.parse(body);",
      "  } catch (error) {",
      "    return handleApiError(error);",
      "  }",
      "}",
    ].join("\n");
    expect(rawJsonReads("route.ts", original).reads).toEqual([4]);
  });

  it("finds every shape of read, on any request parameter", () => {
    const src = [
      "export async function POST(req: Request, incoming: NextRequest) {",
      "  const a = await req.json();",
      "  const b = schema.safeParse(await request.json().catch(() => null));",
      "  const c = (await request.json()) as { x?: string };",
      "  await service(ctx, () => request.json());",
      "  const d = await request.clone().json();",
      "  const e = await incoming.json();",
      "  const f = await (request).json();",
      "}",
    ].join("\n");
    expect(rawJsonReads("route.ts", src).reads).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("does not count a mention, a fetch response, or the helper", () => {
    const src = [
      "// Never call request.json() here: see readJsonBody.",
      "/** `await request.json()` threw a SyntaxError. */",
      "const note = \"request.json()\";",
      "export async function POST(request: NextRequest) {",
      "  const body = await readJsonBody(request);",
      "  const opt = await readJsonBody(request, { orElse: {} });",
      "  const upstream = await fetch(url);",
      "  const data = await upstream.json();",
      "  return NextResponse.json({ ok: true });",
      "}",
    ].join("\n");
    const { reads, jsonCalls } = rawJsonReads("route.ts", src);
    expect(jsonCalls).toBe(1); // upstream.json() was examined, and is not a request
    expect(reads).toEqual([]);
  });
});

describe("routes read JSON bodies through readJsonBody", () => {
  const files = sourceFiles(ROOT);
  const scanned = files.map((f) => ({ file: f, ...rawJsonReads(f, readFileSync(f, "utf8")) }));

  it("scans the route tree it claims to", () => {
    // 480 route.ts files on 2026-11-14. A walk that silently finds nothing
    // would pass the rule below, so say what was read.
    expect(files.length).toBeGreaterThan(400);
    expect(files.filter((f) => f.endsWith("/route.ts")).length).toBeGreaterThan(400);
  });

  it("no route reads its body with request.json()", () => {
    const offending = scanned.filter((s) => s.reads.length > 0 && !(s.file in ALLOWED));
    const found = {
      reads: offending.reduce((n, s) => n + s.reads.length, 0),
      files: offending.map((s) => `${s.file}:${s.reads.join(",")}`),
    };
    expect(found, "use readJsonBody(request), or readJsonBody(request, { orElse }) for an optional body").toEqual({ reads: 0, files: [] });
  });

  it("every allowlisted file still reads a body that way, and says why", () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.trim().length, `${file} needs a reason`).toBeGreaterThan(0);
      expect(scanned.find((s) => s.file === file)?.reads.length ?? 0, `${file} is allowlisted but reads no body with .json(): remove it`).toBeGreaterThan(0);
    }
  });
});
