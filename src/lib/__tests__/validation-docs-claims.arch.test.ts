// Companion to validation-docs-hygiene.arch.test.ts, and deliberately a different
// KIND of assertion. That file greps for the specific false sentences one sweep
// deleted — which is only ever as complete as the sweep was. It went green over a
// step that had survived three doors down: with the "pgvector is not installed"
// note gone, `SELECT search_vector … returns non-null` still stood, and
// prisma/schema.prisma marks that column "no longer written" on all four models.
// A tester would have run it, got NULL, and filed a bug against a column nothing
// has written since the pgvector cutover.
//
// So the rules here are derived, not enumerated: a validation step may only name
// a column the schema has not retired and `src/` actually writes, and only an API
// path the app actually serves. Those hold for columns and routes nobody has
// thought to grep for yet.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const PATHS = [
  "docs/AI-CHAT-MIGRATION-PLAN.md",
  "docs/AI-CHAT-TEST-PLAN.md",
  "docs/SETTINGS-VALIDATION-PLAN.md",
  "docs/VALIDATION-GUIDE.md",
] as const;

const docs = PATHS.map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p)) acc.push(p);
  }
  return acc;
}

/**
 * Every line of `src/`, concatenated — the corpus a "does the app touch X?"
 * question asks. THIS file is excluded: it necessarily contains the retired
 * column names it greps for, and scanning itself would answer "yes, src/ writes
 * search_vector" on the strength of the guard's own text. (Same self-exclusion
 * as src/lib/ai/egress/__tests__/single-path.arch.test.ts, for the same reason.)
 */
const SELF = join("lib", "__tests__", "validation-docs-claims.arch.test.ts");
const SRC = walk(join(ROOT, "src"))
  .filter((f) => !f.endsWith(SELF))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Columns whose schema comment retires them. Derived from schema.prisma so a
 * column retired tomorrow is covered without touching this file: find a comment
 * saying it is no longer written, take the `@map()` of the field it introduces.
 */
function retiredColumns(): Set<string> {
  const lines = schema.split("\n");
  const dead = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!/no longer (?:written|read or written)/i.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^\s*\/\//.test(lines[j])) continue; // rest of the comment block
      const m = lines[j].match(/@map\("([^"]+)"\)/);
      if (m) dead.add(m[1]);
      break;
    }
  }
  return dead;
}

const SQL_NOISE = new Set([
  "select", "from", "where", "is", "not", "null", "as", "and", "or", "count",
  "distinct", "case", "when", "then", "else", "end", "true", "false", "limit",
]);

/** `{ column, table, doc }` for every `SELECT … FROM …` a validation step tells a tester to run. */
function selectedColumns() {
  return docs.flatMap((d) =>
    [...d.text.matchAll(/SELECT\s+([^|`\n]+?)\s+FROM\s+"?(\w+)"?/gi)].flatMap((m) =>
      m[1]
        .split(",")
        .flatMap((part) => part.trim().split(/\s+/))
        .map((t) => t.replace(/^"|"$/g, "").toLowerCase())
        .filter((t) => /^[a-z_][a-z0-9_]*$/.test(t) && !SQL_NOISE.has(t))
        .map((column) => ({ column, table: m[2], doc: d.path })),
    ),
  );
}

describe("validation steps only assert on columns the app still writes", () => {
  const retired = retiredColumns();
  const selected = selectedColumns();

  it("finds the retired-column marker and the steps to check at all", () => {
    // Guards the guard twice over: if the schema comment is reworded, or the docs
    // stop containing SQL, every assertion below passes vacuously and says so.
    expect(retired).toContain("search_vector");
    expect(selected.length).toBeGreaterThan(0);
  });

  it("no step selects a column prisma/schema.prisma has retired", () => {
    const offenders = selected
      .filter((s) => retired.has(s.column))
      .map((s) => `${s.doc}: SELECT ${s.column} FROM ${s.table}`);
    expect(offenders).toEqual([]);
  });

  it("every column a step selects is one `src/` actually writes", () => {
    // A doc is allowed to name a column only if the application touches it under
    // either spelling — raw snake_case SQL, or the camelCase Prisma field.
    const offenders = selected
      .filter((s) => !SRC.includes(s.column) && !SRC.includes(camel(s.column)))
      .map((s) => `${s.doc}: SELECT ${s.column} FROM ${s.table}`);
    expect(offenders).toEqual([]);
  });

  it("the retired search vector is written nowhere in src/", () => {
    // The premise of the two rules above: `search_vector` is dead in fact, not
    // just in a comment. If a writer ever comes back, this flips and the steps
    // asserting on it become legitimate again.
    expect(SRC).not.toContain("searchVector");
    expect(SRC).not.toContain("search_vector");
  });
});

describe("validation steps only name endpoints the app serves", () => {
  const aiPlan = docs.find((d) => d.path === "docs/AI-CHAT-TEST-PLAN.md")!.text;
  const apiPaths = [...aiPlan.matchAll(/\/api\/v1\/orgs\/[^\s`"')]+/g)].map((m) => m[0]);

  it("finds the API paths at all", () => {
    expect(apiPaths.length).toBeGreaterThan(0);
  });

  it("every message endpoint it cites is under /assistant, not the team-chat app", () => {
    // AI conversations are served by
    // src/app/api/v1/orgs/[orgId]/assistant/conversations/[conversationId]/messages;
    // `/chat` is the team channel/DM app and has no such route. Covers prose and
    // curl lines alike, not just the one table cell a sweep happened to read.
    const offenders = apiPaths.filter((p) => p.includes("/messages") && !p.includes("/assistant/"));
    expect(offenders).toEqual([]);
  });
});

describe("validation steps only name audit metadata the app emits", () => {
  const ROUTE = join(
    ROOT,
    "src/app/api/v1/orgs/[orgId]/assistant/conversations/[conversationId]/messages/route.ts",
  );
  const route = readFileSync(ROUTE, "utf8");
  const aiPlan = docs.find((d) => d.path === "docs/AI-CHAT-TEST-PLAN.md")!.text;
  const bullet = aiPlan.split("\n").find((l) => l.includes("chat.message.sent")) ?? "";

  it("finds the audit-log step and the action it names", () => {
    expect(bullet).not.toEqual("");
    expect(route).toContain('action: "chat.message.sent"');
  });

  it("the metadata keys/values it tells a tester to look for are the ones logged", () => {
    // The step used to promise `pool: "persistent" | "one-shot"` — a field of the
    // CLI pool that no longer exists. The route logs `backend: "anthropic-sdk"`.
    const claimed = [...bullet.matchAll(/`(\w+): "([^"]+)"`/g)].map((m) => [m[1], m[2]] as const);
    expect(claimed.length).toBeGreaterThan(0);
    const offenders = claimed
      .filter(([k, v]) => !route.includes(`${k}: "${v}"`))
      .map(([k, v]) => `${k}: "${v}"`);
    expect(offenders).toEqual([]);
  });
});
