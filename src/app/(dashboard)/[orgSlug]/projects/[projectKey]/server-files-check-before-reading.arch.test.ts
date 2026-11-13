// @vitest-environment node
//
// Every server file under projects/[projectKey] decides visibility ITSELF,
// before it reads anything.
//
// A layout and its page render in parallel, and the page's output is streamed
// even when the layout calls notFound(), so a parent's check covers nothing
// beneath it (see layout.test.tsx). The same is true of a template, a parallel
// route's default, a loading file, metadata and a route handler: each one that
// reads data must refuse first.
//
// The rule is read from the syntax, not the text, because the text can carry the
// name of the check without the check deciding anything: a call whose result is
// ignored, one that is not awaited (a Promise is always truthy), one whose
// refusal does not end the function, or one placed after the first read all
// mention `canReadProject(` and protect nothing.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SUBTREE = "src/app/(dashboard)/[orgSlug]/projects/[projectKey]";

/** Every server file in the folder, Next's special files and any other module; tests and client components excluded. */
function serverFiles(dir = SUBTREE, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) serverFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !isClient(readFileSync(p, "utf8"))) out.push(p);
  }
  return out;
}
function isClient(src: string): boolean {
  const first = ts.createSourceFile("x.tsx", src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX).statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client";
}

/**
 * The reads that may run before the check: authentication, and the one lookup
 * that finds the project (and the org) by the key in the URL. `Promise.all` is
 * judged by its members.
 */
const BEFORE_CHECK = new Set([
  "getAuthContext", "getCurrentUser", "cookies", "headers", "connection", "Promise.all",
  "prisma.project.findFirst", "prisma.project.findUnique", "prisma.organization.findFirst", "prisma.organization.findUnique",
]);
const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
const calleeName = (call: ts.CallExpression, sf: ts.SourceFile) => call.expression.getText(sf).replace(/\s+/g, "");

/** `node` is what an `await` waits for, through any parentheses. */
function isAwaited(node: ts.Node): boolean {
  let n = node;
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  return ts.isAwaitExpression(n.parent);
}
/**
 * A read: a database call, or any call whose result is awaited, directly or as
 * one member of an awaited `Promise.all([...])`. Data on a server is fetched
 * asynchronously, so this separates it from rendering helpers like `.map()`,
 * `cn()` or a regex test, which read nothing. The project lookup counts as a
 * read, so a function that makes it must also check.
 */
function isRead(call: ts.CallExpression, sf: ts.SourceFile): boolean {
  if (calleeName(call, sf).startsWith("prisma.")) return true;
  if (isAwaited(call)) return true;
  const list = call.parent;
  return (
    ts.isArrayLiteralExpression(list) &&
    ts.isCallExpression(list.parent) &&
    calleeName(list.parent, sf) === "Promise.all" &&
    isAwaited(list.parent)
  );
}

/** `a || b || c` as [a, b, c]. */
function disjuncts(e: ts.Expression): ts.Expression[] {
  const x = unwrap(e);
  return ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ? [...disjuncts(x.left), ...disjuncts(x.right)]
    : [x];
}
/** `!(await canReadProject(...))`: the check, awaited, its "no" taken. */
function isDeniedCheck(e: ts.Expression): boolean {
  const x = unwrap(e);
  if (!ts.isPrefixUnaryExpression(x) || x.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const awaited = unwrap(x.operand);
  if (!ts.isAwaitExpression(awaited)) return false;
  const call = unwrap(awaited.expression);
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "canReadProject";
}
/** A statement that ends the function: notFound(), redirect(), return or throw. */
function ends(s: ts.Statement): boolean {
  if (ts.isBlock(s)) return s.statements.length > 0 && ends(s.statements[s.statements.length - 1]);
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return true;
  if (ts.isExpressionStatement(s)) {
    const c = unwrap(s.expression);
    return ts.isCallExpression(c) && ts.isIdentifier(c.expression) && ["notFound", "redirect", "permanentRedirect"].includes(c.expression.text);
  }
  return false;
}
/** A statement of the function body itself that refuses a reader the project may not open. */
function isCheck(s: ts.Statement): boolean {
  if (ts.isIfStatement(s)) return !s.elseStatement && disjuncts(s.expression).some(isDeniedCheck) && ends(s.thenStatement);
  // A route handler's form: the API gate, which throws.
  if (ts.isExpressionStatement(s)) {
    const a = unwrap(s.expression);
    const c = ts.isAwaitExpression(a) ? unwrap(a.expression) : null;
    return !!c && ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "requireProjectRead";
  }
  return false;
}

type Fn = { name: string; body: ts.Block };
/** The functions a file defines at its top level, under the name they are exported or declared by. */
function topLevelFunctions(sf: ts.SourceFile): Fn[] {
  const out: Fn[] = [];
  const fnBody = (n: ts.Node | undefined) =>
    n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body) ? n.body : null;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body) out.push({ name: st.name?.text ?? "default", body: st.body });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const body = fnBody(d.initializer);
        if (body && ts.isIdentifier(d.name)) out.push({ name: d.name.text, body });
      }
    }
    if (ts.isExportAssignment(st)) {
      const body = fnBody(st.expression);
      if (body) out.push({ name: "default", body });
    }
  }
  return out;
}

/** Each function in `source` that reads before refusing, as "name: what it read first". */
export function readsBeforeChecking(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems: string[] = [];
  for (const fn of topLevelFunctions(sf)) {
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) calls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    // Authentication reads the session, not the project's data.
    const reads = calls.filter((c) => isRead(c, sf) && !["getAuthContext", "getCurrentUser", "cookies", "headers", "connection"].includes(calleeName(c, sf)));
    if (reads.length === 0) continue;
    const check = fn.body.statements.find(isCheck);
    if (!check) {
      problems.push(`${fn.name}: reads (${calleeName(reads[0], sf)}) with no check that refuses first`);
      continue;
    }
    const early = reads.find((c) => c.getEnd() <= check.getStart(sf) && !BEFORE_CHECK.has(calleeName(c, sf)));
    if (early) problems.push(`${fn.name}: ${calleeName(early, sf)} runs before the check`);
  }
  return problems;
}

describe("every server file under projects/[projectKey] refuses before it reads", () => {
  const files = serverFiles();

  it("finds what it is meant to check (guards the scan itself)", () => {
    const named = (re: RegExp) => files.filter((f) => re.test(f)).length;
    expect(named(/\/page\.tsx$/)).toBeGreaterThanOrEqual(32);
    expect(named(/\/layout\.tsx$/)).toBe(2);
    expect(named(/\/loading\.tsx$/)).toBeGreaterThanOrEqual(13);
    // Client components are excluded, and only those.
    expect(files.some((f) => f.endsWith("/board-tabs.tsx"))).toBe(false);
  });

  it("each one that reads makes canReadProject's refusal end it before the first read", () => {
    const offenders = files.flatMap((f) => readsBeforeChecking(readFileSync(f, "utf8"), f).map((p) => `${f} ${p}`));
    expect(
      offenders,
      "the parent layout's check does not stop this file's data from being sent: " +
        "`if (!project || !(await canReadProject(ctx, project.id))) notFound();` straight after the lookup",
    ).toEqual([]);
  });
});

describe("the rule is read from the syntax, so each way of mentioning the check without it deciding fails", () => {
  const page = (body: string) => `
    export default function Page({ params }) { return <Suspense><Content params={params} /></Suspense>; }
    async function Content({ params }) {
      const { orgSlug, projectKey } = await params;
      const ctx = await getAuthContext(orgSlug);
      if (!ctx) redirect("/");
      const project = await prisma.project.findFirst({ where: { key: projectKey } });
      ${body}
      return <Risks risks={risks} />;
    }`;
  const READ = `const risks = await prisma.risk.findMany({ where: { projectId: project.id } });`;
  const CHECK = `if (!project || !(await canReadProject(ctx, project.id))) notFound();`;
  const flagged = (src: string, file = "page.tsx") => readsBeforeChecking(src, file);

  it("control: the check, then the read, passes", () => {
    expect(flagged(page(`${CHECK}\n${READ}`))).toEqual([]);
  });
  it("the call kept and its result ignored", () => {
    expect(flagged(page(`if (!project) notFound(); void canReadProject(ctx, project.id);\n${READ}`))).toHaveLength(1);
  });
  it("the read placed before the check", () => {
    expect(flagged(page(`${READ}\n${CHECK}`))).toEqual(["Content: prisma.risk.findMany runs before the check"]);
  });
  it("the check not awaited: a Promise is always truthy, so it never refuses", () => {
    expect(flagged(page(`if (!project || !canReadProject(ctx, project.id)) notFound();\n${READ}`))).toHaveLength(1);
  });
  it("a refusal that does not end the function", () => {
    expect(flagged(page(`if (!project || !(await canReadProject(ctx, project.id))) console.log("no");\n${READ}`))).toHaveLength(1);
  });
  it("a check nested where it may not run", () => {
    expect(flagged(page(`if (ctx.userId) { ${CHECK} }\n${READ}`))).toHaveLength(1);
  });
  it("metadata that names the project without checking", () => {
    const meta = `export async function generateMetadata({ params }) {
      const project = await prisma.project.findFirst({ where: { key: (await params).projectKey } });
      return { title: project?.name };
    }`;
    expect(flagged(meta)).toEqual(["generateMetadata: reads (prisma.project.findFirst) with no check that refuses first"]);
  });
  it("a template or a slot's default reads like a page", () => {
    expect(flagged(page(READ), "template.tsx")).toHaveLength(1);
    expect(flagged(page(READ), "@panel/default.tsx")).toHaveLength(1);
  });
  it("a route handler: requireProjectRead first passes, nothing first fails", () => {
    const route = (gate: string) => `export async function GET(req, { params }) {
      const ctx = await getAuthContext("x");
      ${gate}
      return Response.json(await prisma.risk.findMany({}));
    }`;
    expect(flagged(route(`await requireProjectRead(ctx, "p", "ANALYTICS_READ");`), "route.ts")).toEqual([]);
    expect(flagged(route(""), "route.ts")).toHaveLength(1);
  });
  it("a read inside Promise.all before the check counts; a synchronous helper does not", () => {
    expect(flagged(page(`const [risks] = await Promise.all([prisma.risk.findMany({}), loadThing(project.id)]);\n${CHECK}`))).toEqual([
      "Content: prisma.risk.findMany runs before the check",
    ]);
    expect(flagged(page(`if (!/^[0-9a-f-]{36}$/i.test(projectKey)) notFound();\n${CHECK}\n${READ}`))).toEqual([]);
  });
  it("a function that reads nothing needs no check", () => {
    expect(flagged(`export default async function Page({ params }) { redirect(\`/x/\${(await params).projectKey}\`); }`)).toEqual([]);
  });
});
