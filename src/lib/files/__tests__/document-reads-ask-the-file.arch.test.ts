// @vitest-environment node
//
// Every function that reads a stored file, or names one, asks the file's own rule.
//
// The rule (lib/files/access.ts) was correct and was called by the two lists and
// the org-level by-id route. Eight other doors read `prisma.document` directly
// after checking only the PROJECT: the document by id with its parsed text, both
// downloads, its item links, a ticket's attachment list, the "created from" chip,
// convert, propose, and the assistant's list_documents. A restricted file was
// hidden from the Files list and handed out by all of them.
//
// The first version of this guard looked only under src/app/api and the
// assistant's executors, and only for `prisma.document.find*(`. Search and
// @-mentions read files through `d(prisma.document)`, a delegate passed by value,
// and leaked restricted titles past it; `include: { documents }` and `.count` were
// invisible to it too. So it now reads the syntax of all of src/ and finds a file
// read in every shape:
//   - a read on the model: `x.document.findMany(...)`, `.count`, `.aggregate`, `.groupBy`;
//   - the model handed on as a value: `d(prisma.document)`, `const m = tx.document`;
//   - the relation pulled into another read: `include: { documents: ... }`,
//     `select: { document: ... }`, `_count: { select: { documents: true } }`.
//
// The property is stated per UNIT: the outermost function around the read, or,
// at module level, the entry of the object it sits in. A file where one handler
// asks and its sibling does not is exactly the shape that leaked. And the rule's
// answer must be used: a call whose result is dropped protects nothing.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "generated") walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const READ_METHODS = new Set([
  "findFirst", "findMany", "findUnique", "findFirstOrThrow", "findUniqueOrThrow", "count", "aggregate", "groupBy",
]);
/** The names a Prisma client or transaction goes by here. */
const CLIENTS = new Set(["prisma", "tx", "db", "client", "trx"]);
/**
 * The tables whose rows expose a file: the file, its parsed text (blocks), the
 * items it produced (links) and who it is shared with.
 */
const MODELS = new Set(["document", "documentBlock", "documentItemLink", "documentShare"]);
/** The relation fields that reach those tables from another model's read. */
const RELATIONS = new Set(["document", "documents", "documentBlocks", "documentItemLinks", "documentShares"]);
/** The file's own rule. */
const RULE = new Set(["readableDocument", "readableProjectDocument", "documentVisibilityWhere", "orgDocumentVisibilityWhere"]);

const propName = (n: ts.PropertyName | ts.MemberName) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null);

/** `x.<model>.<method>(...)`, as [model, method]. */
function modelCall(n: ts.Node): [string, string] | null {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return null;
  const inner = n.expression.expression;
  if (!ts.isPropertyAccessExpression(inner)) return null;
  return [inner.name.text, n.expression.name.text];
}

/** Each place `node`'s subtree reads a file, described. */
function fileReads(sf: ts.SourceFile): Array<{ node: ts.Node; what: string }> {
  const out: Array<{ node: ts.Node; what: string }> = [];
  const visit = (n: ts.Node, underRead: boolean, underShape: boolean) => {
    const mc = modelCall(n);
    if (mc && MODELS.has(mc[0]) && READ_METHODS.has(mc[1])) out.push({ node: n, what: `${mc[0]}.${mc[1]}` });
    if (
      ts.isPropertyAccessExpression(n) &&
      MODELS.has(n.name.text) &&
      ts.isIdentifier(n.expression) &&
      CLIENTS.has(n.expression.text) &&
      !ts.isPropertyAccessExpression(n.parent)
    ) {
      out.push({ node: n, what: `${n.expression.text}.${n.name.text} as a value` });
    }
    if (underShape && ts.isPropertyAssignment(n) && RELATIONS.has(propName(n.name) ?? "") && n.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
      out.push({ node: n, what: `${propName(n.name)} in include/select` });
    }
    const read = underRead || (mc !== null && READ_METHODS.has(mc[1]));
    // Inside a read's arguments, below an `include` or a `select` key.
    const shape =
      underShape ||
      (read && ts.isPropertyAssignment(n) && ["include", "select"].includes(propName(n.name) ?? ""));
    ts.forEachChild(n, (c) => visit(c, read, shape));
  };
  visit(sf, false, false);
  return out;
}

const isFunctionLike = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);

/** The unit a read belongs to: its outermost function, else the outermost object entry, else its statement. */
function unitOf(n: ts.Node): ts.Node {
  let fn: ts.Node | null = null;
  let entry: ts.Node | null = null;
  let stmt: ts.Node = n;
  for (let p: ts.Node = n; !ts.isSourceFile(p); p = p.parent) {
    if (isFunctionLike(p)) fn = p;
    if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent)) entry = p;
    if (ts.isSourceFile(p.parent)) stmt = p;
  }
  return fn ?? entry ?? stmt;
}

function unitName(u: ts.Node, sf: ts.SourceFile): string {
  const named = (x: ts.Node): string | null => {
    if ((ts.isFunctionDeclaration(x) || ts.isMethodDeclaration(x)) && x.name) return x.name.getText(sf);
    if (ts.isPropertyAssignment(x)) return x.name.getText(sf);
    if (ts.isVariableDeclaration(x)) return x.name.getText(sf);
    return null;
  };
  for (let p: ts.Node = u; !ts.isSourceFile(p); p = p.parent) {
    const n = named(p);
    if (n) return n;
  }
  return `line ${sf.getLineAndCharacterOfPosition(u.getStart(sf)).line + 1}`;
}

/** A call to the rule whose answer is used: not a bare statement, not `void`ed. */
function asksTheFile(unit: ts.Node): boolean {
  let asks = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && RULE.has(n.expression.text)) {
      let up: ts.Node = n;
      while (ts.isAwaitExpression(up.parent) || ts.isParenthesizedExpression(up.parent)) up = up.parent;
      if (!ts.isExpressionStatement(up.parent) && !ts.isVoidExpression(up.parent)) asks = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(unit);
  return asks;
}

export type Reader = { where: string; what: string; asks: boolean };
export function readersIn(source: string, file: string): Reader[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const byUnit = new Map<ts.Node, Reader>();
  for (const r of fileReads(sf)) {
    const u = unitOf(r.node);
    if (!byUnit.has(u)) byUnit.set(u, { where: `${file}#${unitName(u, sf)}`, what: r.what, asks: asksTheFile(u) });
  }
  return [...byUnit.values()];
}

/**
 * Readers that serve no user, each with the reason. Every entry must still read
 * a file, so the list cannot rot.
 */
const SYSTEM_READERS: Record<string, string> = {
  "src/lib/files/access.ts#readableDocument": "the rule itself",
  "src/lib/files/ingest.ts#ingestDocument": "reads back the blocks it has just written, inside the upload",
};
/**
 * Library modules whose readers take a file id that their caller has already
 * checked. They are exempt only because the last test below holds: every
 * function outside the module that calls into it asks the rule itself.
 */
const CHECKED_BY_CALLER: Record<string, string> = {
  "src/lib/files/convert.ts": "copies a block's text into a new item",
  "src/lib/files/propose.ts": "summarises a file's text into proposed items",
};
const moduleOf = (where: string) => where.split("#")[0];

const files = walk(join(ROOT, "src")).map((f) => ({ path: relative(ROOT, f), src: readFileSync(f, "utf8") }));
const readers = files.flatMap((f) => readersIn(f.src, f.path));

const parse = (path: string, src: string) =>
  ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** The module's top-level functions that read a file, directly or through another of them. */
function readingFunctions(module: string): Set<string> {
  const f = files.find((x) => x.path === module)!;
  const sf = parse(f.path, f.src);
  const reads = fileReads(sf);
  const fns = new Map<string, { node: ts.Node; callees: Set<string> }>();
  for (const st of sf.statements) {
    const decls: Array<[string, ts.Node]> = [];
    if (ts.isFunctionDeclaration(st) && st.name) decls.push([st.name.text, st]);
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer && isFunctionLike(d.initializer)) decls.push([d.name.text, d]);
    for (const [name, node] of decls) {
      const callees = new Set<string>();
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) callees.add(n.expression.text);
        ts.forEachChild(n, visit);
      };
      visit(node);
      fns.set(name, { node, callees });
    }
  }
  const reading = new Set(
    [...fns].filter(([, v]) => reads.some((r) => r.node.getStart(sf) >= v.node.getStart(sf) && r.node.getEnd() <= v.node.getEnd())).map(([k]) => k),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, v] of fns)
      if (!reading.has(name) && [...v.callees].some((c) => reading.has(c))) {
        reading.add(name);
        grew = true;
      }
  }
  return reading;
}

/** Each function outside `module` that calls one of its file-reading functions, and whether it asks the rule. */
function callersOf(module: string): Reader[] {
  const spec = "@/" + module.replace(/^src\//, "").replace(/\.tsx?$/, "");
  const reading = readingFunctions(module);
  const out: Reader[] = [];
  for (const f of files) {
    if (f.path === module || !f.src.includes(spec)) continue;
    const sf = parse(f.path, f.src);
    const imported = new Set<string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== spec) continue;
      const b = st.importClause?.namedBindings;
      // By the name it is imported as; `import { a as b }` is read by its original name.
      if (b && ts.isNamedImports(b))
        for (const el of b.elements) if (reading.has((el.propertyName ?? el.name).text)) imported.add(el.name.text);
    }
    const seen = new Set<ts.Node>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && imported.has(n.expression.text)) {
        const u = unitOf(n);
        if (!seen.has(u)) {
          seen.add(u);
          out.push({ where: `${f.path}#${unitName(u, sf)}`, what: `calls ${n.expression.text}`, asks: asksTheFile(u) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("every function that reads a file asks the file's own visibility rule", () => {
  it("finds the readers it is meant to check, in every shape (guards the scan itself)", () => {
    const where = readers.map((r) => r.where);
    expect(where.length).toBeGreaterThanOrEqual(15);
    expect(where).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/projects\/\[projectId\]\/documents\/\[docId\]\/route\.ts#GET$/),
        expect.stringMatching(/work-items\/\[itemId\]\/attachments\/route\.ts#GET$/),
        expect.stringMatching(/document-source\/route\.ts#GET$/),
        expect.stringMatching(/executors\/documents\.ts#listDocuments$/),
        // Outside src/app/api: a delegate passed by value, a count, a count in a transition.
        "src/lib/mentions/registry.server.ts#document",
        "src/lib/pm/closing-evidence.server.ts#evidenceFiles",
        expect.stringMatching(/^src\/lib\/workflow\/engine\.server\.ts#/),
      ]),
    );
  });

  it("each one asks readableDocument, readableProjectDocument or a visibility fragment, and uses the answer", () => {
    const offenders = readers
      .filter((r) => !r.asks && !SYSTEM_READERS[r.where] && !CHECKED_BY_CALLER[moduleOf(r.where)])
      .map((r) => `${r.where} (${r.what})`);
    expect(offenders, "a project being readable is not every file in it being readable: ask lib/files/access.ts").toEqual([]);
  });

  it("each listed exemption still reads a file", () => {
    const where = new Set(readers.map((r) => r.where));
    const modules = new Set(readers.map((r) => moduleOf(r.where)));
    expect(Object.keys(SYSTEM_READERS).filter((w) => !where.has(w))).toEqual([]);
    expect(Object.keys(CHECKED_BY_CALLER).filter((m) => !modules.has(m))).toEqual([]);
  });

  it("every caller of a module exempted for its caller asks the rule itself", () => {
    const callers = Object.keys(CHECKED_BY_CALLER).flatMap(callersOf);
    // Guards the scan: the convert and propose routes are found.
    expect(callers.map((c) => c.where)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/convert\/route\.ts#POST$/), expect.stringMatching(/\/propose\/route\.ts#POST$/)]),
    );
    expect(callers.filter((c) => !c.asks).map((c) => `${c.where} (${c.what})`)).toEqual([]);
  });
});

describe("each shape of a file read is seen, and only an answer that is used counts", () => {
  const units = (src: string) => readersIn(src, "x.ts").map((r) => [r.where.split("#")[1], r.what, r.asks]);

  it("a read on the model, and a count", () => {
    expect(units(`export async function GET() { return prisma.document.findMany({}); }`)).toEqual([["GET", "document.findMany", false]]);
    expect(units(`async function n() { return tx.document.count({ where }); }`)).toEqual([["n", "document.count", false]]);
  });
  it("the model passed by value, in a module-level table", () => {
    expect(units(`const H = { workItem: h(d(prisma.workItem)), document: h(d(prisma.document)) };`)).toEqual([
      ["document", "prisma.document as a value", false],
    ]);
    expect(units(`const H = { document: h({ delegate: d(prisma.document), where: (s) => orgDocumentVisibilityWhere(s.ctx) }) };`)).toEqual([
      ["document", "prisma.document as a value", true],
    ]);
  });
  it("the relation pulled into another model's read", () => {
    expect(units(`async function a() { return prisma.project.findMany({ include: { documents: true } }); }`)).toEqual([
      ["a", "documents in include/select", false],
    ]);
    expect(units(`async function b() { return prisma.workItem.findMany({ select: { _count: { select: { documents: true } } } }); }`)).toEqual([
      ["b", "documents in include/select", false],
    ]);
    expect(units(`async function c() { return prisma.attachmentNote.findFirst({ select: { document: { select: { title: true } } } }); }`)).toEqual([
      ["c", "document in include/select", false],
    ]);
    // The file's text, its links and its shares are the file's too.
    expect(units(`async function e() { return prisma.documentBlock.findMany({ where: { documentId } }); }`)).toEqual([
      ["e", "documentBlock.findMany", false],
    ]);
  });
  it("not a read: a relation filter, a write, a row's field, an explicit false", () => {
    expect(units(`async function a() { return prisma.workItem.findMany({ where: { documents: { some: { orgId } } } }); }`)).toEqual([]);
    expect(units(`async function b() { return prisma.workItem.update({ where: { id }, data: { documents: { connect: { id: d } } } }); }`)).toEqual([]);
    expect(units(`function c(link) { return link.document.title; }`)).toEqual([]);
    expect(units(`async function d() { return prisma.project.findMany({ include: { documents: false } }); }`)).toEqual([]);
  });
  it("the rule's answer must be used: a dropped or voided call does not count", () => {
    const read = `return prisma.document.findFirst({ where: { id } });`;
    expect(units(`async function a() { if (!(await readableDocument(o, id, ctx))) return null; ${read} }`)[0][2]).toBe(true);
    expect(units(`async function a() { await readableDocument(o, id, ctx); ${read} }`)[0][2]).toBe(false);
    expect(units(`async function a() { void readableDocument(o, id, ctx); ${read} }`)[0][2]).toBe(false);
    expect(units(`async function a() { const w = documentVisibilityWhere(ctx, s); ${read.replace("{ id }", "{ id, ...w }")} }`)[0][2]).toBe(true);
  });
  it("is per unit: an asking sibling does not cover one that does not ask", () => {
    expect(
      units(`
        export async function GET() { const d = await readableDocument(o, i, c); return d && prisma.document.findFirst({}); }
        export async function HEAD() { return prisma.document.findFirst({ where: { id } }); }`),
    ).toEqual([
      ["GET", "document.findFirst", true],
      ["HEAD", "document.findFirst", false],
    ]);
  });
  it("a comment or an import names the rule without calling it", () => {
    expect(units(`import { readableDocument } from "x"; // call readableDocument(o, i, c) first\nasync function a() { return prisma.document.findFirst({}); }`)[0][2]).toBe(false);
  });
});
