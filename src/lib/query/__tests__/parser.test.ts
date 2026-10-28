// Parser golden tests: each input must parse cleanly and print to the
// canonical text, which in turn must parse back to the same AST. Error cases
// assert the code and the exact span. This table is the grammar's spec: a
// replacement parser (parseCql is the only seam) must pass it unchanged.
import { describe, it, expect } from "vitest";
import { parseCql } from "../parser";
import { printCql } from "../print";
import { CQL_LIMITS } from "../ast";

const GOLDEN: [string, string][] = [
  // basic comparisons
  ["priority = HIGH", "priority = HIGH"],
  ["priority != HIGH", "priority != HIGH"],
  // `==` is accepted and normalises to `=`. Reported from production: someone
  // typed `type == feature`, got two diagnostics that never mentioned `=`, and
  // read the result as the query language being broken. Everyone who has
  // written code types `==`; refusing it teaches nothing and costs a session.
  ["priority == HIGH", "priority = HIGH"],
  ["points >= 3 AND priority == LOW", "points >= 3 AND priority = LOW"],
  ["points > 3", "points > 3"],
  ["points >= 3", "points >= 3"],
  ["points < 3.5", "points < 3.5"],
  ["points <= -1", "points <= -1"],
  ['assignee = "Dana Ruiz"', 'assignee = "Dana Ruiz"'],
  ["assignee = 'Dana Ruiz'", 'assignee = "Dana Ruiz"'],
  ['summary ~ "say \\"hi\\""', 'summary ~ "say \\"hi\\""'],
  ["status = in-progress", "status = in-progress"],
  ["key = ACME-12", "key = ACME-12"],
  ["key > ACME-100", "key > ACME-100"],
  // keywords are case-insensitive, fields and aliases canonicalise
  ["Priority = high and Type = Bug", "priority = high AND type = Bug"],
  ["issuetype = Bug", "type = Bug"],
  ["labels = auth", "label = auth"],
  ["tags = auth", "label = auth"],
  ["title ~ login", 'summary ~ "login"'],
  ["resolved > -7d", "completed > -7d"],
  ["createdDate >= 2026-01-01", "created >= 2026-01-01"],
  ["iteration = 5", "sprint = 5"],
  // me / functions / variables
  ["assignee = me", "assignee = me"],
  ["assignee = ME", "assignee = me"],
  ["assignee = currentUser()", "assignee = me"],
  ["sprint IN openSprints()", "sprint IN openSprints()"],
  ["sprint in (openSprints())", "sprint IN openSprints()"],
  ["assignee IN membersOf(Platform)", "assignee IN membersOf(Platform)"],
  ['assignee IN membersOf("Platform Team")', 'assignee IN membersOf("Platform Team")'],
  ["created >= startOfWeek(-1w)", "created >= startOfWeek(-1w)"],
  ["created >= startOfMonth()", "created >= startOfMonth()"],
  ["due < now()", "due < now()"],
  ["due <= endOfWeek(1)", "due <= endOfWeek(1)"],
  ["completed >= sinceLastStandup()", "completed >= sinceLastStandup()"],
  ["assignee = $speaker", "assignee = $speaker"],
  ["team IN $team", "team IN $team"],
  ["project = currentProject()", "project = currentProject()"],
  // relative dates and literals
  ["created > -7d", "created > -7d"],
  ["due < +2w", "due < +2w"],
  ["updated >= -1M", "updated >= -1M"],
  ["updated >= -30m", "updated >= -30m"],
  ["updated >= -12h", "updated >= -12h"],
  ["completed >= -3wd", "completed >= -3wd"],
  ["due = 2026-10-31", "due = 2026-10-31"],
  ["created > 2026-10-31T09:30:00Z", "created > 2026-10-31T09:30:00Z"],
  ["originalEstimate > 2h", "originalEstimate > 2h"],
  // IN / NOT IN / IN ALL
  ["priority IN (HIGH, CRITICAL)", "priority IN (HIGH, CRITICAL)"],
  ["priority in (HIGH,CRITICAL)", "priority IN (HIGH, CRITICAL)"],
  ["priority NOT IN (LOW)", "priority NOT IN (LOW)"],
  ["labels IN ALL (a, b)", "label IN ALL (a, b)"],
  ["assignee IN (me, EMPTY)", "assignee IN (me, EMPTY)"],
  ["assignee in (me)", "assignee IN (me)"],
  ['project IN (ACME, "Ops Team", 7)', 'project IN (ACME, "Ops Team", 7)'],
  // EMPTY / NULL
  ["assignee IS EMPTY", "assignee IS EMPTY"],
  ["assignee is not empty", "assignee IS NOT EMPTY"],
  ["assignee IS NULL", "assignee IS EMPTY"],
  ["assignee = EMPTY", "assignee IS EMPTY"],
  ["assignee != EMPTY", "assignee IS NOT EMPTY"],
  // text
  ["summary ~ login", 'summary ~ "login"'],
  ['summary !~ "wip"', 'summary !~ "wip"'],
  ['text ~ "log*"', 'text ~ "log*"'],
  ["comment ~ 123", 'comment ~ "123"'],
  // booleans
  ["blocked = true", "blocked = true"],
  ["archived = FALSE", "archived = false"],
  // custom fields
  ["cf[severity] = S1", "cf[severity] = S1"],
  ['cf["Story Points"] > 3', 'cf["Story Points"] > 3'],
  ['"Story Points" > 3', 'cf["Story Points"] > 3'],
  ["severity IN (S1, S2)", "cf[severity] IN (S1, S2)"],
  // boolean structure and precedence
  ["a = 1 AND b = 2", "cf[a] = 1 AND cf[b] = 2"],
  ["a = 1 b = 2", "cf[a] = 1 AND cf[b] = 2"],
  ["a = 1 OR b = 2", "cf[a] = 1 OR cf[b] = 2"],
  ["a = 1 OR b = 2 AND c = 3", "cf[a] = 1 OR cf[b] = 2 AND cf[c] = 3"],
  ["(a = 1 OR b = 2) AND c = 3", "(cf[a] = 1 OR cf[b] = 2) AND cf[c] = 3"],
  ["NOT a = 1", "NOT cf[a] = 1"],
  ["!a = 1", "NOT cf[a] = 1"],
  ["NOT (a = 1 OR b = 2)", "NOT (cf[a] = 1 OR cf[b] = 2)"],
  ["NOT NOT a = 1", "NOT NOT cf[a] = 1"],
  ["a = 1 AND (b = 2 AND c = 3)", "cf[a] = 1 AND (cf[b] = 2 AND cf[c] = 3)"],
  ["((a = 1))", "cf[a] = 1"],
  ["a = 1 OR (b = 2 OR c = 3)", "cf[a] = 1 OR (cf[b] = 2 OR cf[c] = 3)"],
  ["(a = 1 OR b = 2) OR c = 3", "(cf[a] = 1 OR cf[b] = 2) OR cf[c] = 3"],
  // history
  ["status WAS done", "status WAS done"],
  ["status WAS NOT done", "status WAS NOT done"],
  ["status WAS IN (todo, done)", "status WAS IN (todo, done)"],
  ['status CHANGED FROM "in-review" TO "in-progress" AFTER -14d', "status CHANGED FROM in-review TO in-progress AFTER -14d"],
  ["assignee WAS me BY me BEFORE 2026-01-01", "assignee WAS me BY me BEFORE 2026-01-01"],
  ["status WAS done DURING (2026-01-01, 2026-02-01)", "status WAS done DURING (2026-01-01, 2026-02-01)"],
  ["priority CHANGED ON 2026-03-03", "priority CHANGED ON 2026-03-03"],
  ["priority CHANGED", "priority CHANGED"],
  // bare item-set functions are clauses
  ["descendantsOf(ACME-1)", "key IN descendantsOf(ACME-1)"],
  ["childrenOf(ACME-1) AND priority = HIGH", "key IN childrenOf(ACME-1) AND priority = HIGH"],
  ["linkedItems(ACME-1, BLOCKS)", "key IN linkedItems(ACME-1, BLOCKS)"],
  ["watchedItems()", "key IN watchedItems()"],
  // ORDER BY
  ["ORDER BY due", "ORDER BY due ASC"],
  ["order by due desc", "ORDER BY due DESC"],
  ["priority = HIGH ORDER BY due DESC NULLS LAST, key", "priority = HIGH ORDER BY due DESC NULLS LAST, key ASC"],
  ["ORDER BY created ASC NULLS FIRST", "ORDER BY created ASC NULLS FIRST"],
  // quoting of values that would otherwise read differently
  ['label = "and"', 'label = "and"'],
  ['label = "me"', 'label = "me"'],
  ['label = "true"', 'label = "true"'],
  ['label = "-7d"', 'label = "-7d"'],
  ['label = "2026-01-01"', 'label = "2026-01-01"'],
  ['label = "12"', 'label = "12"'],
  ['label = ""', 'label = ""'],
  ['label = "a,b"', 'label = "a,b"'],
  ['label = "in-progress"', "label = in-progress"],
  ["label = orders", "label = orders"],
  ["label = android", "label = android"],
  // whitespace and line breaks
  ["  priority   =\n HIGH  ", "priority = HIGH"],
  // empty
  ["", ""],
  ["   ", ""],
];

describe("parseCql — golden", () => {
  it.each(GOLDEN)("%s", (input, canonical) => {
    const r = parseCql(input);
    expect(r.diagnostics).toEqual([]);
    const printed = printCql(r.query);
    expect(printed).toBe(canonical);
    const again = parseCql(printed);
    expect(again.diagnostics).toEqual([]);
    expect(again.query).toEqual(r.query);
  });
});

describe("parseCql — bare words are a text search", () => {
  it.each([
    ["login timeout", "login timeout"],
    ["work in progress", "work in progress"],
    ["  fix   the   thing ", "fix the thing"],
    ["login", "login"],
  ])("%s", (input, words) => {
    const r = parseCql(input);
    expect(r.diagnostics).toEqual([]);
    expect(r.query.where).toEqual({ op: "text", field: { kind: "sys", id: "text" }, query: words });
  });

  it("a query that starts with a field is a query, and gets the real error", () => {
    const r = parseCql("assignee in bob");
    expect(r.diagnostics[0].code).toBe("CQL_SYNTAX");
    expect(r.diagnostics[0].message).toMatch(/Expected a value/);
    expect([r.diagnostics[0].from, r.diagnostics[0].to]).toEqual([12, 15]);
  });
});

describe("parseCql — errors carry exact spans", () => {
  const first = (q: string) => parseCql(q).diagnostics[0];

  it("missing value at the end", () => {
    const d = first("priority = ");
    expect(d.code).toBe("CQL_SYNTAX");
    expect([d.from, d.to]).toEqual([11, 11]);
    expect(d.message).toMatch(/Expected a value/);
  });
  it("missing operator", () => {
    const d = first("priority HIGH");
    expect(d.code).toBe("CQL_SYNTAX");
    expect([d.from, d.to]).toEqual([9, 13]);
  });
  it("unclosed parenthesis", () => {
    const d = first("(priority = HIGH");
    expect(d.code).toBe("CQL_SYNTAX");
    expect(d.from).toBe(16);
  });
  it("unclosed quote", () => {
    const d = first('summary ~ "abc');
    expect(d.code).toBe("CQL_SYNTAX");
    expect(d.message).toMatch(/quote/);
    expect([d.from, d.to]).toEqual([10, 11]);
  });
  it("stray character", () => {
    const d = first("priority = HIGH @");
    expect(d.code).toBe("CQL_SYNTAX");
    expect([d.from, d.to]).toEqual([16, 17]);
  });
  it("line and column are 1-based across lines", () => {
    const d = first("priority = HIGH\nAND status =");
    expect(d.line).toBe(2);
    expect(d.column).toBe(13);
  });
  it("trailing AND", () => {
    expect(first("priority = HIGH AND").code).toBe("CQL_SYNTAX");
  });
  it("ORDER without BY", () => {
    expect(first("ORDER due").code).toBe("CQL_SYNTAX");
  });
  it("a NUL character is refused where it is", () => {
    const d = first('summary ~ "a\u0000b"');
    expect(d.code).toBe("CQL_SYNTAX");
    expect(d).toMatchObject({ from: 12, to: 13 });
  });
  it("length limit", () => {
    const d = first(`summary ~ "${"x".repeat(CQL_LIMITS.textLength)}"`);
    expect(d.code).toBe("CQL_LIMIT");
  });
  it("parenthesis depth limit", () => {
    const deep = `${"(".repeat(6)}a = 1${")".repeat(6)}`;
    expect(first(deep).code).toBe("CQL_LIMIT");
    const ok = `${"(".repeat(5)}a = 1${")".repeat(5)}`;
    expect(parseCql(ok).diagnostics).toEqual([]);
  });
});

describe("parseCql — spans", () => {
  it("records the span of each clause and value", () => {
    const text = "priority = HIGH AND assignee = me";
    const r = parseCql(text);
    const and = r.query.where as Extract<NonNullable<typeof r.query.where>, { op: "and" }>;
    const [a, b] = and.args;
    expect(r.spans.get(a)).toEqual({ from: 0, to: 15 });
    expect(r.spans.get(b)).toEqual({ from: 20, to: 33 });
    const v = (a as { value: object }).value;
    expect(r.spans.get(v)).toEqual({ from: 11, to: 15 });
  });
});

describe("depth is refused before parsing (never a stack overflow)", () => {
  const limit = (cql: string) => {
    const r = parseCql(cql);
    return r.diagnostics.find((d) => d.code === "CQL_LIMIT");
  };
  it("deep parentheses, closed or not", () => {
    expect(limit(`${"(".repeat(316)}priority = HIGH${")".repeat(316)}`)?.message).toMatch(/Parentheses can nest at most/);
    expect(limit(`${"(".repeat(3900)}priority = HIGH`)?.message).toMatch(/Parentheses can nest at most/);
    // At the limit is fine.
    expect(limit(`${"(".repeat(CQL_LIMITS.parenDepth)}priority = HIGH${")".repeat(CQL_LIMITS.parenDepth)}`)).toBeUndefined();
  });
  it("long runs of NOT, and nested function calls", () => {
    expect(limit(`${"NOT ".repeat(950)}priority = HIGH`)?.message).toMatch(/NOTs in a row/);
    expect(limit(`${"! ".repeat(1900)}priority = HIGH`)?.message).toMatch(/NOTs in a row/);
    expect(limit(`key IN ${"childrenOf(".repeat(300)}X-1${")".repeat(300)}`)?.message).toMatch(/nest at most/);
    // NOT IN is an operator, not a run of NOTs; a few NOTs are fine.
    expect(limit("priority NOT IN (LOW) AND NOT NOT assignee = me")).toBeUndefined();
  });
  it("a value list's parentheses are not a group", () => {
    const at = (inner: string) => `${"(".repeat(CQL_LIMITS.parenDepth)}${inner}${")".repeat(CQL_LIMITS.parenDepth)}`;
    expect(limit(at("status IN (todo, done)"))).toBeUndefined();
    expect(limit(at("labels IN ALL (a, b)"))).toBeUndefined();
    expect(limit(at("status NOT IN (todo)"))).toBeUndefined();
    expect(limit(at("status CHANGED FROM (todo, review) BY (me, bob) DURING (-7d, now())"))).toBeUndefined();
    expect(parseCql(at("status IN (todo, done)")).diagnostics).toEqual([]);
    // One more group is still one too many.
    expect(limit(`(${at("status IN (todo, done)")})`)?.message).toMatch(/Parentheses can nest at most/);
  });
  it("points at where it went too deep", () => {
    const cql = `${"(".repeat(6)}a = 1${")".repeat(6)}`;
    expect(limit(cql)).toMatchObject({ from: 5, to: 6 });
  });
});
