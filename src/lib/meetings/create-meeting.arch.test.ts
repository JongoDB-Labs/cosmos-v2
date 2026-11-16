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
 *   and the other create methods;
 * - the model taken as a value (aliased, destructured, passed on), which would
 *   let a create happen out of this scan's sight. The one such use today, the
 *   mention registry, casts it to a type with nothing but `findMany`;
 * - a nested create through any relation to the model (`organization.update({
 *   data: { syncMeetings: { create } } })`), the relation names read from the
 *   schema;
 * - raw SQL that inserts into `sync_meetings`.
 *
 * Parsed with the TypeScript compiler, so comments are never code and a `//`
 * inside a string can't hide what follows it.
 */
const HELPER = "src/lib/meetings/create-meeting.server.ts";
const MODEL = "syncMeeting";
const CREATE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);
const NESTED_CREATES = new Set(["create", "createMany", "connectOrCreate", "upsert"]);
const INSERT = /\binsert\s+into\s+(?:"?\w+"?\.)?"?sync_meetings"?(?![\w])/i;
/** Read-only uses of the model as a value, each with why it can't create. */
const READ_ONLY_VALUE_USES: Record<string, string> = {
  // `d()` casts to `Delegate`, a type with only `findMany` (registry.server.ts).
  "src/lib/mentions/registry.server.ts": "d(prisma.syncMeeting)",
};

/** The relation fields that hold meetings, from the schema (`syncMeetings SyncMeeting[]` and the like). */
const RELATIONS = [
  ...readFileSync("prisma/schema.prisma", "utf8").matchAll(/^\s+(\w+)\s+SyncMeeting(?:\[\]|\?)?(?=\s|$)/gm),
].map((m) => m[1]);

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

const nameOf = (n: ts.Node): string | null =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;

/** `x.syncMeeting` or `x["syncMeeting"]`: the model's delegate. */
const isModel = (n: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(n) && n.name.text === MODEL) ||
  (ts.isElementAccessExpression(n) && nameOf(n.argumentExpression) === MODEL);

/** The member a delegate is used through, when it is used through one. */
const memberOf = (n: ts.Node): string | null =>
  ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) ? nameOf(n.argumentExpression) : null;

/** The text of a string or template, its substitutions left out. */
function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => ` ${s.literal.text}`).join("");
  return null;
}

/** Each way `source` creates a meeting, or could, outside the helper. */
function meetingCreates(source: string, fileName = "x.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (n: ts.Node, what: string) => found.push(`${what} at line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
  const visit = (n: ts.Node) => {
    if (isModel(n)) {
      const parent = n.parent;
      const member = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === n ? memberOf(parent) : null;
      if (member !== null) {
        if (CREATE_METHODS.has(member)) at(n, `${member} on the meeting model`);
      } else if (READ_ONLY_VALUE_USES[fileName] !== parent.getText()) {
        at(n, "the meeting model taken as a value");
      }
    }
    // `const { syncMeeting } = prisma`, `const { syncMeeting: m } = tx`
    if (ts.isBindingElement(n) && nameOf(n.propertyName ?? n.name) === MODEL) at(n, "the meeting model destructured");
    // `{ syncMeetings: { create: … } }` in another model's write
    if (ts.isPropertyAssignment(n) && RELATIONS.includes(nameOf(n.name) ?? "") && ts.isObjectLiteralExpression(n.initializer)) {
      const keys = n.initializer.properties.map((p) => (p.name ? nameOf(p.name) : null));
      if (keys.some((k) => k !== null && NESTED_CREATES.has(k))) at(n, `a nested create through ${nameOf(n.name)}`);
    }
    const text = literalText(n);
    if (text !== null && INSERT.test(text)) at(n, "raw SQL inserting into sync_meetings");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("meetings are created only through createSyncMeeting", () => {
  const byFile = walk("src").map((f) => ({ f, found: meetingCreates(readFileSync(f, "utf8"), f) }));

  it("reads the meeting relations from the schema, and finds the helper's own create", () => {
    expect(RELATIONS).toEqual(expect.arrayContaining(["syncMeetings", "meetings", "meeting"]));
    expect(byFile.find((x) => x.f === HELPER)?.found).toEqual([expect.stringMatching(/^create on the meeting model at line \d+$/)]);
  });

  it("catches each pattern it claims to (positive controls), and not reads, comments or prose", () => {
    const one = (src: string) => meetingCreates(src);
    expect(one("await tx.syncMeeting.create({ data })")).toEqual(["create on the meeting model at line 1"]);
    expect(one("prisma.syncMeeting\n  .upsert({ where, create, update })")).toEqual(["upsert on the meeting model at line 1"]);
    expect(one('await prisma["syncMeeting"].createMany({ data })')).toEqual(["createMany on the meeting model at line 1"]);
    expect(one('await prisma.syncMeeting["createManyAndReturn"]({ data })')).toEqual(["createManyAndReturn on the meeting model at line 1"]);
    expect(one("const { syncMeeting } = prisma;\nawait syncMeeting.create({ data })")).toEqual(["the meeting model destructured at line 1"]);
    expect(one("const { syncMeeting: m } = tx;\nawait m.create({ data })")).toEqual(["the meeting model destructured at line 1"]);
    expect(one("const m = prisma.syncMeeting;\nawait m.create({ data })")).toEqual(["the meeting model taken as a value at line 1"]);
    expect(one("await insertAll(tx.syncMeeting, rows)")).toEqual(["the meeting model taken as a value at line 1"]);
    expect(one("await prisma.organization.update({ where, data: { syncMeetings: { create: { title } } } })"))
      .toEqual(["a nested create through syncMeetings at line 1"]);
    expect(one("await prisma.syncMeetingAttendee.create({ data: { userId, meeting: { connectOrCreate: x } } })"))
      .toEqual(["a nested create through meeting at line 1"]);
    expect(one("await prisma.$executeRaw`INSERT INTO sync_meetings (id) VALUES (${id})`")).toEqual(["raw SQL inserting into sync_meetings at line 1"]);
    expect(one('await prisma.$executeRawUnsafe(\'insert into "public"."sync_meetings" (id) values ($1)\', id)'))
      .toEqual(["raw SQL inserting into sync_meetings at line 1"]);
    // A `//` inside a string is not a comment: the create after it still counts.
    expect(one('const u = "a//b"; await tx.syncMeeting.create({})')).toEqual(["create on the meeting model at line 1"]);
    // Not creates: reads and updates, a relation read or connect, comments, prose, other tables.
    expect(one("await prisma.syncMeeting.update({ where, data }); await tx.syncMeeting.findMany({})")).toEqual([]);
    expect(one("await prisma.syncMeetingAttendee.create({ data: { userId, meeting: { connect: { id } } } })")).toEqual([]);
    expect(one("// prisma.syncMeeting.create(\n/* tx.syncMeeting.upsert( */ const s = 'prisma.syncMeeting.create(';")).toEqual([]);
    expect(one("await prisma.$executeRaw`INSERT INTO sync_meeting_attendees (id) VALUES (${id})`")).toEqual([]);
  });

  it("the read-only use it allows is still there, exactly as recorded", () => {
    for (const [file, text] of Object.entries(READ_ONLY_VALUE_USES)) expect(readFileSync(file, "utf8")).toContain(text);
    expect(meetingCreates("const x = d(prisma.syncMeeting)", "src/lib/mentions/registry.server.ts")).toEqual([]);
    expect(meetingCreates("const x = e(prisma.syncMeeting)", "src/lib/mentions/registry.server.ts")).toEqual([
      "the meeting model taken as a value at line 1",
    ]);
  });

  it("no other file in the app creates a meeting, or takes the model where a create could hide", () => {
    expect(byFile.filter((x) => x.f !== HELPER && x.found.length).map((x) => `${x.f}: ${x.found.join("; ")}`)).toEqual([]);
  });
});
