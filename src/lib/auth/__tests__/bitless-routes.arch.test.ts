// @vitest-environment node
//
// Every route handler a key can authenticate to that checks no permission bit
// must say what it does with a key (bitless-routes.table.ts), and its code
// must do it. A handler that checks no bit admits a key of any scope, so a new
// one is a decision, reviewed here, never discovered later.
//
// The scan: each GET/POST/PUT/PATCH/DELETE under src/app/api whose code (its
// body, and the helpers it calls: gate-bits.ts's handlerCode) authenticates
// through getAuthContext or resolveAuth, the two paths a bearer key takes,
// and calls no gate with a bit (gateBits) and no gate that holds a bit or a
// scope by itself. Session-only routes (getCurrentUser) never see a key.
//
// It reads the code as TypeScript parses it, not as text: only a real call
// counts. A gate named in a comment or a string ("no requirePermission here")
// is not a gate, and a refusal written in a comment is not a refusal.
import { describe, it, expect } from "vitest";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { gateBits, handlerCode } from "./gate-bits";
import { BITLESS_ROUTES, BRANCH_BITLESS_ROUTES, type KeyAccess } from "./bitless-routes.table";

/** The two authentication calls a bearer key passes through. */
const KEY_AUTH = ["getAuthContext", "resolveAuth"];

/**
 * Library gates that hold a bit or a scope on their own, which gateBits does
 * not list: each refuses a caller without it before any route code runs.
 */
const BIT_HELPERS = [
  "orgContext", "assertScopes", "cqlGate", "loadFeedbackRoute", "canReadProject", "canManageBoardsInProject", "canManageProject", "requireSystemAdmin",
  // lib/files/access.ts: a project's file opens only for a holder of
  // DOCUMENT_READ (PROJECT_READ), whether shared with them or inherited.
  "readableProjectDocument",
];

/**
 * The gates gateBits reads a bit from (gate-bits.ts), by the name called.
 * requireKeyMay (rbac/key-role.ts) demands its key bit of a key's scoped
 * permissions and its session bit of a session or the key's creator.
 */
const GATES = new Set([
  "requirePermission", "requireProjectManage", "canAdministerProject", "assertPermission",
  "requireAccess", "requireProjectRead", "assertProjectRead", "readableItemProjectId", "cqlGate",
  "requireKeyMay",
]);
/**
 * Checks that gate only when the answer is negated: `if (!hasPermission(…)) throw …`.
 * keyMay is requireKeyMay's boolean form.
 */
const NEGATED_GATES = new Set(["hasPermission", "hasAnyPermission", "keyMay"]);

const printer = ts.createPrinter({ removeComments: true });
const parse = (code: string) => ts.createSourceFile("handler.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

interface Call { name: string; node: ts.CallExpression; sf: ts.SourceFile }

/** Every call made inside `root`: `f(…)` and `x.f(…)`, by the name called. Comments and strings hold none. */
function callsIn(root: ts.Node, sf: ts.SourceFile): Call[] {
  const out: Call[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
      if (name) out.push({ name, node: n, sf });
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** Every call `code` really makes. */
export function realCalls(code: string): Call[] {
  const sf = parse(code);
  return callsIn(sf, sf);
}

const isNegated = (c: Call) => ts.isPrefixUnaryExpression(c.node.parent) && c.node.parent.operator === ts.SyntaxKind.ExclamationToken;

/** The gate calls among `calls`, printed without comments: what gateBits reads, and nothing else. */
function gateText(calls: Call[]): string {
  return calls
    .filter((c) => GATES.has(c.name) || ((c.name === "hasPermission" || c.name === "keyMay") && isNegated(c)))
    .map((c) => printer.printNode(ts.EmitHint.Unspecified, isNegated(c) ? c.node.parent : c.node, c.sf))
    .join(";\n");
}

/** A handler's code (handlerCode) that a key reaches with no bit check, by the rules above. */
export function isBitlessKeyHandler(code: string): boolean {
  const names = new Set(realCalls(code).map((c) => c.name));
  if (!KEY_AUTH.some((n) => names.has(n)) || BIT_HELPERS.some((n) => names.has(n))) return false;
  return gateBits(gateText(realCalls(code))) === 0n;
}

function route(file: string): string {
  return file.replace(/^src\/app\/api\//, "").replace(/\/route\.ts$/, "");
}

/** Handlers a key reaches with no bit check. */
export function bitlessKeyRoutes(): string[] {
  const out: string[] = [];
  for (const file of globSync("src/app/api/**/route.ts")) {
    const src = readFileSync(file, "utf8");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const code = handlerCode(src, method, file);
      if (code && isBitlessKeyHandler(code)) out.push(`${method} ${route(file)}`);
    }
  }
  return out.sort();
}

function fileOf(entry: string): string {
  return `src/app/api/${entry.split(" ")[1]}/route.ts`;
}

function codeOf(entry: string): string {
  const file = fileOf(entry);
  const code = handlerCode(readFileSync(file, "utf8"), entry.split(" ")[0], file);
  if (!code) throw new Error(`${entry}: no such handler`);
  return code;
}

/** The handler really calls refuseApiKey. */
export function refusesKey(code: string): boolean {
  return realCalls(code).some((c) => c.name === "refuseApiKey");
}

/** The scopes a real requireKeyScopes(ctx, [...]) call asks for, or null. */
function keyScopesAsked(code: string): string[] | null {
  const call = realCalls(code).find((c) => c.name === "requireKeyScopes");
  const list = call?.node.arguments[1];
  if (!list || !ts.isArrayLiteralExpression(list)) return null;
  return list.elements.map((e) => (ts.isStringLiteralLike(e) ? e.text : `<${e.getText()}>`)).sort();
}

/** `Permission.X` or the action key "X". */
const namesBit = (n: ts.Node, bit: string) =>
  (ts.isStringLiteralLike(n) && n.text === bit) ||
  (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Permission" && n.name.text === bit);
const namesAnyBit = (n: ts.Node) =>
  ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Permission";

/** A real `if (ctx.isApiKey) requirePermission(ctx, Permission.<bit>)`. */
function demandsBitOfKey(code: string, bit: string): boolean {
  return realCalls(code).some((c) => {
    if (c.name !== "requirePermission" || !c.node.arguments.some((a) => namesBit(a, bit))) return false;
    for (let n: ts.Node = c.node; n.parent; n = n.parent) {
      const p = n.parent;
      if (ts.isIfStatement(p) && p.thenStatement === n) {
        return ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === "isApiKey";
      }
    }
    return false;
  });
}

interface FunctionFound { params: string[]; body: ts.Node; sf: ts.SourceFile }

/** A top-level function `name` in `src`: a declaration, or a const bound to a function. */
function functionIn(src: string, name: string, exportedOnly: boolean): FunctionFound | null {
  const sf = parse(src);
  for (const st of sf.statements) {
    const exported = !!ts.getModifiers(st as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exportedOnly && !exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) {
      return { params: st.parameters.map((p) => p.name.getText(sf)), body: st.body, sf };
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const f = d.initializer;
        if (ts.isIdentifier(d.name) && d.name.text === name && f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f))) {
          return { params: f.parameters.map((p) => p.name.getText(sf)), body: f.body, sf };
        }
      }
    }
  }
  return null;
}

/** Where `name` is defined for `file`: in the file itself, or in the module it imports it from. */
function findHelper(src: string, file: string | undefined, name: string): FunctionFound | null {
  const local = functionIn(src, name, false);
  if (local || !file) return local;
  for (const st of parse(src).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const binding = named.elements.find((e) => e.name.text === name);
    if (!binding) continue;
    const spec = st.moduleSpecifier.text;
    const base = spec.startsWith("@/") ? path.join("src", spec.slice(2)) : spec.startsWith(".") ? path.join(path.dirname(file), spec) : null;
    const target = base && [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((f) => existsSync(f));
    if (!target) return null;
    return functionIn(readFileSync(target, "utf8"), binding.propertyName?.text ?? name, true);
  }
  return null;
}

/**
 * Why a "helper" entry doesn't hold: the handler must really call the helper
 * (passing `bit`, when named), and the helper must really call a gate with it:
 * forwarding the parameter that received the bit, or naming a bit itself.
 */
export function helperProblem(src: string, method: string, file: string | undefined, access: { helper: string; bit?: string }): string | null {
  const code = handlerCode(src, method, file);
  if (!code) return "no such handler";
  const calls = realCalls(code).filter((c) => c.name === access.helper);
  if (!calls.length) return `doesn't call ${access.helper}`;
  let argIndex = -1;
  if (access.bit) {
    for (const c of calls) {
      const i = c.node.arguments.findIndex((a) => namesBit(a, access.bit!));
      if (i >= 0) { argIndex = i; break; }
    }
    if (argIndex < 0) return `doesn't pass ${access.bit} to ${access.helper}`;
  }
  const helper = findHelper(src, file, access.helper);
  if (!helper) return `can't find ${access.helper}`;
  const param = argIndex >= 0 ? helper.params[argIndex] : undefined;
  const gates = callsIn(helper.body, helper.sf).filter((c) => GATES.has(c.name) || (NEGATED_GATES.has(c.name) && isNegated(c)));
  const holds = gates.some((g) =>
    g.node.arguments.some((a) =>
      access.bit ? (param !== undefined && ts.isIdentifier(a) && a.text === param) || namesBit(a, access.bit) : namesAnyBit(a),
    ),
  );
  return holds ? null : `${access.helper} calls no gate with ${access.bit ? `the ${access.bit} it is given` : "a bit"}`;
}

describe("the scan reads calls, not text", () => {
  const handler = (extra: string) => `export async function DELETE(req: Request) {
  const ctx = await getAuthContext(slug);
${extra}
  await prisma.userPreferences.deleteMany({ where: { userId: ctx.userId } });
}`;

  it("a gate named only in a comment or a string is not a gate", () => {
    expect(isBitlessKeyHandler(handler("  // Own data, so no requirePermission(ctx, Permission.ORG_READ) here."))).toBe(true);
    expect(isBitlessKeyHandler(handler("  /* requireAccess(ctx, \"ITEM_READ\") */"))).toBe(true);
    expect(isBitlessKeyHandler(handler('  const why = "requirePermission(ctx, Permission.ORG_READ)";'))).toBe(true);
    expect(isBitlessKeyHandler(handler("  requirePermission(ctx, /* Permission.ORG_READ */ perm);"))).toBe(true);
  });

  it("a real gate call is (control)", () => {
    expect(isBitlessKeyHandler(handler("  requirePermission(ctx, Permission.ORG_READ);"))).toBe(false);
    expect(isBitlessKeyHandler(handler('  await requireAccess(ctx, "ITEM_READ");'))).toBe(false);
    expect(isBitlessKeyHandler(handler("  if (!hasPermission(ctx.permissions, Permission.ORG_READ)) throw new ForbiddenError();"))).toBe(false);
  });

  it("the key-or-session gates are gates; keyMay only when its answer is negated", () => {
    expect(isBitlessKeyHandler(handler('  requireKeyMay(ctx, "TIME_CREATE", "TIME_READ");'))).toBe(false);
    expect(isBitlessKeyHandler(handler('  if (!keyMay(ctx, "ITEM_UPDATE", "ITEM_READ")) throw new ForbiddenError();'))).toBe(false);
    expect(isBitlessKeyHandler(handler('  // requireKeyMay(ctx, "TIME_CREATE", "TIME_READ");'))).toBe(true);
    expect(isBitlessKeyHandler(handler('  const mayEdit = keyMay(ctx, "ITEM_UPDATE", "ITEM_READ");'))).toBe(true);
  });

  it("a refusal written in a comment is not a refusal", () => {
    expect(refusesKey(handler("  // refuseApiKey(ctx);"))).toBe(false);
    expect(refusesKey(handler("  refuseApiKey(ctx);"))).toBe(true);
  });

  const withHelper = (helperBody: string, call = 'await authorize(orgId, "FINANCE_READ");') =>
    `async function authorize(orgId: string, action: PermissionKey) {
  const ctx = await getAuthContext(slug);
${helperBody}
  return ctx;
}
export async function GET(req: Request) {
  ${call}
}`;

  it("a helper entry holds only when the helper really gates on the bit it is given", () => {
    const entry = { helper: "authorize", bit: "FINANCE_READ" };
    expect(helperProblem(withHelper("  await requireAccess(ctx, action);"), "GET", undefined, entry)).toBeNull();
    expect(helperProblem(withHelper("  // await requireAccess(ctx, action);"), "GET", undefined, entry)).toMatch(/calls no gate/);
    expect(helperProblem(withHelper("  await requireAccess(ctx, \"ORG_READ\");"), "GET", undefined, entry)).toMatch(/calls no gate/);
    expect(helperProblem(withHelper("  await requireAccess(ctx, action);", 'await authorize(orgId, "ORG_READ");'), "GET", undefined, entry)).toMatch(/doesn't pass FINANCE_READ/);
    expect(helperProblem(withHelper("  await requireAccess(ctx, action);", "// authorize(orgId, \"FINANCE_READ\")"), "GET", undefined, entry)).toMatch(/doesn't call/);
  });
});

describe("key-reachable handlers with no bit check are all classified", () => {
  const found = bitlessKeyRoutes();

  it("scans a real surface (not vacuous)", () => {
    expect(globSync("src/app/api/**/route.ts").length).toBeGreaterThan(300);
    // A positive control for the scan itself: the Outlook disconnect is the
    // finding this test was written for, and it must be seen.
    expect(found).toContain("DELETE v1/orgs/[orgId]/microsoft/calendar");
  });

  it("every one is in the table: classify a new one there", () => {
    const unclassified = found.filter((r) => !(r in BITLESS_ROUTES));
    expect(unclassified).toEqual([]);
  });

  it("every table entry is still one: drop an entry once its handler checks a bit", () => {
    const stale = Object.keys(BITLESS_ROUTES).filter((r) => !found.includes(r));
    expect(stale).toEqual([]);
  });
});

describe("each handler does what the table says with a key", () => {
  const all: Record<string, KeyAccess> = { ...BITLESS_ROUTES, ...BRANCH_BITLESS_ROUTES };
  const of = <K extends KeyAccess["key"]>(k: K) =>
    Object.entries(all).filter((e): e is [string, Extract<KeyAccess, { key: K }>] => e[1].key === k);

  // That the refusal comes BEFORE any work is proved by running the handler
  // (bitless-routes.keys.test.ts: a refused key touches nothing); this holds
  // the code to a real call.
  it.each(of("refused"))("%s refuses a key", (entry) => {
    expect(refusesKey(codeOf(entry))).toBe(true);
  });

  it.each(of("scope"))("%s asks a key for its scopes", (entry, access) => {
    expect(keyScopesAsked(codeOf(entry)), `${entry} calls requireKeyScopes`).toEqual([...access.scopes].sort());
  });

  it.each(of("bit"))("%s demands its bit of a key", (entry, access) => {
    expect(demandsBitOfKey(codeOf(entry), access.bit)).toBe(true);
  });

  it.each(of("helper"))("%s is gated by its helper", (entry, access) => {
    const file = fileOf(entry);
    expect(helperProblem(readFileSync(file, "utf8"), entry.split(" ")[0], file, access)).toBeNull();
  });
});
