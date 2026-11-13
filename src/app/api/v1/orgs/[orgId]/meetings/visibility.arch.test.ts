import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * One rule decides who reads a meeting (lib/meetings/meeting-reader.ts): its
 * project visible to the caller AND MEETING_READ passing for it. Every door
 * asks it: each handler under a meeting id (through `canReadMeeting`, or
 * `meetingReader` which calls it), the list, and Cosmo's meeting tools. Two
 * doors that asked different questions showed the same person different
 * meetings. A new door that forgets fails here.
 *
 * Parsed with the TypeScript compiler rather than matched by regex, so only a
 * real call counts: the name in a comment or a string never does.
 */
const BY_ID = "src/app/api/v1/orgs/[orgId]/meetings/[meetingId]";
const RULE = new Set(["canReadMeeting", "meetingReader", "readableMeetingsWhere"]);

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routes(p);
    return name === "route.ts" ? [p] : [];
  });
}

/** Each exported function in `source`, with the names of the functions it calls. */
export function calls(source: string, fileName = "x.ts"): Map<string, Set<string>> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map<string, Set<string>>();
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name || !st.body) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const called = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        if (ts.isIdentifier(c)) called.add(c.text);
        else if (ts.isPropertyAccessExpression(c)) called.add(c.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(st.body);
    out.set(st.name.text, called);
  }
  return out;
}

const HANDLER = /^(GET|POST|PUT|PATCH|DELETE)$/;
const asks = (called: Set<string> | undefined) => !!called && [...called].some((c) => RULE.has(c));

describe("every meeting door asks the one meeting-read rule", () => {
  const files = routes(BY_ID);

  it("finds the routes it guards (a positive control for the scan)", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.some((f) => f.endsWith(join("[meetingId]", "route.ts")))).toBe(true);
    const handlers = files.flatMap((f) => [...calls(readFileSync(f, "utf8"), f).keys()].filter((n) => HANDLER.test(n)));
    expect(handlers.length).toBeGreaterThanOrEqual(14);
  });

  it("each handler under a meeting id", () => {
    const missing = files.flatMap((f) =>
      [...calls(readFileSync(f, "utf8"), f)].filter(([name, c]) => HANDLER.test(name) && !asks(c)).map(([name]) => `${f}: ${name}`),
    );
    expect(missing, "call canReadMeeting(ctx, meeting.projectId) or meetingReader(orgId, meetingId)").toEqual([]);
  });

  it("the list, Cosmo's list, update and delete, and the calendar feed", () => {
    const list = calls(readFileSync("src/app/api/v1/orgs/[orgId]/meetings/route.ts", "utf8")).get("GET");
    expect(list?.has("readableMeetingsWhere") && list.has("canReadMeeting")).toBe(true);
    expect(list?.has("getReadableProjectIds")).toBe(false); // the work-item rule, not the meeting one
    const cosmo = calls(readFileSync("src/lib/ai/executors/meetings.ts", "utf8"));
    for (const tool of ["listMeetings", "updateMeeting", "deleteMeeting"]) expect(asks(cosmo.get(tool)), tool).toBe(true);
    const feed = calls(readFileSync("src/lib/calendar/feed.server.ts", "utf8")).get("renderFeed");
    expect(feed?.has("readableMeetingsWhere")).toBe(true);
  });

  it("the rule itself: the MEETING_READ bit, policies on MEETING_READ, and the project's visibility", () => {
    const src = readFileSync("src/lib/meetings/meeting-reader.ts", "utf8");
    const fns = calls(src);
    expect(fns.get("meetingReader")?.has("requirePermission")).toBe(true);
    expect(fns.get("meetingReader")?.has("canReadMeeting")).toBe(true);
    // Under a project: the shared project-read rule (key scope, team scope,
    // bit, policies), asked about MEETING_READ rather than its ITEM_READ default.
    expect(fns.get("meetingReadScope")?.has("getReadableProjectIds")).toBe(true);
    expect(fns.get("canReadMeeting")?.has("getReadableProjectIds")).toBe(true);
    expect(src.match(/getReadableProjectIds\(ctx\)/g)).toBeNull();
    expect(src.match(/getReadableProjectIds\(ctx, "MEETING_READ"\)/g)).toHaveLength(2);
    // Under no project: the bit and policies on MEETING_READ.
    expect(fns.get("canReadMeeting")?.has("orgLevelMeetingRead")).toBe(true);
    expect(src).toMatch(/requirePermission\(ctx, Permission\.MEETING_READ\)/);
    expect(src).toMatch(/action: "MEETING_READ"/);
  });

  it("counts only real calls: a name in a comment or a string is not a gate", () => {
    const fake = [
      "export async function GET() {",
      "  // canReadMeeting(ctx, meeting.projectId)",
      "  /* meetingReader(orgId, meetingId) */",
      '  const s = "canReadMeeting(ctx, p)";',
      "  const t = `meetingReader(o, m)`;",
      "  return findFirst({ where: { id } });",
      "}",
      "export async function PUT() { if (!(await canReadMeeting(ctx, p))) return null; }",
      "export async function DELETE() { const r = await lib.meetingReader(o, m); }",
    ].join("\n");
    const c = calls(fake);
    expect([...c].filter(([n, x]) => HANDLER.test(n) && !asks(x)).map(([n]) => n)).toEqual(["GET"]);
  });
});
