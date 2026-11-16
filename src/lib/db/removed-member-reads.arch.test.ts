// Every read that reaches an org membership must say whether it wants removed members.
//
// Removal is a soft delete: the `org_members` row survives with `removedAt` set,
// and so do the rows that hang off it (project, team and work-role
// memberships), so a reinstatement brings them back. src/lib/db/client.ts hides
// removed rows from direct `orgMember` reads, and from nothing else:
//
//  - a relation read (`include: { members }`, a nested `select`, `_count`, a
//    `some` filter) never reaches that hook, and
//  - neither does a direct read of a model that hangs off the membership
//    (`projectMember`, `teamMember`, `orgMemberWorkRole`), nor a bulk write to
//    one, which is how replacing a work role's roster deleted a removed
//    holder's role.
//
// Unfiltered, the org list and the home page kept listing an org the person
// had left, and project rosters, team rosters, member counts and Cosmo kept
// listing the person.
//
// So every such read either filters `removedAt` itself or is listed here, per
// file, with how many it has and why.
//
// THE SUBJECTS COME FROM prisma/schema.prisma, not from a list kept here:
//  - the models that hang off OrgMember: a required, cascading relation to
//    OrgMember or to one of them, and the path from each back to `removedAt`;
//  - the relation lists that reach OrgMember or one of those models from any
//    OTHER model. A list held by a membership row itself
//    (`OrgMember.projectMembers`, `ProjectMember.teamMembers`) is not judged:
//    its parent is the membership, judged where the parent is read. A to-one
//    pointer (`ProjectMember.orgMember`) cannot take a filter, so its parent
//    read carries one, and an optional one (`ProgramEvent.ownerMember`) is
//    attribution.
//
// A relation key is judged where it sits in the arguments of a delegate call
// (`prisma.team.findMany(...)`, `tx.project.update(...)`): the owning model is
// resolved from the call down through the keys, so `ChatChannel.members` (chat
// rows keyed by user) is told apart from `Team.members`, and a write payload
// (`data: { members: { create } }`) is not judged. Outside a call, `members`
// is an everyday word in props, types and responses, so it is judged only
// under `include`, `select`, `where` or a relation filter, or when its value
// is itself relation arguments (a shared `select` constant). `memberships`
// names one relation only and is judged everywhere, as it was before this
// guard widened.
//
// What counts as filtered is deliberately narrow, because a scan can only see
// text: comments and string contents are blanked first; then the value must be
// an object literal whose OWN `where` (or, in a relation filter, `some`,
// `every` or `none`) reaches `removedAt` along the target model's path, each
// step an object literal, with `removedAt` set to `null` or an object literal.
// A shorthand, a variable, `true`, a quoted key, `removedAt: undefined` or a
// variable, a filter at the wrong depth, and one inside `AND`/`OR` all count as
// unfiltered. A direct read's own argument is judged the same way.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";

// ── the subjects, from the schema ────────────────────────────────────────────

type Field = { name: string; type: string; list: boolean; optional: boolean; cascade: boolean };

function parseSchema(text: string): Map<string, Map<string, Field>> {
  const models = new Map<string, Map<string, Field>>();
  for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, Field>();
    for (const line of m[2].split("\n")) {
      const f = /^\s+(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!f) continue;
      fields.set(f[1], { name: f[1], type: f[2], list: !!f[3], optional: !!f[4], cascade: /onDelete:\s*Cascade/.test(f[5]) });
    }
    models.set(m[1], fields);
  }
  return models;
}

const MODELS = parseSchema(readFileSync("prisma/schema.prisma", "utf8"));
const isModel = (t: string) => MODELS.has(t);
const MEMBERSHIP = "OrgMember";
const delegateOf = (model: string) => model[0].toLowerCase() + model.slice(1);

/** Model → the key path from it to its membership's `removedAt`. */
const REMOVED_PATH = new Map<string, string[]>([[MEMBERSHIP, ["removedAt"]]]);
for (let grew = true; grew; ) {
  grew = false;
  for (const [model, fields] of MODELS) {
    if (REMOVED_PATH.has(model)) continue;
    const up = [...fields.values()].find(
      (f) => isModel(f.type) && !f.list && !f.optional && f.cascade && REMOVED_PATH.has(f.type),
    );
    if (up) {
      REMOVED_PATH.set(model, [up.name, ...REMOVED_PATH.get(up.type)!]);
      grew = true;
    }
  }
}
/** The models that hang off a membership, by delegate name (`projectMember`). */
const HANGING = new Map([...REMOVED_PATH.keys()].filter((m) => m !== MEMBERSHIP).map((m) => [delegateOf(m), m]));
/** `Owner.field` → the target's path, for every relation list reaching a membership from outside one. */
const POLICED = new Map<string, string[]>();
for (const [model, fields] of MODELS) {
  if (REMOVED_PATH.has(model)) continue;
  for (const f of fields.values()) {
    if (f.list && REMOVED_PATH.has(f.type)) POLICED.set(`${model}.${f.name}`, REMOVED_PATH.get(f.type)!);
  }
}
/** Each policed field name → every path it may need (used when the owner cannot be resolved). */
const PATHS_BY_NAME = new Map<string, string[][]>();
for (const [key, path] of POLICED) {
  const name = key.split(".")[1];
  PATHS_BY_NAME.set(name, [...(PATHS_BY_NAME.get(name) ?? []), path]);
}
const NAMES = [...PATHS_BY_NAME.keys()];
const EVERYWHERE = new Set(["memberships"]);
const DELEGATES = new Map([...MODELS.keys()].map((m) => [delegateOf(m), m]));
const OPS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy",
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany",
]);
/** The ops judged on a model that hangs off a membership: reads, and the bulk writes that pick rows by filter. */
const DIRECT_OPS = [
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy",
  "deleteMany", "updateMany",
];
/** Argument keys that stay on the same model. */
const STAY = new Set(["select", "include", "where", "some", "every", "none", "is", "isNot", "AND", "OR", "NOT", "_count", "orderBy", "having"]);
/** Argument keys that open a write payload. */
const WRITE = new Set(["data", "create", "createMany", "update", "updateMany", "upsert", "connect", "connectOrCreate", "set", "disconnect", "delete", "deleteMany"]);
/** Outside a call, the keys under which a policed name is read as a relation. */
const READ_KEYS = new Set(["select", "include", "where", "some", "every", "none"]);
/** A value with one of these at its top level is relation arguments. */
const ARG_KEY = /^(select|include|where|orderBy|take|skip|cursor|distinct|some|every|none)$/;

// ── the allowlist ────────────────────────────────────────────────────────────

const ACTOR =
  "The actor's own rows, keyed by the membership a filtered `orgMember` read just found or by the " +
  "caller's userId. A removed member gets no AuthContext (loadEffectivePermissions answers null), " +
  "so the actor is a current member by construction.";

/** Files whose reads deliberately carry no filter this scan accepts. */
const ALLOWED: Record<string, { sites: number; reason: string }> = {
  "src/lib/auth/sso-provisioned-admin.ts": {
    sites: 1,
    reason:
      "INSTANCE ADMIN VIEW. Lists the orgs an IdP-made account is tied to, for an " +
      "instance admin deciding whether to clear the flag. It grants nothing, and it " +
      "matches auditOrgsFor beside it, which audits into removed orgs on purpose.",
  },
  "src/lib/auth/revoke-invitation.ts": {
    sites: 1,
    reason:
      "A `_count`. Revoking an invitation deletes the account only when nothing " +
      "else refers to it; a retained membership row is history in that org, so it " +
      "must still block the delete.",
  },
  "src/lib/auth/sender-org.ts": {
    sites: 1,
    reason: "A parameter type, not a query. Its one caller passes the filtered reads below.",
  },
  "src/app/api/auth/password/reset/request/route.ts": {
    sites: 1,
    reason:
      "The argument to resolveSenderOrg, built from this file's two reads, which " +
      "the scan accepts as filtered. A third read here would make the count 2.",
  },
  "src/app/(dashboard)/[orgSlug]/team/page.tsx": {
    sites: 1,
    reason:
      "Work-role assignments joined onto the member list above them, which the extension " +
      "filters. A removed member's assignments are loaded and never looked up.",
  },
  "src/app/api/v1/orgs/[orgId]/members/[memberId]/work-roles/route.ts": {
    sites: 2,
    reason:
      "One member's own assignments, read and replaced, keyed by the memberId a filtered " +
      "`orgMember` read just proved current.",
  },
  "src/lib/abac/require-access.ts": { sites: 1, reason: ACTOR },
  "src/lib/ai/executors/people.ts": {
    sites: 1,
    reason:
      "get_person: the person's own projects, keyed by the membership a filtered " +
      "`orgMember` read just found. A removed person is refused before this read.",
  },
  "src/lib/ai/executors/rag.ts": { sites: 1, reason: ACTOR },
  "src/lib/calendar/feed.server.ts": {
    sites: 1,
    reason:
      "The feed owner's own sprints. The feed answers nothing unless " +
      "loadEffectivePermissions finds the owner a current member, just above.",
  },
  "src/lib/members/scoped-roster.server.ts": {
    sites: 1,
    reason:
      "A CEILING, not a list: who a project-scoped key may see. It holds the projects' " +
      "creators, assignees and commenters too, departed ones included, so their names " +
      "still resolve on the work they left; every list it narrows filters its own rows.",
  },
  "src/lib/pm/subjects.ts": {
    sites: 1,
    reason:
      "RESOLUTION: the title of a staffing row another record already points at. History " +
      "keeps its name after the person leaves, as an author or assignee does.",
  },
  "src/lib/projects/membership.server.ts": {
    sites: 4,
    reason:
      "The target's current project role, by its unique key (the count of OTHER managers " +
      "beside it filters); the team-membership lookup for a project member the line above " +
      "proved current; and the two targeted removals, which delete exactly the row an " +
      "administrator named.",
  },
  "src/lib/query/resolve.server.ts": {
    sites: 1,
    reason: "`myTeams()` reads the actor's own teams (see ACTOR).",
  },
  "src/lib/query/saved-filters.server.ts": { sites: 1, reason: ACTOR },
  "src/lib/query/subscriptions.server.ts": {
    sites: 1,
    reason:
      "A team subscription's recipients. Each one is re-checked with " +
      "loadMemberAuthContext, which answers null for a removed member, and skipped.",
  },
  "src/lib/rbac/foreign-refs.ts": {
    sites: 1,
    reason:
      "The `memberOrFormer` rule: a count that checks a written id names someone the " +
      "org has had as a member, removed or not, for a write that carries history " +
      "forward (a merge keeps a removed member's assignment). It returns no rows and " +
      "grants nothing; requests that name a person use the `member` rule.",
  },
  "src/lib/rbac/project-access.ts": {
    sites: 4,
    reason:
      ACTOR +
      " `projectReaders` reads other people's rows the same way: keyed by the ids a " +
      "filtered `orgMember` read just found, so only current members are judged.",
  },
  "src/lib/rbac/project-role.ts": { sites: 1, reason: ACTOR },
  "src/lib/rbac/scope.ts": { sites: 2, reason: ACTOR },
  "src/lib/rbac/team-membership.ts": { sites: 1, reason: ACTOR },
  "src/lib/work-items/query/scope.ts": { sites: 2, reason: ACTOR },
  "src/lib/workflow/engine.server.ts": { sites: 2, reason: ACTOR },
};

// ── the scan ─────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * The source with comments and string contents blanked to spaces, newlines kept
 * so line numbers survive. A string whose whole content is a policed name is
 * kept, so a quoted key can be judged. Regex literals are skipped by the usual
 * rule: a `/` starts one where an expression may begin.
 */
function blank(src: string): string {
  const out = src.split("");
  const clear = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let prev = ""; // last significant character outside comments and strings
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      clear(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      clear(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      if (!NAMES.includes(src.slice(i + 1, j))) clear(i + 1, j);
      i = j + 1;
      prev = c;
    } else if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      clear(i + 1, j);
      i = j + 1;
      prev = "/";
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join("");
}

/** End index (exclusive) of the bracketed block opening at `open`, or -1. */
function blockEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if ("{[(".includes(s[i])) depth++;
    else if ("}])".includes(s[i]) && --depth === 0) return i + 1;
  }
  return -1;
}

/** The keys at the top level of the object literal `{ ... }` and where each value starts. */
function topLevelKeys(block: string): { key: string; at: number }[] {
  const keys: { key: string; at: number }[] = [];
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if ("{[(".includes(c)) {
      depth++;
      continue;
    }
    if ("}])".includes(c)) {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(block.slice(i));
    if (m && /[{,]\s*$/.test(block.slice(0, i))) {
      keys.push({ key: m[1], at: i + m[0].length });
      i += m[0].length - 1;
    }
  }
  return keys;
}

const valueAt = (s: string, at: number) => s.slice(at).replace(/^\s+/, "");
/** The object literal starting at the first non-space after `at`, or null. */
const objectAt = (s: string, at: number): string | null => {
  const v = valueAt(s, at);
  if (!v.startsWith("{")) return null;
  const end = blockEnd(v, 0);
  return end === -1 ? null : v.slice(0, end);
};

/** Whether the object literal `block` reaches `removedAt` along `path`, each step an object literal. */
function reaches(block: string, path: string[]): boolean {
  const [step, ...rest] = path;
  for (const k of topLevelKeys(block)) {
    if (k.key !== step) continue;
    if (rest.length === 0) {
      const v = valueAt(block, k.at);
      return /^null\b/.test(v) || v.startsWith("{");
    }
    const inner = objectAt(block, k.at);
    return inner !== null && reaches(inner, rest);
  }
  return false;
}

/** Whether a relation's value filters along one of `paths` in its own `where`, `some`, `every` or `none`. */
function relationFiltered(block: string, paths: string[][]): boolean {
  return topLevelKeys(block).some((k) => {
    if (!["where", "some", "every", "none"].includes(k.key)) return false;
    const inner = objectAt(block, k.at);
    return inner !== null && paths.some((p) => reaches(inner, p));
  });
}

/** Index of the nearest unmatched opening bracket before `at`, or -1. */
function opener(s: string, at: number): number {
  let depth = 0;
  for (let j = at - 1; j >= 0; j--) {
    const c = s[j];
    if ("}])".includes(c)) depth++;
    else if ("{[(".includes(c)) {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

type Place = { model: string | null; path: string[]; inner: string | null };

/**
 * Where the key at `at` sits: the model of the delegate call whose arguments
 * hold it (null outside one), and the keys from that call's argument down to
 * the key's own object. Arrays are passed through; any other bracket that is
 * not a delegate call ends the walk.
 */
function placeOf(s: string, at: number): Place {
  const keys: string[] = [];
  let model: string | null = null;
  for (let i = at; ; ) {
    const j = opener(s, i);
    if (j === -1) break;
    const before = s.slice(Math.max(0, j - 200), j);
    if (s[j] === "[") {
      i = j;
      continue;
    }
    if (s[j] === "{") {
      const key = /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(before);
      if (key) keys.push(key[1]);
      else if (!/[[,(]\s*$/.test(before)) break;
      i = j;
      continue;
    }
    const call = /\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*$/.exec(before);
    if (call && DELEGATES.has(call[1]) && OPS.has(call[2])) model = DELEGATES.get(call[1])!;
    break;
  }
  return { model, inner: keys[0] ?? null, path: keys.reverse() };
}

/** The model owning the key at the end of `path`, walking from `model`; "write" in a write payload; null if unknown. */
function ownerOf(model: string, path: string[]): string | "write" | null {
  let m = model;
  for (const k of path) {
    if (WRITE.has(k)) return "write";
    if (STAY.has(k)) continue;
    const f = MODELS.get(m)?.get(k);
    if (!f || !isModel(f.type)) return null;
    m = f.type;
  }
  return m;
}

type Site = { line: number; filtered: boolean; shape: string; subject: string; kind: "relation" | "direct" };

/** Every read in `src` that reaches a membership, judged. */
function judge(src: string): Site[] {
  const s = blank(src);
  const out: Site[] = [];
  const line = (at: number) => s.slice(0, at).split("\n").length;
  const names = NAMES.join("|");

  /** A key of a policed name at `at`, its value (if any) at `valueFrom`: judge it if it is a relation read. */
  const consider = (at: number, name: string, valueFrom: number | null, fixedShape: string | null) => {
    const place = placeOf(s, at);
    const value = valueFrom === null ? null : objectAt(s, valueFrom);
    const raw = valueFrom === null ? "" : valueAt(s, valueFrom);
    let paths = PATHS_BY_NAME.get(name)!;
    let subject = `${name} (owner unresolved)`;
    if (place.model) {
      const owner = ownerOf(place.model, place.path);
      if (owner === "write") return;
      if (owner !== null) {
        const p = POLICED.get(`${owner}.${name}`);
        if (!p) return; // a different relation of the same name, e.g. ChatChannel.members
        paths = [p];
        subject = `${owner}.${name}`;
      }
    } else {
      const isArgs = value !== null && topLevelKeys(value).some((k) => ARG_KEY.test(k.key));
      const underRead = place.inner !== null && READ_KEYS.has(place.inner);
      if (!EVERYWHERE.has(name) && !underRead && !isArgs) return;
    }
    let shape = fixedShape ?? "variable";
    let filtered = false;
    if (!fixedShape) {
      if (/^true\b/.test(raw)) shape = "true";
      else if (value !== null) {
        shape = "object";
        filtered = relationFiltered(value, paths);
      }
    }
    out.push({ line: line(at), filtered, shape, subject, kind: "relation" });
  };

  // A quoted key: never accepted, whatever follows.
  for (const m of s.matchAll(new RegExp(`(["'])(${names})\\1\\s*:`, "g"))) consider(m.index ?? 0, m[2], null, "quoted key");
  // A shorthand property, `{ members }` or `{ a, members, b }`.
  for (const m of s.matchAll(new RegExp(`(?<=[{,]\\s*)(${names})(?=\\s*[,}])`, "g"))) consider(m.index ?? 0, m[1], null, "shorthand");
  // A plain key: judge its value.
  for (const m of s.matchAll(new RegExp(`(?<![.\\w$"'])(${names})\\s*:(?!:)`, "g"))) {
    consider(m.index ?? 0, m[1], (m.index ?? 0) + m[0].length, null);
  }

  // A direct read of a model that hangs off a membership: judge its own `where`.
  const delegates = [...HANGING.keys()].join("|");
  for (const m of s.matchAll(new RegExp(`\\.(${delegates})\\.(${DIRECT_OPS.join("|")})\\s*\\(`, "g"))) {
    const argAt = (m.index ?? 0) + m[0].length;
    const arg = objectAt(s, argAt);
    let shape = valueAt(s, argAt).startsWith(")") ? "no argument" : "variable";
    let filtered = false;
    if (arg !== null) {
      shape = "object";
      const where = topLevelKeys(arg).find((k) => k.key === "where");
      const inner = where ? objectAt(arg, where.at) : null;
      filtered = inner !== null && reaches(inner, REMOVED_PATH.get(HANGING.get(m[1])!)!);
    }
    out.push({ line: line(m.index ?? 0), filtered, shape, subject: `${m[1]}.${m[2]}`, kind: "direct" });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ── the judge, on fixtures ───────────────────────────────────────────────────

const one = (src: string) => {
  const sites = judge(src);
  expect(sites, src).toHaveLength(1);
  return sites[0];
};

describe("the subjects", () => {
  it("are derived from the schema (control)", () => {
    // A parser that found fewer would police less without saying so.
    expect([...HANGING.values()]).toEqual(expect.arrayContaining(["ProjectMember", "TeamMember", "OrgMemberWorkRole"]));
    expect(REMOVED_PATH.get("TeamMember")).toEqual(["projectMember", "orgMember", "removedAt"]);
    expect([...POLICED.keys()]).toEqual(
      expect.arrayContaining(["Organization.members", "User.memberships", "Project.members", "Team.members", "WorkRole.members"]),
    );
  });

  it("leave out lists held by a membership row, and relations that are not memberships", () => {
    for (const k of ["OrgMember.projectMembers", "OrgMember.workRoles", "ProjectMember.teamMembers", "ChatChannel.members"]) {
      expect(POLICED.has(k), k).toBe(false);
    }
    expect(HANGING.has("programEvent")).toBe(false);
  });
});

describe("the judge", () => {
  it("accepts a memberships read that filters removedAt in its own where (control)", () => {
    expect(one(`x.findUnique({ include: { memberships: { where: { removedAt: null }, include: { org: true } } } })`).filtered).toBe(true);
    expect(one(`select: { memberships: { where: { orgId, removedAt: null }, select: { orgId: true } } }`).filtered).toBe(true);
    expect(one(`where: { memberships: { some: { orgId: id, removedAt: null } } }`).filtered).toBe(true);
    expect(one(`memberships: { where: { removedAt: { not: null } } }`).filtered).toBe(true);
  });

  it.each([
    ["no where", `include: { memberships: { include: { org: true } } }`],
    ["true", `include: { memberships: true }`],
    ["a variable", `include: { memberships: membershipArgs }`],
    ["a shorthand", `include: { memberships }`],
    ["a shorthand among others", `include: { org, memberships, sessions: true }`],
    ["a quoted key", `include: { "memberships": { where: { removedAt: null } } }`],
    ["removedAt: undefined", `include: { memberships: { where: { removedAt: undefined } } }`],
    ["removedAt from a variable", `include: { memberships: { where: { removedAt: maybe } } }`],
    ["removedAt nested deeper", `include: { memberships: { where: { AND: [{ removedAt: null }] } } }`],
    ["removedAt in another key's block", `include: { memberships: { include: { org: { where: { removedAt: null } } } } }`],
    // Each of these reads as filtered unless its comment or string is blanked.
    ["a where only in a line comment", `include: { memberships: { include: { org: true }, // , where: { removedAt: null }\n } }`],
    ["a where only in a block comment", `include: { memberships: { take: 5 /*, where: { removedAt: null } */\n } }`],
    ["a where only in a string", `include: { memberships: { include: { org: true }, note: ", where: { removedAt: null }" } }`],
  ])("counts a memberships read with %s as unfiltered", (_name, src) => {
    expect(one(src).filtered).toBe(false);
  });

  it.each([
    ["an org's members", `prisma.organization.findUnique({ include: { members: { where: { removedAt: null } } } })`],
    ["a project's members", `prisma.project.findFirst({ include: { members: { where: { orgMember: { removedAt: null } } } } })`],
    ["a team's members", `prisma.team.findMany({ select: { members: { where: { projectMember: { orgMember: { removedAt: null } } }, select: { id: true } } } })`],
    ["a filtered relation count", `prisma.workRole.findMany({ include: { _count: { select: { members: { where: { orgMember: { removedAt: null } } } } } } })`],
    ["a relation filter, through a to-one", `prisma.interval.findMany({ where: { project: { members: { some: { orgMember: { userId, removedAt: null } } } } } })`],
    ["a direct read", `prisma.projectMember.findMany({ where: { projectId, orgMember: { removedAt: null } } })`],
    ["a direct read two hops out", `tx.teamMember.findMany({ where: { projectMember: { orgMember: { orgId, userId, removedAt: null } } } })`],
    ["a bulk delete", `prisma.orgMemberWorkRole.deleteMany({ where: { workRoleId, orgMember: { removedAt: null } } })`],
    ["a shared select constant", `const TEAM = { members: { where: { projectMember: { orgMember: { removedAt: null } } }, select: { id: true } } };`],
  ])("accepts %s that filters along its own path (control)", (_name, src) => {
    expect(one(src).filtered).toBe(true);
  });

  it.each([
    ["a relation count", `prisma.project.findMany({ include: { _count: { select: { boards: true, members: true } } } })`],
    ["an include with no where", `prisma.project.findFirst({ include: { members: { include: { orgMember: true } } } })`],
    ["a team filtered at a project's depth", `prisma.team.findMany({ select: { members: { where: { orgMember: { removedAt: null } } } } })`],
    ["a project filtered at an org's depth", `prisma.project.findFirst({ include: { members: { where: { removedAt: null } } } })`],
    ["a relation filter with no removedAt", `prisma.interval.findMany({ where: { project: { members: { some: { orgMember: { userId } } } } } })`],
    ["a shared select constant with no where", `const TEAM = { members: { select: { projectMember: { select: { orgMember: true } } } } };`],
    ["a direct read with no filter", `prisma.projectMember.findMany({ where: { projectId } })`],
    ["a direct read of a variable", `prisma.projectMember.findMany(args)`],
    ["a direct count with no argument", `prisma.teamMember.count()`],
    ["a direct read filtered at the wrong depth", `prisma.teamMember.findMany({ where: { orgMember: { removedAt: null } } })`],
    ["a direct read filtered inside AND", `prisma.projectMember.findMany({ where: { AND: [{ orgMember: { removedAt: null } }] } })`],
    ["a direct read filtered only in a comment", `prisma.projectMember.findMany({ where: { projectId /*, orgMember: { removedAt: null } */ } })`],
    // The work-role roster PUT, as it was: replacing the roster deleted a removed holder's role.
    ["a bulk delete by role", `prisma.orgMemberWorkRole.deleteMany({ where: { workRoleId: roleId } })`],
  ])("counts %s as unfiltered", (_name, src) => {
    expect(one(src).filtered).toBe(false);
  });

  it("finds what the memberships-only judge this replaced did not", () => {
    // The guard before this one scanned `memberships` keys and nothing else,
    // and found no site in this snippet: the project GET and roster as they were.
    const sites = judge(
      `prisma.project.findFirst({ include: { members: { include: { orgMember: true } }, _count: { select: { members: true } } } });\n` +
        `prisma.projectMember.findMany({ where: { projectId } });`,
    );
    expect(sites.map((x) => [x.subject, x.filtered])).toEqual([
      ["Project.members", false],
      ["Project.members", false],
      ["projectMember.findMany", false],
    ]);
  });

  it.each([
    ["a chat channel's members", `prisma.chatChannel.findMany({ where: { members: { none: { userId } } }, select: { _count: { select: { members: true } } } })`],
    ["a chat channel reached through a relation", `prisma.chatChannelMember.findMany({ include: { channel: { select: { members: { select: { userId: true } } } } } })`],
    ["a write payload", `prisma.organization.create({ data: { members: { create: { userId, role } } } })`],
    ["a membership row's own lists", `prisma.orgMember.findMany({ include: { projectMembers: true, workRoles: true } })`],
    ["a prop", `<TeamList members={members} />`],
    ["a type", `interface Props { members: { userId: string }[] }`],
    ["a response", `return success({ members: rows, total });`],
    ["a destructure", `const { members } = props;`],
    ["a count in a type", `type Row = { _count: { members: number } };`],
  ])("does not judge %s", (_name, src) => {
    expect(judge(src)).toEqual([]);
  });

  it("is not thrown by a regex or a string holding a quote or brace", () => {
    const src = `const re = /["'{]/g; const s = "}{'";\ninclude: { memberships: { where: { removedAt: null } } }`;
    expect(one(src)).toEqual({ line: 2, filtered: true, shape: "object", subject: "memberships (owner unresolved)", kind: "relation" });
  });

  it("ignores property reads", () => {
    expect(judge(`const n = user.memberships.length; for (const m of team.members) use(m);`)).toEqual([]);
  });
});

// ── the source ───────────────────────────────────────────────────────────────

describe("reads that reach a membership filter removed members", () => {
  const all = walk(ROOT)
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes("__tests__"))
    .flatMap((f) => judge(readFileSync(f, "utf8")).map((s) => ({ ...s, file: f.split("\\").join("/") })));
  const unfiltered = all.filter((s) => !s.filtered);

  it("finds the reads it is meant to police", () => {
    // Positive control, by kind. Relation reads: the org list, the dashboard
    // shell and home page, the reset request and confirm reads, the calendar
    // invitees, the org GET, the project GET and its counts, the project list
    // and create counts, the work-role counts and the five team rosters.
    // Direct reads: the project and work-role rosters, Cosmo's roster and team
    // add, the team add, the staffing edit and list, the projects page's
    // managers, the last-manager count and the finance scope. A scan that finds
    // fewer is looking at the wrong text.
    const filtered = all.filter((s) => s.filtered);
    expect(filtered.filter((s) => s.kind === "relation").length).toBeGreaterThanOrEqual(20);
    expect(filtered.filter((s) => s.kind === "direct").length).toBeGreaterThanOrEqual(12);
  });

  it("has no unfiltered read outside the allowlist", () => {
    const byFile = new Map<string, typeof unfiltered>();
    for (const s of unfiltered) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    const unexpected = [...byFile].flatMap(([file, list]) =>
      list.length === (ALLOWED[file]?.sites ?? 0) ? [] : list.map((s) => `${s.file}:${s.line} ${s.subject} (${s.shape})`),
    );
    expect(
      unexpected,
      "A read reaching an org membership returns rows for people removed from the " +
        "org. Filter it: `where: { removedAt: null }` on OrgMember, " +
        "`orgMember: { removedAt: null }` on ProjectMember or OrgMemberWorkRole, " +
        "`projectMember: { orgMember: { removedAt: null } }` on TeamMember. If it " +
        "really wants removed rows, list the file in ALLOWED with its count and the reason.",
    ).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const stale = Object.keys(ALLOWED).filter((f) => !unfiltered.some((s) => s.file === f));
    expect(stale).toEqual([]);
  });

  it("gives every exception a substantive reason", () => {
    for (const [f, a] of Object.entries(ALLOWED)) expect(a.reason.length, f).toBeGreaterThan(40);
  });
});
