// The compiler is pure: resolved query + environment → Prisma where. These
// pin its output for representative clauses, and prove over generated queries
// that whatever a user writes stays inside the scope envelope.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { compileQuery } from "../compile";
import { parseCql } from "../parser";
import { typecheck } from "../typecheck";
import type { CompileEnv } from "../env";
import { buildScopedWhere } from "@/lib/work-items/query/build-where";
import { queryArb } from "./arbitraries";
import type { CqlQuery } from "../ast";

const NOW = new Date("2026-10-15T15:00:00Z");
const ORG = "org-1";
const READABLE = ["p1", "p2"];

function env(over: Partial<CompileEnv> = {}): CompileEnv {
  return {
    actorUserId: "me-id",
    now: NOW,
    tz: "UTC",
    fnIds: new Map(),
    vars: new Map(),
    statusCategories: {
      TODO: [{ projectId: "p1", keys: ["todo"] }],
      IN_PROGRESS: [{ projectId: "p1", keys: ["doing", "review"] }],
      DONE: [{ projectId: "p1", keys: ["done"] }, { projectId: "p2", keys: ["shipped"] }],
      CANCELLED: [],
    },
    items: new Map([["item-100", { projectId: "p1", ticketNumber: 100 }]]),
    customFields: new Map([["sev", "SELECT"], ["n", "NUMBER"], ["areas", "MULTI_SELECT"]]),
    ...over,
  };
}

/** Parse + typecheck, then pretend the resolver turned `ref:x` strings into refs. */
function q(text: string): CqlQuery {
  const p = parseCql(text);
  expect(p.diagnostics).toEqual([]);
  const t = typecheck(p.query, {
    customFields: [
      { key: "sev", name: "Severity", fieldType: "SELECT" },
      { key: "n", name: "N", fieldType: "NUMBER" },
      { key: "areas", name: "Areas", fieldType: "MULTI_SELECT" },
    ],
  });
  expect(t.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const toRefs = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(toRefs);
    if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      if (r.t === "str" && typeof r.v === "string" && r.v.startsWith("ref:")) {
        const [, entity, id] = r.v.split(":");
        return { t: "ref", entity, id };
      }
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toRefs(v)]));
    }
    return o;
  };
  return toRefs(t.query) as CqlQuery;
}
const where = (text: string, e = env()) => compileQuery(q(text), e).where;

describe("compile — field by field", () => {
  it("assignee: primary or co-assignee; empty means neither; != keeps it two-valued", () => {
    expect(where('assignee = "ref:user:u1"')).toEqual({
      OR: [{ assigneeId: { in: ["u1"], not: null } }, { assignees: { some: { userId: { in: ["u1"] } } } }],
    });
    expect(where("assignee = me")).toEqual({
      OR: [{ assigneeId: { in: ["me-id"], not: null } }, { assignees: { some: { userId: { in: ["me-id"] } } } }],
    });
    expect(where("assignee IS EMPTY")).toEqual({ assigneeId: null, assignees: { none: {} } });
    expect(where("assignee != me")).toEqual({
      AND: [
        { NOT: { OR: [{ assigneeId: { in: ["me-id"], not: null } }, { assignees: { some: { userId: { in: ["me-id"] } } } }] } },
        { NOT: { assigneeId: null, assignees: { none: {} } } },
      ],
    });
    expect(where("assignee IN (me, EMPTY)")).toEqual({
      OR: [
        { OR: [{ assigneeId: { in: ["me-id"], not: null } }, { assignees: { some: { userId: { in: ["me-id"] } } } }] },
        { assigneeId: null, assignees: { none: {} } },
      ],
    });
  });

  it("priority order and enums", () => {
    expect(where("priority > MEDIUM")).toEqual({ priority: { in: ["HIGH", "CRITICAL"] } });
    expect(where("priority <= MEDIUM")).toEqual({ priority: { in: ["LOW", "MEDIUM"] } });
    expect(where("priority IN (HIGH, LOW)")).toEqual({ priority: { in: ["HIGH", "LOW"] } });
    expect(where("highlight = RED")).toEqual({ highlight: { in: ["RED"], not: null } });
  });

  it("statusCategory uses the readable projects' columns; DONE also means completed", () => {
    expect(where("statusCategory = DONE")).toEqual({
      OR: [
        { OR: [{ projectId: "p1", columnKey: { in: ["done"] } }, { projectId: "p2", columnKey: { in: ["shipped"] } }] },
        { completedAt: { not: null } },
      ],
    });
    expect(where("statusCategory = TODO")).toEqual({
      AND: [{ projectId: "p1", columnKey: { in: ["todo"] } }, { completedAt: null }],
    });
    expect(where("statusCategory = CANCELLED")).toEqual({ id: { in: [] } });
  });

  it("dates: day ranges for =, strict and inclusive bounds, relative offsets, functions", () => {
    expect(where("due = 2026-10-20")).toEqual({
      dueDate: { gte: new Date("2026-10-20T00:00:00Z"), lt: new Date("2026-10-21T00:00:00Z"), not: null },
    });
    expect(where("due < 2026-10-20")).toEqual({ dueDate: { lt: new Date("2026-10-20T00:00:00Z"), not: null } });
    expect(where("due <= 2026-10-20")).toEqual({ dueDate: { lt: new Date("2026-10-21T00:00:00Z"), not: null } });
    expect(where("due > 2026-10-20")).toEqual({ dueDate: { gte: new Date("2026-10-21T00:00:00Z"), not: null } });
    expect(where("created > -7d")).toEqual({ createdAt: { gte: new Date(NOW.getTime() - 7 * 86400000 + 1) } });
    expect(where("created >= startOfWeek()")).toEqual({ createdAt: { gte: new Date("2026-10-12T00:00:00Z") } });
    expect(where("completed >= sinceLastStandup()")).toEqual({
      completedAt: { gte: new Date("2026-10-14T00:00:00Z"), not: null },
    });
    expect(where("completed >= sinceLastStandup()", env({ sinceLastStandup: new Date("2026-10-15T09:00:00Z") }))).toEqual({
      completedAt: { gte: new Date("2026-10-15T09:00:00Z"), not: null },
    });
    expect(where("due = 2026-10-20", env({ tz: "America/Chicago" }))).toEqual({
      dueDate: { gte: new Date("2026-10-20T05:00:00Z"), lt: new Date("2026-10-21T05:00:00Z"), not: null },
    });
  });

  it("text: case-insensitive contains, prefix on the title, text spans title/description/comments", () => {
    expect(where("summary ~ login")).toEqual({ title: { contains: "login", mode: "insensitive" } });
    expect(where('summary ~ "log*"')).toEqual({ title: { startsWith: "log", mode: "insensitive" } });
    expect(where("summary !~ wip")).toEqual({ NOT: { title: { contains: "wip", mode: "insensitive" } } });
    expect(where("text ~ x")).toEqual({
      OR: [
        { title: { contains: "x", mode: "insensitive" } },
        { description: { contains: "x", mode: "insensitive" } },
        { comments: { some: { content: { contains: "x", mode: "insensitive" } } } },
      ],
    });
  });

  it("LIKE wildcards in a search are literal (Prisma does not escape them)", () => {
    expect(where('summary ~ "50%_off\\\\"')).toEqual({ title: { contains: "50\\%\\_off\\\\", mode: "insensitive" } });
    expect(where('comment ~ "%"')).toEqual({ comments: { some: { content: { contains: "\\%", mode: "insensitive" } } } });
  });

  it("relations: labels, IN ALL, watcher, blocked, links, parent", () => {
    expect(where('label = "ref:label:l1"')).toEqual({ labels: { some: { labelId: { in: ["l1"] } } } });
    expect(where('labels IN ALL ("ref:label:l1", "ref:label:l2")')).toEqual({
      AND: [{ labels: { some: { labelId: "l1" } } }, { labels: { some: { labelId: "l2" } } }],
    });
    expect(where("blocked = true")).toEqual({
      OR: [{ incomingLinks: { some: { type: "BLOCKS" } } }, { outgoingLinks: { some: { type: "BLOCKED_BY" } } }],
    });
    expect(where('parent = "ref:item:i1"')).toEqual({ parentId: { in: ["i1"], not: null } });
    expect(where("watchedItems()")).toEqual({ watchers: { some: { userId: "me-id" } } });
    expect(where('childrenOf("ref:item:i1")')).toEqual({ parentId: "i1" });
  });

  it("an empty date is a plain null, so IS EMPTY / IS NOT EMPTY / != partition", () => {
    expect(where("due IS EMPTY")).toEqual({ dueDate: null });
    expect(where("due IS NOT EMPTY")).toEqual({ NOT: { dueDate: null } });
  });

  it("key comparisons are within the item's project", () => {
    expect(where('key > "ref:item:item-100"')).toEqual({ projectId: "p1", ticketNumber: { gt: 100 } });
    expect(where('key > "ref:item:unknown"')).toEqual({ id: { in: [] } });
  });

  it("sets from functions, and variables: unset is inert, a list narrows", () => {
    const k = (name: string) => JSON.stringify({ args: [], name });
    expect(where("sprint IN openSprints()", env({ fnIds: new Map([[k("openSprints"), ["s1", "s2"]]]) }))).toEqual({
      intervalId: { in: ["s1", "s2"], not: null },
    });
    expect(where("assignee = $speaker")).toEqual({});
    const vars = new Map([["speaker@assignee", [{ t: "ref" as const, entity: "user" as const, id: "u9" }]]]);
    expect(where("assignee = $speaker", env({ vars }))).toEqual({
      OR: [{ assigneeId: { in: ["u9"], not: null } }, { assignees: { some: { userId: { in: ["u9"] } } } }],
    });
  });

  it("custom fields by type; estimates in seconds", () => {
    expect(where("Severity = S1")).toEqual({ customFields: { path: ["sev"], equals: "S1" } });
    expect(where("N > 3")).toEqual({ customFields: { path: ["n"], gt: 3 } });
    expect(where("Areas IN ALL (web, api)")).toEqual({ customFields: { path: ["areas"], array_contains: ["web", "api"] } });
    expect(where("originalEstimate > 1d")).toEqual({ originalEstimate: { gt: 8 * 3600, not: null } });
  });

  it("archived: mentioned → all (the clause decides); otherwise active", () => {
    expect(compileQuery(q("priority = HIGH"), env()).archived).toBe("active");
    expect(compileQuery(q("archived = true"), env()).archived).toBe("all");
    expect(where("archived = true")).toEqual({ archivedAt: { not: null } });
  });

  it("ORDER BY: Prisma columns, nulls defaults, and a stable tiebreak", () => {
    expect(compileQuery(q("ORDER BY due DESC, priority, type"), env()).orderBy).toEqual([
      { dueDate: { sort: "desc", nulls: "first" } },
      { priority: "asc" },
      { workItemType: { name: "asc" } },
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });
});

/** Every key anywhere in a where tree. */
function keysIn(o: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(o)) o.forEach((x) => keysIn(x, out));
  else if (o && typeof o === "object" && !(o instanceof Date)) {
    for (const [k, v] of Object.entries(o)) {
      out.add(k);
      keysIn(v, out);
    }
  }
  return out;
}

describe("compile — the scope envelope holds for any query", () => {
  it("orgId never appears in the user predicate; the envelope carries org + readable projects", () => {
    let compiled = 0;
    fc.assert(
      fc.property(queryArb, (raw) => {
        const t = typecheck(raw, { customFields: [{ key: "severity", name: "Severity", fieldType: "SELECT" }] });
        if (t.diagnostics.some((d) => d.severity === "error")) return;
        let c;
        try {
          c = compileQuery(t.query, env());
        } catch {
          return; // values the resolver would have rejected (e.g. a str for a ref)
        }
        compiled++;
        const scoped = buildScopedWhere({ orgId: ORG, allowedProjectIds: READABLE, archived: c.archived, user: c.where });
        expect(scoped.orgId).toBe(ORG);
        expect(scoped.projectId).toEqual({ in: READABLE });
        expect(scoped.AND).toEqual([c.where]);
        expect(Object.keys(scoped).sort()).toEqual(
          ["AND", "orgId", "projectId", ...(c.archived === "all" ? [] : ["archivedAt"])].sort(),
        );
        expect(keysIn(c.where).has("orgId")).toBe(false);
      }),
      // Most random queries fail the typechecker (that's its job), so run many
      // to compile well over a thousand.
      { numRuns: 20000 },
    );
    // The property must not pass by skipping everything.
    expect(compiled).toBeGreaterThan(1000);
  });

  it("an empty readable set matches nothing whatever the predicate", () => {
    expect(buildScopedWhere({ orgId: ORG, allowedProjectIds: [], archived: "all", user: { OR: [{}, { id: "x" }] } }).projectId).toEqual({ in: [] });
  });
});
