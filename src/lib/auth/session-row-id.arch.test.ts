// Session ids are stored hashed: a Session row's id is `sessionRowId(token)`,
// and the sign-in cookie carries the token. A query that keys a session by the
// cookie's own value finds nothing, so it fails quietly (sign-out leaves the
// session alive, a check reads "no session"), and a write that stores it puts
// a usable cookie back in the table. This rule reads every Session and
// SessionRecord query in the tree and checks what it keys by.
//
// What may name a session (`id` on a Session, `sessionToken` on a
// SessionRecord, which holds the same row id):
//   - a `sessionRowId(...)` call;
//   - a `.sessionId` (SessionUser.sessionId, the row id getSessionUser read;
//     session-at-rest.db.test.ts pins that it is the hash, not the cookie);
//   - a local `const` whose initializer calls sessionRowId;
//   - `true` / "asc" / "desc" (a select or an orderBy, not a key);
//   - a value listed in KEYED_BY_ROW_ID, with the reason it already is one.
// Anything else fails, naming the file, line and expression.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every place a Session can be queried from: app code, specs, scripts, seeds,
 * e2e and tools, walked whole, plus the code files at the repository root
 * (configs and test setup), read on their own.
 */
const ROOTS = ["src", "scripts", "prisma", "e2e", "tools"];
const CODE_FILE = /\.(ts|tsx|mts|mjs|js)$/;
const rootFiles = () =>
  readdirSync(".", { withFileTypes: true }).filter((e) => e.isFile() && CODE_FILE.test(e.name)).map((e) => e.name);

/** Values that are already row ids, though the rule can't see it, and why. */
const KEYED_BY_ROW_ID: Record<string, Record<string, string>> = {
  "src/app/api/v1/me/sessions/[sessionId]/route.ts": {
    "target.id":
      "An id read back from one of the caller's own Session rows (the findMany just above), so it is " +
      "the row id already.",
  },
  "src/app/api/v1/orgs/[orgId]/security/sessions/route.ts": {
    "rowIds":
      "Read from SessionRecord.sessionToken, which holds the Session's row id: the GET above and " +
      "sso.ts write it, both through sessionRowId, and this rule checks those writes too.",
  },
  "src/lib/auth/credential-change.ts": {
    keep:
      "`{ not: keepSessionId }`. keepSessionId is the SessionUser.sessionId (a row id) its callers " +
      "pass; the 'callers of endOtherSessions' case below checks that they do.",
  },
};

/** Files that define their own sessionRowId rather than import it, and why. */
const OWN_DEFINITION: Record<string, string> = {
  "src/lib/auth/session-id.ts": "Defines it.",
  "scripts/create-dev-session.mjs":
    "A plain node script, which can't import a TypeScript module; it carries a one-line copy.",
};

/** Files that name the sessions or session_records table in SQL, and why. */
const RAW_SQL: Record<string, string> = {
  "src/lib/auth/hash-session-ids.migration.test.ts":
    "Runs the migration that hashed the stored ids against copies of the two tables.",
};

/** SQL that names either table a session id is stored in. */
const SESSION_SQL = /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+(?:"?public"?\.)?"?(?:sessions|session_records)"?(?![\w])/i;

/** The two routes as they were before ids were hashed, as text: nothing compiles or runs them. */
const PRE_HASH = "src/lib/auth/__fixtures__/pre-hashed-session-ids";

const SESSION_OPS =
  "findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|createMany|createManyAndReturn|" +
  "update|updateMany|updateManyAndReturn|upsert|delete|deleteMany|count|aggregate|groupBy";

/** What keys each model's row: the field a query names a session by. */
const MODELS = [
  { model: "session", key: "id" },
  { model: "sessionRecord", key: "sessionToken" },
] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "migrations") continue;
      out.push(...walk(p));
    } else if (CODE_FILE.test(e.name)) {
      out.push(p.split("\\").join("/"));
    }
  }
  return out;
}

/**
 * The source with comments blanked (newlines kept, so line numbers hold) and
 * strings left as they are. A comment that explains a query must neither
 * satisfy the rule nor trip it.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let prev = ""; // last significant character, to tell a regex literal from division
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let depth = 0; // ${ } nesting inside a template
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (c === "`" && src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (c === "`" && depth > 0 && src[j] === "}") { depth--; j++; continue; }
        if (src[j] === c && depth === 0) break;
        if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      // A regex literal: copy it through its closing slash and flags.
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      while (/[a-z]/i.test(src[j + 1] ?? "")) j++;
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Index just past the bracket that closes the one at `open`, skipping strings. */
function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Where the expression starting at `from` ends: the next `,` or closing bracket at its own depth. */
function endOf(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") { i = closeOf(src, i); continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === "," || c === ")" || c === "}" || c === "]") break;
    i++;
  }
  return i;
}

const valueAt = (src: string, from: number) => src.slice(from, endOf(src, from)).trim();

/** `s` as a literal inside a RegExp. */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The top-level comma-separated parts of a list's inside. */
function parts(inner: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < inner.length; ) {
    const end = endOf(inner, i);
    const v = inner.slice(i, end).trim();
    if (v) out.push(v);
    i = end + 1;
  }
  return out;
}

type Site = { file: string; line: number; model: string; value: string };

/** Every value a Session / SessionRecord query in `src` keys a row by. */
export function keyedValues(file: string, src: string): Site[] {
  const code = stripComments(src);
  const sites: Site[] = [];
  const lineAt = (i: number) => code.slice(0, i).split("\n").length;
  const seen = new Set<number>(); // where each `key:` found inside a call starts
  for (const { model, key } of MODELS) {
    const call = new RegExp(`\\.${model}\\s*\\.\\s*(?:${SESSION_OPS})\\s*\\(`, "g");
    for (const m of code.matchAll(call)) {
      const open = m.index! + m[0].length - 1;
      const args = code.slice(open, closeOf(code, open));
      const line = lineAt(m.index!);
      // `key: value`, and the shorthand `{ key }` / `{ a, key }`.
      for (const k of args.matchAll(new RegExp(`(?<![\\w$.])${key}\\s*:(?!:)`, "g"))) {
        seen.add(open + k.index!);
        sites.push({ file, line, model, value: valueAt(args, k.index! + k[0].length) });
      }
      const shorthand = args.match(new RegExp(`(?<=[{,]\\s*)${key}\\s*(?=[,}])`, "g")) ?? [];
      for (let i = 0; i < shorthand.length; i++) sites.push({ file, line, model, value: key });
    }
  }
  // A filter built ahead of the call (`const where = { ..., sessionToken: x }`)
  // is out of the call's own arguments. Only SessionRecord has a sessionToken
  // field, so in a file that queries it, every `sessionToken:` is such a key.
  // A type annotation (`sessionToken: string`) names no value and is skipped.
  if (new RegExp(`\\.sessionRecord\\s*\\.\\s*(?:${SESSION_OPS})\\s*\\(`).test(code)) {
    for (const k of code.matchAll(/(?<![\w$.])sessionToken\s*:(?!:)/g)) {
      if (seen.has(k.index!)) continue;
      const value = valueAt(code, k.index! + k[0].length);
      if (/^(?:string|number|boolean|null|undefined)\b/.test(value)) continue;
      sites.push({ file, line: lineAt(k.index!), model: "sessionRecord", value });
    }
  }
  return sites;
}

/**
 * Whether a keyed value is a row id the rule can vouch for ("ok"), one
 * `allowed` lists ("listed", recorded in `used`), or neither ("raw").
 */
export function vouch(
  value: string,
  code: string,
  allowed: Record<string, string> = {},
  used: Set<string> = new Set(),
): "ok" | "listed" | "raw" {
  const v = value.replace(/\s+as\s+const$/, "").trim();
  if (/^(true|false)$/.test(v) || /^["'](asc|desc)["']$/.test(v)) return "ok";
  if (v in allowed) {
    used.add(v);
    return "listed";
  }
  const filter = v.match(/^\{\s*(?:not|in|notIn|equals)\s*:\s*([\s\S]*?)\s*,?\s*\}$/);
  if (filter) return vouch(filter[1], code, allowed, used);
  if (v.startsWith("[") && v.endsWith("]")) {
    const each = parts(v.slice(1, -1)).map((p) => vouch(p, code, allowed, used));
    return each.includes("raw") ? "raw" : each.includes("listed") ? "listed" : "ok";
  }
  if (/^sessionRowId\s*\(/.test(v) && closeOf(v, v.indexOf("(")) === v.length) return "ok";
  if (/^[\w$]+(?:\??\.[\w$]+)*\??\.sessionId$/.test(v)) return "ok";
  if (/^[\w$]+$/.test(v)) {
    const decl = code.match(new RegExp(`\\b(?:const|let)\\s+${escapeRegExp(v)}\\s*(?::[^=]+)?=([^;\\n]+)`));
    if (decl && /\bsessionRowId\s*\(/.test(decl[1])) return "ok";
  }
  return "raw";
}

describe("every Session query keys its row by sessionRowId", () => {
  const files = [...ROOTS.flatMap(walk), ...rootFiles()].filter((f) => !f.endsWith("session-row-id.arch.test.ts"));
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));
  const sites = files.flatMap((f) => keyedValues(f, sources.get(f)!));
  const used = new Set<string>();
  const verdicts = sites.map((s) => {
    const listed = new Set<string>();
    const verdict = vouch(s.value, stripComments(sources.get(s.file)!), KEYED_BY_ROW_ID[s.file], listed);
    for (const v of listed) used.add(`${s.file} ${v}`);
    return { ...s, verdict };
  });

  it("reads the whole tree (positive control)", () => {
    // Sign-in writes, the proxy and getSessionUser reads, sign-out and revoke
    // deletes, the activity and MFA updates, and the session records.
    const app = verdicts.filter((s) => !/\.(test|spec)\.|__tests__|\/testing\//.test(s.file));
    expect(new Set(app.map((s) => s.file)).size).toBeGreaterThanOrEqual(15);
    expect(app.length).toBeGreaterThanOrEqual(20);
    expect(sites.filter((s) => s.model === "sessionRecord").length).toBeGreaterThan(3);
    // The repository root's own code files and tools/ are read too.
    expect(files).toEqual(expect.arrayContaining(["next.config.ts", "vitest.setup.ts", "tools/cosmos-mcp/server.mjs"]));
  });

  it("keys nothing by a raw cookie value", () => {
    const raw = verdicts.filter((s) => s.verdict === "raw").map((s) => `${s.file}:${s.line} ${s.model} by ${s.value}`);
    expect(
      raw,
      "A Session's id is sessionRowId(cookie), never the cookie (src/lib/auth/session-id.ts). Hash the " +
        "token with sessionRowId; a value that is already a row id (SessionUser.sessionId, an id read back " +
        "from a row) can be passed as it is, or listed in KEYED_BY_ROW_ID with the reason.",
    ).toEqual([]);
  });

  it("has no stale KEYED_BY_ROW_ID entries", () => {
    const listed = Object.entries(KEYED_BY_ROW_ID).flatMap(([f, vs]) => Object.keys(vs).map((v) => `${f} ${v}`));
    expect(listed.filter((e) => !used.has(e))).toEqual([]);
    for (const vs of Object.values(KEYED_BY_ROW_ID)) for (const why of Object.values(vs)) expect(why.length).toBeGreaterThan(40);
  });

  it("callers of endOtherSessions keep only a SessionUser.sessionId", () => {
    const calls = files.flatMap((f) =>
      [...stripComments(sources.get(f)!).matchAll(/(?<!function\s+)\bendOtherSessions\s*\(([^)]*)\)/g)].map((m) => ({
        f,
        args: parts(m[1]),
      })),
    );
    const app = calls.filter((c) => !/\.test\.|__tests__/.test(c.f));
    expect(app.length).toBeGreaterThanOrEqual(4); // password set/change, MFA off, two resets
    expect(app.filter((c) => c.args.length > 1 && !/\.sessionId$/.test(c.args[1])).map((c) => `${c.f}: ${c.args.join(", ")}`)).toEqual([]);
  });

  it("imports sessionRowId rather than writing another", () => {
    const callers = files.filter((f) => /\bsessionRowId\s*\(/.test(stripComments(sources.get(f)!)));
    const own = callers.filter((f) => !/import\s*\{[^}]*\bsessionRowId\b[^}]*\}\s*from\s*["'][^"']*session-id["']/.test(sources.get(f)!));
    expect(own.sort()).toEqual(Object.keys(OWN_DEFINITION).sort());
  });

  it("names the sessions and session_records tables in SQL only where listed", () => {
    const naming = files.filter((f) => SESSION_SQL.test(stripComments(sources.get(f)!)));
    expect(naming.sort()).toEqual(Object.keys(RAW_SQL).sort());
  });

  it("drops only what reads as a comment line by line", () => {
    // The stripper is what keeps a query from being read; if it ever swallowed
    // code (an unclosed string, a regex it took for division), sites would
    // vanish and the rule would pass on less. Every call a plain grep finds on
    // a line that isn't a comment must survive it.
    const call = new RegExp(`\\.(?:session|sessionRecord)\\s*\\.\\s*(?:${SESSION_OPS})\\s*\\(`, "g");
    const lost: string[] = [];
    for (const f of files) {
      const src = sources.get(f)!;
      const stripped = stripComments(src).split("\n");
      src.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const before = [...line.matchAll(call)].length;
        const after = [...(stripped[i] ?? "").matchAll(call)].length;
        if (after < before) lost.push(`${f}:${i + 1}`);
      });
    }
    expect(lost).toEqual([]);
  });
});

describe("the rule itself (positive controls)", () => {
  const raw = (src: string) =>
    keyedValues("x.ts", src).map((s) => vouch(s.value, stripComments(src)));

  it("catches a query keyed by the cookie, however it is written", () => {
    expect(raw(`await prisma.session.findUnique({ where: { id: token } });`)).toEqual(["raw"]);
    expect(raw(`await prisma.session.delete({ where: { id } });`)).toEqual(["raw"]);
    expect(raw(`await prisma.session\n  .delete({ where: { id: sessionId } })\n  .catch(() => undefined);`)).toEqual(["raw"]);
    expect(raw(`await prisma.session.deleteMany({ where: { id: { in: tokens } } });`)).toEqual(["raw"]);
    expect(raw(`await tx.session.deleteMany({ where: { userId, ...(k ? { id: { not: k } } : {}) } });`)).toEqual(["raw"]);
    expect(raw(`await prisma.session.create({ data: { id: sessionId, userId } });`)).toEqual(["raw"]);
    expect(raw(`await prisma.session.upsert({ where: { id: sessionRowId(t) }, create: { id: t }, update: {} });`)).toEqual(["ok", "raw"]);
    expect(raw(`await prisma.sessionRecord.upsert({ where: { sessionToken: cookie }, create: { sessionToken: cookie }, update: {} });`)).toEqual(["raw", "raw"]);
    // A name that merely starts like the helper, and a call that is only part of the value.
    expect(raw(`await prisma.session.findUnique({ where: { id: sessionRowIdOf(t) } });`)).toEqual(["raw"]);
    expect(raw(`await prisma.session.findUnique({ where: { id: sessionRowId(t) + t } });`)).toEqual(["raw"]);
    expect(raw(`const id = cookie;\nawait prisma.session.findUnique({ where: { id } });`)).toEqual(["raw"]);
  });

  it("accepts a hashed key, a row id already held, and a select or an order", () => {
    expect(raw(`await prisma.session.findUnique({ where: { id: sessionRowId(token) } });`)).toEqual(["ok"]);
    expect(raw(`const rowId = cookie ? sessionRowId(cookie) : null;\nawait prisma.session.findUnique({ where: { id: rowId } });`)).toEqual(["ok"]);
    expect(raw(`await prisma.session.update({ where: { id: user.sessionId }, data: {} });`)).toEqual(["ok"]);
    expect(raw(`await prisma.session.findMany({ select: { id: true }, orderBy: [{ id: "desc" }] });`)).toEqual(["ok", "ok"]);
    expect(raw(`await prisma.session.deleteMany({ where: { id: { in: [sessionRowId(a), sessionRowId(b)] } } });`)).toEqual(["ok"]);
  });

  it("neither counts nor trips on a comment, and keeps strings and regexes", () => {
    expect(raw(`// prisma.session.delete({ where: { id: token } })\n/* prisma.session.delete({ where: { id: token } }) */`)).toEqual([]);
    expect(raw(`const re = /"/; await prisma.session.delete({ where: { id: token } });`)).toEqual(["raw"]);
    expect(raw(`const s = "// not a comment"; await prisma.session.delete({ where: { id: token } });`)).toEqual(["raw"]);
    expect(raw(`const t = \`\${a}\`; await prisma.session.delete({ where: { id: token } });`)).toEqual(["raw"]);
  });

  it("reads a sessionToken filter built ahead of the call, and skips a type", () => {
    const src = (k: string) =>
      `const where = { orgId, ...(c ? { sessionToken: { not: ${k} } } : {}) };\nawait prisma.sessionRecord.findMany({ where });`;
    expect(raw(src("cookie"))).toEqual(["raw"]);
    expect(raw(src("sessionRowId(cookie)"))).toEqual(["ok"]);
    expect(raw(`type R = { sessionToken: string };\nawait prisma.sessionRecord.findMany({ where: { orgId } });`)).toEqual([]);
  });

  it("knows SQL that names either table, in any case, and nothing longer", () => {
    for (const q of [`UPDATE "session_records" SET x = 1`, `update sessions set id = 1`, `SELECT * FROM public.sessions`, `DELETE FROM "public"."session_records"`]) {
      expect(SESSION_SQL.test(q), q).toBe(true);
    }
    for (const q of [`SELECT * FROM sessions_archive`, `FROM session_recordings`, `the sessions page`]) expect(SESSION_SQL.test(q), q).toBe(false);
  });

  it("does not read an unrelated `session` property or model", () => {
    expect(raw(`await prisma.sessionGrant.findUnique({ where: { id: token } });`)).toEqual([]);
    expect(raw(`await prisma.session.findMany({ where: { userId: token } });`)).toEqual([]);
  });
});

// The real code this change replaced: every place it keyed a session by the
// cookie's own value must be caught, not just the shapes written above.
describe("the rule on the code it replaced (positive control)", () => {
  const flagged = (name: string) => {
    const path = join(PRE_HASH, name);
    expect(existsSync(path), path).toBe(true);
    const src = readFileSync(path, "utf8");
    return keyedValues(name, src)
      .filter((s) => vouch(s.value, stripComments(src)) === "raw")
      .map((s) => `${s.line} ${s.model} ${s.value}`);
  };

  it("flags the old sign-out, which deleted the row the cookie named", () => {
    expect(flagged("logout-route.ts.txt")).toEqual(["10 session sessionId"]);
  });

  it("flags every key in the old org Sessions route, including the filter it built ahead of the call", () => {
    expect(flagged("security-sessions-route.ts.txt")).toEqual([
      "39 session currentToken",
      "160 session { in: tokens }",
      "45 sessionRecord currentToken",
      "45 sessionRecord currentToken",
      "127 sessionRecord { not: currentToken }",
    ]);
  });
});
