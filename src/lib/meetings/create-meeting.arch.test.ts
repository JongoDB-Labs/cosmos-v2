import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Every meeting is created through `createSyncMeeting`, which checks its
 * attendees and Teams meeting, saves it, and pushes it to Outlook.
 *
 * Cosmo's `create_meeting` once wrote the row itself, so its meetings skipped
 * the push and the REST create's rules. A create written anywhere else would
 * bring that back silently, so this fails on one instead. It looks for:
 *
 * - a create on the meeting model: `x.syncMeeting.create(`, `x["syncMeeting"].upsert(`
 *   and the other create methods, or a member it can't read (`x.syncMeeting[op](`);
 * - the model taken as a value (aliased, destructured, passed on), which would
 *   let a create happen out of this scan's sight. The one such use today, the
 *   mention registry, casts it to a type with nothing but `findMany`;
 * - the model's name in a string, in any case (`"syncMeeting"`, `"SyncMeetings"`):
 *   `tx[model]` over a list of model names (work-items/merge.server.ts) reaches
 *   the model with no `.syncMeeting` in the text;
 * - a nested create through a relation to the model (`organization.update({ data:
 *   { syncMeetings: { create } } })`), the relation names read from the schema;
 *   and a write through one whose value it can't read: shorthand, a variable,
 *   or a spread (`{ syncMeetings }`, `meetings: nested`, `meetings: { ...nested }`).
 *   `meeting` and `meetings` are ordinary words in responses and settings, so
 *   for those two it judges only a write: under `data`, `create` and the like,
 *   in a write call's argument, or in a variable that the same function passes
 *   to a write that way (`const data = { meeting: x }; … create({ data })`);
 * - the table's name in a string, in any case: raw SQL that writes it
 *   (`INSERT INTO`, `COPY`) anywhere, and any other mention outside the files
 *   in TABLE_NAMED_IN, so `"INSERT INTO " + "sync_meetings"` can't assemble one.
 *   An allowed file may hold no `INSERT` or `COPY` in any string at all, so the
 *   allowance can't pass the write it exists to catch.
 *
 * Parsed with the TypeScript compiler, so comments are never code and a `//`
 * inside a string can't hide what follows it.
 *
 * What it can't see: a name built at runtime (`"sync" + "Meeting"`), and a
 * `meeting`/`meetings` relation written from an object built outside any
 * write context it recognises. Each would take deliberate effort to write.
 */
const HELPER = "src/lib/meetings/create-meeting.server.ts";
const MODEL = "syncMeeting";
const MODEL_NAME = /^syncmeetings?$/i;
const CREATE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);
const NESTED_CREATES = new Set(["create", "createMany", "connectOrCreate", "upsert"]);
/** SQL that writes rows into the table. */
const WRITES_TABLE = /\b(?:insert\s+into|copy)\s+(?:"?\w+"?\.)?"?sync_meetings"?(?!\w)/i;
/** The table's name. Not `sync_meeting_attendees`, nor a trigger named `sync_meetings_…`. */
const TABLE = /(?<!\w)sync_meetings(?!\w)/i;
/** In a file allowed to name the table: no string may say either word. */
const WRITE_WORD = /\b(?:insert|copy)\b/i;
/** Read-only uses of the model as a value, each with why it can't create. */
const READ_ONLY_VALUE_USES: Record<string, string> = {
  // `d()` casts to `Delegate`, a type with only `findMany` (registry.server.ts).
  "src/lib/mentions/registry.server.ts": "d(prisma.syncMeeting)",
};
/** Files that name the table in a string, each with what it does with it. */
const TABLE_NAMED_IN: Record<string, string> = {
  "src/lib/rag/embed.ts": "the type of the table storeEmbedding UPDATEs; it sets only `embedding` on a row that exists",
  "src/lib/integrations/microsoft/teams-link.server.ts": "UPDATEs that record or forget a meeting's Teams link",
  "src/lib/ai/executors/rag.ts": "a SELECT for vector search over meetings",
};
/** Where a `meeting`/`meetings` key is a write: under one of these keys, or in a call to one. */
const WRITE_KEY = /^(?:data|create|createMany|createManyAndReturn|update|updateMany|upsert|connectOrCreate)$/;

/** The relation fields that hold meetings, from the schema (`syncMeetings SyncMeeting[]` and the like). */
const RELATIONS = [
  ...readFileSync("prisma/schema.prisma", "utf8").matchAll(/^[ \t]+(\w+)[ \t]+SyncMeeting(?:\[\]|\?)?(?=[ \t]|$)/gm),
].map((m) => m[1]);
/** Relation names that are also everyday words, judged only in a write. */
const GENERIC = new Set(["meeting", "meetings"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests and their fixtures build meetings directly, as fixtures do.
      if (entry.name !== "__tests__") out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) {
      out.push(full.split("\\").join("/"));
    }
  }
  return out;
}

const isText = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** A property's key when it can be read: `a`, `"a"`, `["a"]`. */
function keyOf(name: ts.Node): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && isText(name.expression)) return name.expression.text;
  return null;
}

/** `x.syncMeeting` or `x["syncMeeting"]`: the model's delegate. */
const isModel = (n: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(n) && n.name.text === MODEL) ||
  (ts.isElementAccessExpression(n) && isText(n.argumentExpression) && n.argumentExpression.text === MODEL);

/** The member a delegate is used through: its name, or null when it is computed. */
const memberOf = (n: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null =>
  ts.isPropertyAccessExpression(n) ? n.name.text : isText(n.argumentExpression) ? n.argumentExpression.text : null;

/** The text of a string or template, its substitutions left out. */
function literalText(n: ts.Node): string | null {
  if (isText(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => ` ${s.literal.text}`).join("");
  return null;
}

/** Whether a string is a property's key (judged by the relation rules, not as a name in a string). */
const isKey = (n: ts.Node): boolean =>
  ((ts.isPropertyAssignment(n.parent) || ts.isMethodDeclaration(n.parent) || ts.isPropertySignature(n.parent)) && n.parent.name === n) ||
  ts.isComputedPropertyName(n.parent);

/** Whether a property sits in a write: under a write key, in a write call, or in a variable passed to one. */
function inWrite(n: ts.Node, seen = new Set<ts.Node>()): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isPropertyAssignment(p) && WRITE_KEY.test(keyOf(p.name) ?? "")) return true;
    if (ts.isVariableDeclaration(p)) return passedToWrite(p, seen);
    if (ts.isCallExpression(p)) {
      const callee = p.expression;
      return (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && WRITE_KEY.test(memberOf(callee) ?? "");
    }
    const passes =
      ts.isObjectLiteralExpression(p) || ts.isArrayLiteralExpression(p) || ts.isPropertyAssignment(p) ||
      ts.isSpreadAssignment(p) || ts.isSpreadElement(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p) ||
      ts.isConditionalExpression(p) || ts.isBinaryExpression(p);
    if (!passes) return false;
  }
  return false;
}

/** Whether the function holding `decl` passes it to a write: `{ data }` or `data: decl` in one. */
function passedToWrite(decl: ts.VariableDeclaration, seen: Set<ts.Node>): boolean {
  if (!ts.isIdentifier(decl.name) || seen.has(decl)) return false;
  seen.add(decl);
  const name = decl.name.text;
  let scope: ts.Node = decl;
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let passed = false;
  const look = (n: ts.Node) => {
    if (passed) return;
    const key = ts.isShorthandPropertyAssignment(n) && n.name.text === name ? name
      : ts.isPropertyAssignment(n) && ts.isIdentifier(n.initializer) && n.initializer.text === name ? keyOf(n.name) : null;
    if (key !== null && WRITE_KEY.test(key) && inWrite(n, seen)) passed = true;
    else ts.forEachChild(n, look);
  };
  look(scope);
  return passed;
}

/** Each way `source` creates a meeting, or could, outside the helper. */
function meetingCreates(source: string, fileName = "x.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (n: ts.Node, what: string) => found.push(`${what} at line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
  const relation = (n: ts.Node, key: string | null) => key !== null && RELATIONS.includes(key) && (!GENERIC.has(key) || inWrite(n));
  const visit = (n: ts.Node) => {
    if (isModel(n)) {
      const parent = n.parent;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === n) {
        const member = memberOf(parent);
        if (member === null) at(n, "the meeting model used through a computed member");
        else if (CREATE_METHODS.has(member)) at(n, `${member} on the meeting model`);
      } else if (READ_ONLY_VALUE_USES[fileName] !== parent.getText()) {
        at(n, "the meeting model taken as a value");
      }
    }
    // `const { syncMeeting } = prisma`, `const { syncMeeting: m } = tx`
    if (ts.isBindingElement(n) && keyOf(n.propertyName ?? n.name) === MODEL) at(n, "the meeting model destructured");
    // `["keyResultLink", "syncMeeting"]` looped over with `tx[model]`
    if (isText(n) && MODEL_NAME.test(n.text) && !isKey(n) && !(ts.isElementAccessExpression(n.parent) && isModel(n.parent))) {
      at(n, `the model's name "${n.text}" in a string`);
    }
    // `{ syncMeetings }` in another model's write
    if (ts.isShorthandPropertyAssignment(n) && relation(n, n.name.text)) at(n, `a write through ${n.name.text} this scan can't read`);
    if (ts.isPropertyAssignment(n)) {
      const key = keyOf(n.name);
      if (relation(n, key)) {
        const value = n.initializer;
        if (!ts.isObjectLiteralExpression(value)) at(n, `a write through ${key} this scan can't read`);
        else {
          // `{ syncMeetings: { create: … } }`; a spread or computed key inside it can't be read.
          const keys = value.properties.map((p) => (ts.isSpreadAssignment(p) || !p.name ? null : keyOf(p.name)));
          if (keys.some((k) => k === null)) at(n, `a write through ${key} this scan can't read`);
          else if (keys.some((k) => NESTED_CREATES.has(k!))) at(n, `a nested create through ${key}`);
        }
      }
    }
    const text = literalText(n);
    if (text !== null) {
      if (WRITES_TABLE.test(text)) at(n, "raw SQL writing into sync_meetings");
      else if (TABLE_NAMED_IN[fileName]) {
        if (WRITE_WORD.test(text)) at(n, "an INSERT or COPY in a file allowed to name sync_meetings");
      } else if (TABLE.test(text)) at(n, "the table's name sync_meetings in a string");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("meetings are created only through createSyncMeeting", () => {
  const byFile = walk("src").map((f) => ({ f, found: meetingCreates(readFileSync(f, "utf8"), f) }));

  it("reads the meeting relations from the schema, and finds the helper's own create", () => {
    // Exactly these: a model line (`model SyncMeeting {`) once read as a relation named "model".
    expect([...RELATIONS].sort()).toEqual(["meeting", "meetingInvitesOrganized", "meetings", "meetingsHostingTeams", "syncMeetings"]);
    expect(byFile.find((x) => x.f === HELPER)?.found).toEqual([expect.stringMatching(/^create on the meeting model at line \d+$/)]);
  });

  it("catches each pattern it claims to (positive controls), and not reads, comments or prose", () => {
    const one = (src: string) => meetingCreates(src);
    expect(one("await tx.syncMeeting.create({ data })")).toEqual(["create on the meeting model at line 1"]);
    expect(one("prisma.syncMeeting\n  .upsert({ where, create, update })")).toEqual(["upsert on the meeting model at line 1"]);
    expect(one('await prisma["syncMeeting"].createMany({ data })')).toEqual(["createMany on the meeting model at line 1"]);
    expect(one('await prisma.syncMeeting["createManyAndReturn"]({ data })')).toEqual(["createManyAndReturn on the meeting model at line 1"]);
    expect(one("await tx.syncMeeting[op]({ data })")).toEqual(["the meeting model used through a computed member at line 1"]);
    expect(one("const { syncMeeting } = prisma;\nawait syncMeeting.create({ data })")).toEqual(["the meeting model destructured at line 1"]);
    expect(one("const { syncMeeting: m } = tx;\nawait m.create({ data })")).toEqual(["the meeting model destructured at line 1"]);
    expect(one("const m = prisma.syncMeeting;\nawait m.create({ data })")).toEqual(["the meeting model taken as a value at line 1"]);
    expect(one("await insertAll(tx.syncMeeting, rows)")).toEqual(["the meeting model taken as a value at line 1"]);
    // The model's name in a string: work-items/merge.server.ts's loop, with the meeting model added.
    expect(one([
      "for (const [model, key] of [",
      '  ["keyResultLink", "keyResultId"],',
      '  ["syncMeeting", "orgId"],',
      "] as const) {",
      "  const delegate = tx[model] as unknown as { createMany: (a: object) => Promise<unknown> };",
      "  await delegate.createMany({ data: rows.map((r) => ({ orgId, [key]: r[key] })) });",
      "}",
    ].join("\n"))).toEqual(['the model\'s name "syncMeeting" in a string at line 3']);
    expect(one("const which = `SyncMeetings`;")).toEqual(['the model\'s name "SyncMeetings" in a string at line 1']);
    // Nested creates, read and unread.
    expect(one("await prisma.organization.update({ where, data: { syncMeetings: { create: { title } } } })"))
      .toEqual(["a nested create through syncMeetings at line 1"]);
    expect(one("await prisma.syncMeetingAttendee.create({ data: { userId, meeting: { connectOrCreate: x } } })"))
      .toEqual(["a nested create through meeting at line 1"]);
    expect(one("await prisma.organization.update({ where, data: { syncMeetings } })"))
      .toEqual(["a write through syncMeetings this scan can't read at line 1"]);
    expect(one("await tx.meetingType.update({ where, data: { meetings: nested } })"))
      .toEqual(["a write through meetings this scan can't read at line 1"]);
    expect(one("await tx.meetingType.update({ where, data: { meetings: { ...nested } } })"))
      .toEqual(["a write through meetings this scan can't read at line 1"]);
    expect(one("await tx.meetingType.update({ where, data: { ...base, ...(more && { meetings: nested }) } })"))
      .toEqual(["a write through meetings this scan can't read at line 1"]);
    expect(one("const data = { userId, meeting: nested };\nawait prisma.syncMeetingAttendee.create({ data })"))
      .toEqual(["a write through meeting this scan can't read at line 1"]);
    expect(one("const row = { userId, meeting: nested };\nawait tx.syncMeetingAttendee.create({ data: row })"))
      .toEqual(["a write through meeting this scan can't read at line 1"]);
    expect(one("const extra = { meetingsHostingTeams: rows };")).toEqual(["a write through meetingsHostingTeams this scan can't read at line 1"]);
    // The table's name: SQL that writes it, and any other mention, however assembled.
    expect(one("await prisma.$executeRaw`INSERT INTO sync_meetings (id) VALUES (${id})`")).toEqual(["raw SQL writing into sync_meetings at line 1"]);
    expect(one('await prisma.$executeRawUnsafe(\'insert into "public"."sync_meetings" (id) values ($1)\', id)'))
      .toEqual(["raw SQL writing into sync_meetings at line 1"]);
    expect(one("await prisma.$executeRawUnsafe(`COPY sync_meetings (id) FROM STDIN`)")).toEqual(["raw SQL writing into sync_meetings at line 1"]);
    expect(one('await prisma.$executeRawUnsafe("INSERT INTO " + "sync_meetings" + " (id) VALUES ($1)", id)'))
      .toEqual(["the table's name sync_meetings in a string at line 1"]);
    expect(one('const t = "SYNC_MEETINGS";')).toEqual(["the table's name sync_meetings in a string at line 1"]);
    // A `//` inside a string is not a comment: the create after it still counts.
    expect(one('const u = "a//b"; await tx.syncMeeting.create({})')).toEqual(["create on the meeting model at line 1"]);
    // Not creates: reads and updates, a relation read or connect, comments, prose, other tables,
    // and `meeting`/`meetings` as plain words outside a write.
    expect(one("await prisma.syncMeeting.update({ where, data }); await tx.syncMeeting.findMany({})")).toEqual([]);
    expect(one("await prisma.syncMeetingAttendee.create({ data: { userId, meeting: { connect: { id } } } })")).toEqual([]);
    expect(one("// prisma.syncMeeting.create(\n/* tx.syncMeeting.upsert( */ const s = 'prisma.syncMeeting.create(';")).toEqual([]);
    expect(one("await prisma.$executeRaw`INSERT INTO sync_meeting_attendees (id) VALUES (${id})`")).toEqual([]);
    expect(one('throw new Error("trigger sync_meetings_teams_link_needs_host")')).toEqual([]);
    expect(one("return { created: true, meeting: made.meeting, meetings, metadata: { meetings: String(n) } };")).toEqual([]);
    // An export named `data` that no write receives (export/json/route.ts).
    expect(one("const data = { version: 1, meetings: rows };\nreturn new Response(JSON.stringify(data));")).toEqual([]);
  });

  it("the read-only use it allows is still there, exactly as recorded", () => {
    for (const [file, text] of Object.entries(READ_ONLY_VALUE_USES)) expect(readFileSync(file, "utf8")).toContain(text);
    expect(meetingCreates("const x = d(prisma.syncMeeting)", "src/lib/mentions/registry.server.ts")).toEqual([]);
    expect(meetingCreates("const x = e(prisma.syncMeeting)", "src/lib/mentions/registry.server.ts")).toEqual([
      "the meeting model taken as a value at line 1",
    ]);
  });

  it("each file allowed to name the table still does, and the allowance can't pass a write", () => {
    const strings = (file: string) => {
      const out: string[] = [];
      const visit = (n: ts.Node) => { const t = literalText(n); if (t !== null) out.push(t); ts.forEachChild(n, visit); };
      visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
      return out;
    };
    for (const file of Object.keys(TABLE_NAMED_IN)) {
      expect(strings(file).some((s) => TABLE.test(s)), `${file} still names sync_meetings`).toBe(true);
      expect(strings(file).filter((s) => WRITE_WORD.test(s)), `${file} has no INSERT or COPY`).toEqual([]);
    }
    // In an allowed file, the name alone passes; a write assembled beside it does not.
    const rag = "src/lib/ai/executors/rag.ts";
    expect(meetingCreates('const t = "sync_meetings";', rag)).toEqual([]);
    expect(meetingCreates('const t = "sync_meetings";\nawait db.$executeRawUnsafe("insert into " + t)', rag))
      .toEqual(["an INSERT or COPY in a file allowed to name sync_meetings at line 2"]);
    expect(meetingCreates("await db.$executeRawUnsafe(`COPY \"sync_meetings\" FROM STDIN`)", rag))
      .toEqual(["raw SQL writing into sync_meetings at line 1"]);
  });

  it("no other file in the app creates a meeting, or takes the model where a create could hide", () => {
    expect(byFile.filter((x) => x.f !== HELPER && x.found.length).map((x) => `${x.f}: ${x.found.join("; ")}`)).toEqual([]);
  });
});
