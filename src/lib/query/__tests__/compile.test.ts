// The compiler is pure: resolved query + environment → Prisma where. These
// pin its output for representative clauses, and prove over generated queries
// that whatever a user writes stays inside the scope envelope.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { FALSE, SERVER_ONLY, compileQuery, historySpecs } from "../compile";
import { historyKey } from "../history";
import { parseCql } from "../parser";
import { typecheck } from "../typecheck";
import { fnKey, type CompileEnv } from "../env";
import { buildScopedWhere } from "@/lib/work-items/query/build-where";
import { queryArb } from "./arbitraries";
import type { CqlQuery } from "../ast";
import { UNDECIDED, matches } from "../evaluate";
import { itemMatchesTeam, itemTeamIds, teamsByUser, type TeamLike } from "@/lib/teams/item-teams";

const NOW = new Date("2026-10-15T15:00:00Z");
const ORG = "org-1";
const READABLE = ["p1", "p2"];

/**
 * t1 and t3 in p1, t2 in p2; u2 is on t1 and t2; t3 has nobody. u4 was on t1
 * and has left the org, so is on no team (ROSTERS reads current members only,
 * as loadTeamRosters does), though the membership rows are still there.
 */
const ROSTERS = new Map([
  ["t1", { projectId: "p1", userIds: ["u1", "u2"] }],
  ["t2", { projectId: "p2", userIds: ["u2"] }],
  ["t3", { projectId: "p1", userIds: [] as string[] }],
]);
/** What the compiler is given: every readable team's project, and no people. */
const TEAMS: NonNullable<CompileEnv["teamProjects"]> = new Map([...ROSTERS].map(([id, r]) => [id, r.projectId]));
/**
 * A user's org memberships as `assignee.memberships` loads them: current, or
 * left, with their team rows. u3 is also a member of another org, on a team
 * there whose id this org's teams share (ids are uuids in life; the clash is
 * what would show a join that forgot the org).
 */
type Membership = { orgId: string; removedAt: string | null; projectMembers: { teamMembers: { teamId: string }[] }[] };
const MEMBERSHIPS: Record<string, Membership[]> = {
  u1: [{ orgId: ORG, removedAt: null, projectMembers: [{ teamMembers: [{ teamId: "t1" }] }] }],
  u2: [{ orgId: ORG, removedAt: null, projectMembers: [{ teamMembers: [{ teamId: "t1" }] }, { teamMembers: [{ teamId: "t2" }] }] }],
  u3: [
    { orgId: ORG, removedAt: null, projectMembers: [{ teamMembers: [] }] },
    { orgId: "org-2", removedAt: null, projectMembers: [{ teamMembers: [{ teamId: "t1" }] }] },
  ],
  u4: [{ orgId: ORG, removedAt: "2026-09-01T00:00:00.000Z", projectMembers: [{ teamMembers: [{ teamId: "t1" }] }] }],
};
/** `membersOf(team)`'s people, as the old resolver listed them: current members of this org on the team. */
const ON_TEAM = (team: string) =>
  Object.entries(MEMBERSHIPS)
    .filter(([, ms]) => ms.some((m) => m.orgId === ORG && !m.removedAt && m.projectMembers.some((p) => p.teamMembers.some((t) => t.teamId === team))))
    .map(([u]) => u);
/** A person on one of these teams, through their membership of this org: the join `team` and `membersOf()` compile to. */
const ON = (...teams: string[]) => ({
  memberships: { some: { orgId: ORG, removedAt: null, projectMembers: { some: { teamMembers: { some: { teamId: { in: teams } } } } } } },
});
/** The fnIds key the resolver files `membersOf(team)` under. */
const MEMBERS_OF = (team: string) => fnKey({ t: "fn", name: "membersOf", args: [{ t: "ref", entity: "team", id: team }] });
/** A stand-in for readableCommentsWhere. */
const COMMENTS_YOU_CAN_READ = { visibility: "PUBLIC" as const, deletedAt: null, hiddenAt: null };
/** What a comment-text predicate compiles to under the default env's comment scope. */
const inReadableComment = (content: Record<string, unknown>) => ({
  AND: [{ projectId: { in: ["p1"] } }, { comments: { some: { AND: [COMMENTS_YOU_CAN_READ, content] } } }],
});

function env(over: Partial<CompileEnv> = {}): CompileEnv {
  return {
    actorUserId: "me-id",
    now: NOW,
    tz: "UTC",
    vars: new Map(),
    statusCategories: {
      TODO: [{ projectId: "p1", keys: ["todo"] }],
      IN_PROGRESS: [{ projectId: "p1", keys: ["doing", "review"] }],
      DONE: [{ projectId: "p1", keys: ["done"] }, { projectId: "p2", keys: ["shipped"] }],
      CANCELLED: [],
    },
    items: new Map([["item-100", { projectId: "p1", ticketNumber: 100 }]]),
    customFields: new Map([["sev", "SELECT"], ["n", "NUMBER"], ["areas", "MULTI_SELECT"]]),
    descendants: new Map([["item-1", ["c1", "c2", "g1"]]]),
    milestoneItems: new Map([["m1", ["c1", "x9"]]]),
    milestoneLinked: ["c1", "x9", "y7"],
    history: new Map(),
    teamProjects: TEAMS,
    teamOrgId: ORG,
    // What the resolver files for `membersOf(t)`: the team, when the actor can read it.
    fnIds: new Map([...TEAMS.keys()].map((t) => [MEMBERS_OF(t), [t]])),
    readableComments: { projectIds: ["p1"], where: COMMENTS_YOU_CAN_READ },
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
        inReadableComment({ content: { contains: "x", mode: "insensitive" } }),
      ],
    });
  });

  it("comment text: only comments the actor may read, in projects where they hold COMMENT_READ", () => {
    expect(where("comment ~ x")).toEqual(inReadableComment({ content: { contains: "x", mode: "insensitive" } }));
    expect(where("comment !~ x")).toEqual({ NOT: inReadableComment({ content: { contains: "x", mode: "insensitive" } }) });
    // No project where the actor may read comments: `comment ~` matches nothing,
    // and `text ~` is the title and the description.
    const none = env({ readableComments: { projectIds: [], where: COMMENTS_YOU_CAN_READ } });
    expect(where("comment ~ x", none)).toEqual(FALSE);
    expect(where("text ~ x", none)).toEqual({
      OR: [{ title: { contains: "x", mode: "insensitive" } }, { description: { contains: "x", mode: "insensitive" } }],
    });
  });

  it("comment text fails closed without the readable comment scope", () => {
    for (const q of ["comment ~ x", "text ~ x", "comment !~ x", "x"]) {
      expect(() => where(q, env({ readableComments: undefined })), q).toThrow(/readableComments/);
    }
  });

  it("LIKE wildcards in a search are literal (Prisma does not escape them)", () => {
    expect(where('summary ~ "50%_off\\\\"')).toEqual({ title: { contains: "50\\%\\_off\\\\", mode: "insensitive" } });
    expect(where('comment ~ "%"')).toEqual(inReadableComment({ content: { contains: "\\%", mode: "insensitive" } }));
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

  it("hierarchy and milestones compile to the resolver's id sets", () => {
    expect(where('ancestor = "ref:item:item-1"')).toEqual({ id: { in: ["c1", "c2", "g1"] } });
    expect(where('ancestor IN ("ref:item:item-1", "ref:item:none")')).toEqual({ id: { in: ["c1", "c2", "g1"] } });
    expect(where('ancestor = "ref:item:none"')).toEqual({ id: { in: [] } });
    expect(where('descendantsOf("ref:item:item-1")')).toEqual({ id: { in: ["c1", "c2", "g1"] } });
    expect(where('descendantsOf("ref:item:none")')).toEqual({ id: { in: [] } });
    expect(where('milestone = "ref:milestone:m1"')).toEqual({ id: { in: ["c1", "x9"] } });
    expect(where("milestone IS EMPTY")).toEqual({ id: { notIn: ["c1", "x9", "y7"] } });
  });

  it("history: CHANGED and untimed WAS are Activity relation filters", () => {
    const act = (w: object) => ({ activities: { some: { action: "updated", field: "columnKey", ...w } } });
    expect(where("status CHANGED")).toEqual(act({}));
    expect(where('status CHANGED FROM "ref:status:todo" TO ("ref:status:done", "ref:status:shipped") BY me')).toEqual(
      act({
        AND: [{ oldValue: { in: ["todo"] } }, { newValue: { in: ["done", "shipped"] } }],
        userId: { in: ["me-id"] },
      }),
    );
    expect(where('status CHANGED AFTER 2026-10-01 BEFORE -1d')).toEqual(
      act({ createdAt: { gte: new Date("2026-10-02T00:00:00Z"), lt: new Date("2026-10-14T15:00:00Z") } }),
    );
    // Now, or a recorded change that left or entered it.
    expect(where('status WAS "ref:status:done"')).toEqual({
      OR: [{ columnKey: { in: ["done"] } }, act({ OR: [{ oldValue: { in: ["done"] } }, { newValue: { in: ["done"] } }] })],
    });
    // Nullable columns stay two-valued under NOT.
    expect(where("assignee WAS NOT me")).toEqual({
      NOT: {
        OR: [
          { assigneeId: { in: ["me-id"], not: null } },
          { activities: { some: { action: "updated", field: "assigneeId", OR: [{ oldValue: { in: ["me-id"] } }, { newValue: { in: ["me-id"] } }] } } },
        ],
      },
    });
    expect(where("assignee WAS EMPTY BY me")).toEqual({
      activities: { some: { action: "updated", field: "assigneeId", newValue: null, userId: { in: ["me-id"] } } },
    });
  });

  it("history: a window is prefiltered ids (held at the start or set inside), or holding it since", () => {
    const e = env();
    const q14 = 'status WAS "ref:status:done" AFTER -14d';
    const specs = historySpecs(q(q14).where, e);
    expect(specs).toEqual([
      { kind: "window", field: "status", set: { values: ["done"], ranges: [], empty: false }, from: "2026-10-01T15:00:00.000Z", to: null },
    ]);
    e.history.set(historyKey(specs[0]), ["i1", "i2"]);
    const act = (w: object) => ({ activities: { some: { action: "updated", field: "columnKey", ...w } } });
    expect(where(q14, e)).toEqual({ OR: [{ id: { in: ["i1", "i2"] } }, { columnKey: { in: ["done"] } }] });
    expect(where(`NOT (${q14})`, e)).toMatchObject({ NOT: { OR: expect.any(Array) } });
    // BEFORE only: a change before the end entered or left it (a per-item
    // EXISTS, never a scan of the org's history), or the prefilter's "first
    // change at or after the end started from it", or born before the end,
    // holding it, and quiet since.
    const qB = 'status WAS "ref:status:done" BEFORE 2026-10-01';
    const eB = env();
    eB.history.set(historyKey(historySpecs(q(qB).where, eB)[0]), ["i3"]);
    const end = new Date("2026-10-01T00:00:00Z");
    expect(where(qB, eB)).toEqual({
      OR: [
        act({ OR: [{ oldValue: { in: ["done"] } }, { newValue: { in: ["done"] } }], createdAt: { lt: end } }),
        { id: { in: ["i3"] } },
        { AND: [{ columnKey: { in: ["done"] } }, { createdAt: { lt: end } }, { NOT: act({ createdAt: { gte: end } }) }] },
      ],
    });
    // Without its prefilter the compiler refuses rather than guessing.
    expect(() => where(q14)).toThrow(/prefilter/);
    // A history clause with an unset variable is inert, so it needs no prefilter.
    expect(historySpecs(q("status WAS $s AFTER -1d").where, env())).toEqual([]);
  });

  it("history: dates match as ISO text ranges, in Activity and on the column", () => {
    expect(where("due WAS 2026-10-20")).toEqual({
      OR: [
        { dueDate: { gte: new Date("2026-10-20T00:00:00Z"), lt: new Date("2026-10-21T00:00:00Z"), not: null } },
        {
          activities: {
            some: {
              action: "updated",
              field: "dueDate",
              OR: [
                { oldValue: { gte: "2026-10-20T00:00:00.000Z", lt: "2026-10-21T00:00:00.000Z" } },
                { newValue: { gte: "2026-10-20T00:00:00.000Z", lt: "2026-10-21T00:00:00.000Z" } },
              ],
            },
          },
        },
      ],
    });
    expect(historySpecs(q("due CHANGED FROM 2026-10-20 TO EMPTY").where, env())).toEqual([]);
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

/** A stand-in for what files/access.ts builds for an ordinary member. */
const DOC_VISIBILITY: NonNullable<CompileEnv["documentVisibility"]> = {
  OR: [
    { visibility: "INHERIT", OR: [{ projectId: null }, { projectId: { in: ["p1"] } }] },
    { visibility: "RESTRICTED", OR: [{ uploadedById: "me-id" }, { shares: { some: { userId: "me-id" } } }] },
  ],
};

describe("compile — merged-into, sub-items and attachments", () => {
  it("mergedInto filters its own scalar column, exactly as parent does", () => {
    expect(where('mergedInto = "ref:item:i9"')).toEqual({ mergedIntoId: { in: ["i9"], not: null } });
    // The field it was modelled on, asserted beside it so the two cannot drift.
    expect(where('parent = "ref:item:i9"')).toEqual({ parentId: { in: ["i9"], not: null } });
    expect(where('mergedInto IN ("ref:item:i9", "ref:item:i8")')).toEqual({ mergedIntoId: { in: ["i9", "i8"], not: null } });
    // Empty is "never merged away", and `!=` stays two-valued over a nullable column.
    expect(where("mergedInto IS EMPTY")).toEqual({ mergedIntoId: null });
    expect(where('mergedInto != "ref:item:i9"')).toEqual({
      AND: [{ NOT: { mergedIntoId: { in: ["i9"], not: null } } }, { NOT: { mergedIntoId: null } }],
    });
  });

  it("hasChildren counts only LIVE sub-items the actor can read", () => {
    // Two deliberate semantics in one predicate, neither accidental:
    //   archivedAt — an archived sub-item leaves a leaf;
    //   projectId  — so does a sub-item in a project you cannot read.
    // The second is scope, and it has to be stated HERE because the predicate
    // is nested: buildScopedWhere's envelope constrains the outer row only.
    const e = env({ readableProjectIds: ["pA", "pB"] });
    const live = { archivedAt: null, projectId: { in: ["pA", "pB"] } };

    expect(where("hasChildren = true", e)).toEqual({ children: { some: live } });
    expect(where("hasChildren = false", e)).toEqual({ children: { none: live } });
    expect(where("children = true", e)).toEqual({ children: { some: live } });
  });

  it("hasChildren FAILS CLOSED: no readable set means it throws, never a bare relation filter", () => {
    // The first cut of this field compiled to `{ children: { some: { archivedAt: null } } }`
    // and a security review caught it: nested filters escape the scope
    // envelope, so that form answers "yes, it has a sub-item" on the strength
    // of a child in a project the actor cannot read. A throw is the only safe
    // absence — every fallback either over-matches or matches everything.
    expect(() => where("hasChildren = true")).toThrow(/readableProjectIds/);
    expect(() => where("hasChildren = false")).toThrow(/readableProjectIds/);
    // And it is not reachable past a cheaper conjunct either.
    expect(() => where("priority = HIGH AND hasChildren = true")).toThrow(/readableProjectIds/);
  });

  it("an actor who can read NOTHING sees every item as a leaf, not as a parent", () => {
    // The degenerate case, pinned so it cannot drift to "matches everything":
    // an empty readable set must make `= true` unsatisfiable, not vacuous.
    const none = env({ readableProjectIds: [] });
    expect(where("hasChildren = true", none)).toEqual({
      children: { some: { archivedAt: null, projectId: { in: [] } } },
    });
  });

  it("hasAttachments carries the actor's own document-visibility predicate, both ways", () => {
    const e = env({ documentVisibility: DOC_VISIBILITY });
    expect(where("attachments = true", e)).toEqual({ documents: { some: DOC_VISIBILITY } });
    // `none` means "no attachment YOU can see": an item whose only file is
    // restricted reads as having none, which discloses nothing about the file.
    expect(where("hasAttachments = false", e)).toEqual({ documents: { none: DOC_VISIBILITY } });
  });

  it("hasAttachments FAILS CLOSED: no predicate means it throws, never a bare relation filter", () => {
    // The disclosure channel this guards is `{ documents: { some: {} } }`, which
    // answers "there is a file on this ticket" to somebody not allowed to see it.
    expect(() => where("hasAttachments = true")).toThrow(/documentVisibility/);
    expect(() => where("hasAttachments = false")).toThrow(/documentVisibility/);
    let compiled: unknown = "not reached";
    try {
      compiled = where("attachments = true");
    } catch {
      /* expected */
    }
    expect(compiled).toBe("not reached");
    // …and the whole query is refused, not just the clause: a predicate that
    // dropped the clause would widen the result set instead of narrowing it.
    expect(() => where("priority = HIGH AND hasAttachments = true")).toThrow(/documentVisibility/);
  });
});

describe("compile — team is the team's work, as the board reads it", () => {
  // The team rule (lib/teams/item-teams.ts): an item's own team wins; an item
  // with none is the work of every team in its project its primary assignee is
  // on. The column alone was the defect: untagged work never matched.
  const own = (...ids: string[]) => ({ teamId: { in: ids, not: null } });
  /** Untagged, in this project, and the primary assignee is a current member of one of these teams. */
  const theirs = (projectId: string, ...teams: string[]) => ({
    AND: [
      { teamId: null },
      { projectId },
      { assigneeId: { not: null } },
      { assignee: { is: ON(...teams) } },
    ],
  });

  it("`team = X`: tagged with X, or untagged and assigned to someone on X in X's project", () => {
    expect(where('team = "ref:team:t1"')).toEqual({ OR: [own("t1"), theirs("p1", "t1")] });
  });

  it("a list takes each named team's people in its own project", () => {
    expect(where('team IN ("ref:team:t1", "ref:team:t2")')).toEqual({
      OR: [own("t1", "t2"), theirs("p1", "t1"), theirs("p2", "t2")],
    });
  });

  it("a team the actor can't read is its tagged work only", () => {
    expect(where('team = "ref:team:t9"')).toEqual(own("t9"));
  });

  it("IS EMPTY is what no team claims; != stays two-valued and leaves out the unclaimed", () => {
    const claimed = { OR: [theirs("p1", "t1", "t3"), theirs("p2", "t2")] };
    expect(where("team IS EMPTY")).toEqual({ AND: [{ teamId: null }, { NOT: claimed }] });
    expect(where('team != "ref:team:t1"')).toEqual({
      AND: [{ NOT: { OR: [own("t1"), theirs("p1", "t1")] } }, { NOT: { AND: [{ teamId: null }, { NOT: claimed }] } }],
    });
  });

  it("the where names teams and never a person, however large the teams", () => {
    // A where with user ids in it reached the browser (`POST cql/predicate`),
    // and past 30,000 of them was refused as too broad.
    for (const text of ['team = "ref:team:t1"', 'team != "ref:team:t2"', "team IS EMPTY", 'team IN ("ref:team:t1", "ref:team:t3")']) {
      const json = JSON.stringify(where(text));
      for (const user of Object.keys(MEMBERSHIPS)) expect(json).not.toContain(`"${user}"`);
    }
  });

  it("FAILS CLOSED: no teams means it throws, never the column-only answer", () => {
    expect(() => where('team = "ref:team:t1"', env({ teamProjects: undefined }))).toThrow(/teamProjects/);
    expect(() => where("team IS EMPTY", env({ teamProjects: undefined }))).toThrow(/teamProjects/);
  });

  it("FAILS CLOSED on the org: the membership hop is held to the teams' org, or the field is refused", () => {
    // Without the org, a person's membership of ANOTHER org, on a team there,
    // would count (u3 below), and the join could not use org_members' (org_id,
    // user_id) index.
    expect(() => where('team = "ref:team:t1"', env({ teamOrgId: undefined }))).toThrow(/teamOrgId/);
    expect(() => where("team IS EMPTY", env({ teamOrgId: undefined }))).toThrow(/teamOrgId/);
  });

  // The board sees one project's rows with that project's teams; so does
  // this, item by item.
  const teamsIn = (projectId: string): TeamLike[] =>
    [...ROSTERS].filter(([, r]) => r.projectId === projectId).map(([id, r]) => ({ id, name: id, members: r.userIds.map((userId) => ({ userId })) }));
  const itemArb = fc.constantFrom("p1", "p2").chain((projectId) =>
    fc.record({
      id: fc.constant("i"),
      projectId: fc.constant(projectId),
      teamId: fc.constantFrom(null, ...teamsIn(projectId).map((t) => t.id)),
      assigneeId: fc.constantFrom(null, "u1", "u2", "u3", "u4"),
    }),
  );
  /** The item with its assignee's memberships loaded, as the database would join them. */
  const loaded = (item: { assigneeId: string | null }) => ({
    ...item,
    assignee: item.assigneeId ? { id: item.assigneeId, memberships: MEMBERSHIPS[item.assigneeId] } : null,
  });

  it("agrees with the board's rule (itemMatchesTeam) and the dashboards' groups (itemTeamIds) on every item", () => {
    fc.assert(
      fc.property(itemArb, fc.constantFrom("t1", "t2", "t3"), (item, teamId) => {
        const board = itemMatchesTeam(item, teamId, teamsByUser(teamsIn(item.projectId)));
        expect(matches(where(`team = "ref:team:${teamId}"`), loaded(item))).toBe(board);
        expect(matches(where(`team != "ref:team:${teamId}"`), loaded(item))).toBe(!board && itemTeamIds(item, ROSTERS).length > 0);
        expect(itemTeamIds(item, ROSTERS).includes(teamId)).toBe(board);
        expect(matches(where("team IS EMPTY"), loaded(item))).toBe(itemTeamIds(item, ROSTERS).length === 0);
      }),
      { numRuns: 500 },
    );
  });

  it("on a board's row, which carries no memberships, it decides all but untagged assigned items, and decides them right", () => {
    fc.assert(
      fc.property(itemArb, fc.constantFrom("t1", "t2", "t3"), (item, teamId) => {
        for (const text of [`team = "ref:team:${teamId}"`, `team != "ref:team:${teamId}"`, "team IS EMPTY"]) {
          const verdict = matches(where(text), item);
          if (verdict === UNDECIDED) expect(item.teamId === null && item.assigneeId !== null).toBe(true);
          else expect(verdict).toBe(matches(where(text), loaded(item)));
        }
      }),
      { numRuns: 300 },
    );
    // And the server really is asked: an untagged item assigned in the team's project.
    const row = { id: "i", projectId: "p1", teamId: null, assigneeId: "u1" };
    expect(matches(where('team = "ref:team:t1"'), row)).toBe(UNDECIDED);
    expect(matches(where('team = "ref:team:t1"'), loaded(row))).toBe(true);
  });
});

describe("compile — membersOf() joins to the team, and never lists its people", () => {
  /** Untagged or not: the primary assignee is a current member of one of these teams. */
  const primaryOn = (...teams: string[]) => ({ AND: [{ assigneeId: { not: null } }, { assignee: { is: ON(...teams) } }] });
  const coOn = (...teams: string[]) => ({ assignees: { some: { user: { is: ON(...teams) } } } });

  it("`assignee IN membersOf(X)`: the primary assignee or a co-assignee is on X", () => {
    expect(where('assignee IN membersOf("ref:team:t1")')).toEqual({ OR: [primaryOn("t1"), coOn("t1")] });
  });

  it("NOT IN is the complement of IN on assigned items, and leaves the unassigned out", () => {
    expect(where('assignee NOT IN membersOf("ref:team:t1")')).toEqual({
      AND: [{ NOT: { OR: [primaryOn("t1"), coOn("t1")] } }, { NOT: { assigneeId: null, assignees: { none: {} } } }],
    });
  });

  it("beside named people, each kind compiles its own way; several teams share one join", () => {
    expect(where('assignee IN (me, membersOf("ref:team:t1"), membersOf("ref:team:t2"))')).toEqual({
      OR: [
        { assigneeId: { in: ["me-id"], not: null } },
        { assignees: { some: { userId: { in: ["me-id"] } } } },
        primaryOn("t1", "t2"),
        coOn("t1", "t2"),
      ],
    });
  });

  it("a team the actor can't read matches nobody", () => {
    expect(where('assignee IN membersOf("ref:team:t9")', env({ fnIds: new Map([[MEMBERS_OF("t9"), []]]) }))).toEqual(FALSE);
  });

  it("primary assignee and watcher join the same way", () => {
    expect(where('primaryAssignee IN membersOf("ref:team:t1")')).toEqual(primaryOn("t1"));
    expect(where('watcher IN membersOf("ref:team:t1")')).toEqual({ watchers: { some: { user: { is: ON("t1") } } } });
  });

  it("the joined fields name the team and none of its people, though the people are to hand", () => {
    // The teams' people are in the env, as on the server when another field in
    // the same query needs them, so a joined field that read them would show.
    const people = new Map([
      [MEMBERS_OF("t1"), ON_TEAM("t1")],
      [MEMBERS_OF("t2"), ON_TEAM("t2")],
    ]);
    expect(ON_TEAM("t1")).toEqual(["u1", "u2"]);
    // Positive control: a field that takes the people does list them here.
    expect(JSON.stringify(where('reporter IN membersOf("ref:team:t1")', env({ teamMemberIds: people })))).toContain('"u1"');
    for (const e of [env({ teamMemberIds: people }), env({ teamMemberIds: people, forBrowser: true })]) {
      for (const text of [
        'assignee IN membersOf("ref:team:t1")',
        'assignee NOT IN membersOf("ref:team:t1")',
        'primaryAssignee IN membersOf("ref:team:t2")',
        'watcher IN membersOf("ref:team:t1")',
      ]) {
        const json = JSON.stringify(where(text, e));
        for (const user of Object.keys(MEMBERSHIPS)) expect(json, text).not.toContain(`"${user}"`);
        expect(json, text).toContain('"t');
      }
    }
  });

  // reporter (a bare created_by_id), @mentions (tokens in text), a person
  // custom field (JSON) and history (Activity rows) store people's ids and
  // have no relation to join through, so they still need the ids.
  const PEOPLE = new Map([[MEMBERS_OF("t1"), ["u1", "u2"]]]);
  const SERVER_SIDE = [
    'reporter IN membersOf("ref:team:t1")',
    'mentions IN membersOf("ref:team:t1")',
    'cf[owner] IN membersOf("ref:team:t1")',
    'assignee WAS IN membersOf("ref:team:t1")',
    'priority CHANGED BY membersOf("ref:team:t1")',
  ];
  const withOwner = (over: Partial<CompileEnv> = {}) =>
    env({ customFields: new Map([["owner", "USER"]]), history: new Map(), ...over });
  const whereOwner = (text: string, e: CompileEnv) => {
    const p = parseCql(text);
    const t = typecheck(p.query, { customFields: [{ key: "owner", name: "Owner", fieldType: "USER" }] });
    expect(t.diagnostics.filter((d) => d.severity === "error"), text).toEqual([]);
    const query = JSON.parse(JSON.stringify(t.query).replace(/\{"t":"str","v":"ref:team:(\w+)"\}/g, '{"t":"ref","entity":"team","id":"$1"}')) as CqlQuery;
    return compileQuery(query, e).where;
  };

  it("on the server, the fields that can't join get the people from `teamMemberIds`", () => {
    expect(whereOwner(SERVER_SIDE[0], withOwner({ teamMemberIds: PEOPLE }))).toEqual({ createdById: { in: ["u1", "u2"] } });
    expect(JSON.stringify(whereOwner(SERVER_SIDE[2], withOwner({ teamMemberIds: PEOPLE })))).toContain('"u2"');
    expect(JSON.stringify(whereOwner(SERVER_SIDE[4], withOwner({ teamMemberIds: PEOPLE })))).toContain('"u1"');
  });

  it("for the browser they are left to the server: no person, and a marker the board can't decide", () => {
    // The people are in the env, so a browser predicate that listed them would show them.
    for (const text of SERVER_SIDE) {
      const w = whereOwner(text, withOwner({ forBrowser: true, teamMemberIds: PEOPLE }));
      const json = JSON.stringify(w);
      for (const user of Object.keys(MEMBERSHIPS)) expect(json, text).not.toContain(`"${user}"`);
      expect(json, text).toContain(JSON.stringify(SERVER_ONLY));
      expect(matches(w, { id: "i", projectId: "p1", createdById: "u1", assigneeId: "u1", description: "<@u1>", customFields: { owner: "u1" } }), text).toBe(UNDECIDED);
    }
    // NOT of a deferred clause is deferred too, and decided parts stay decided.
    const both = whereOwner('priority = HIGH AND reporter NOT IN membersOf("ref:team:t1")', withOwner({ forBrowser: true, teamMemberIds: PEOPLE }));
    expect(matches(both, { id: "i", priority: "LOW", createdById: "u1" })).toBe(false);
    expect(matches(both, { id: "i", priority: "HIGH", createdById: "u1" })).toBe(UNDECIDED);
  });

  it("FAILS CLOSED: on the server without the people, or without the org, it throws", () => {
    expect(() => whereOwner(SERVER_SIDE[0], withOwner())).toThrow(/teamMemberIds/);
    expect(() => where('assignee IN membersOf("ref:team:t1")', env({ teamOrgId: undefined }))).toThrow(/teamOrgId/);
  });

  it("the server's answer is the old one: the same items as listing the team's current members", () => {
    // Every item shape the join can meet: no assignee, a primary, co-assignees,
    // someone who left the org, someone on the team in another org only.
    const userArb = fc.constantFrom("u1", "u2", "u3", "u4");
    const itemArb = fc.record({
      id: fc.constant("i"),
      projectId: fc.constantFrom("p1", "p2"),
      assigneeId: fc.option(userArb, { nil: null }),
      co: fc.uniqueArray(userArb, { maxLength: 3 }),
    });
    const loaded = (it: { id: string; projectId: string; assigneeId: string | null; co: string[] }) => ({
      id: it.id,
      projectId: it.projectId,
      assigneeId: it.assigneeId,
      assignee: it.assigneeId ? { id: it.assigneeId, memberships: MEMBERSHIPS[it.assigneeId] } : null,
      assignees: it.co.map((u) => ({ userId: u, user: { id: u, memberships: MEMBERSHIPS[u] } })),
    });
    fc.assert(
      fc.property(itemArb, fc.constantFrom("t1", "t2", "t3"), fc.boolean(), (it, team, negate) => {
        const op = negate ? "NOT IN" : "IN";
        const people = ON_TEAM(team);
        // The old compile: the team's people as ids.
        const listed = compileQuery(
          { v: 1, where: { op: "in", field: { kind: "sys", id: "assignee" }, ...(negate ? { negate: true } : {}), values: people.map((id) => ({ t: "ref", entity: "user", id })) } },
          env(),
        ).where;
        const row = loaded(it);
        const old = people.length ? matches(listed, row) : negate ? it.assigneeId !== null || it.co.length > 0 : false;
        expect(matches(where(`assignee ${op} membersOf("ref:team:${team}")`), row)).toBe(old);
      }),
      { numRuns: 500 },
    );
  });
});

describe("compile — mentions", () => {
  const tokenIn = (column: "description" | "content", ...tokens: string[]) =>
    tokens.map((t) => ({ [column]: { contains: t, mode: "insensitive" } }));

  it("a token in the description, or in a comment the actor may read", () => {
    expect(where('mentions = "ref:user:u1"')).toEqual({
      OR: [
        { OR: tokenIn("description", "<@u1>", "<@user:u1>") },
        {
          AND: [
            { projectId: { in: ["p1"] } },
            { comments: { some: { AND: [COMMENTS_YOU_CAN_READ, { OR: tokenIn("content", "<@u1>", "<@user:u1>") }] } } },
          ],
        },
      ],
    });
  });

  it("`me` is the actor", () => {
    expect(JSON.stringify(where("mentions = me"))).toContain("<@me-id>");
  });

  it("with no project whose comments are readable, only the description counts", () => {
    expect(where('mentions = "ref:user:u1"', env({ readableComments: { projectIds: [], where: COMMENTS_YOU_CAN_READ } }))).toEqual({
      OR: tokenIn("description", "<@u1>", "<@user:u1>"),
    });
  });

  it("FAILS CLOSED: no comment scope means it throws, never a bare comments filter", () => {
    expect(() => where("mentions = me", env({ readableComments: undefined }))).toThrow(/readableComments/);
  });
});

describe("compile — pi", () => {
  it("takes the PI's own work and its sprints', never a PI found inside it", () => {
    expect(where('pi = "ref:interval:pi1"')).toEqual({
      AND: [
        { intervalId: { not: null } },
        {
          OR: [
            { intervalId: { in: ["pi1"] } },
            { interval: { is: { parentId: { in: ["pi1"] }, intervalKind: { not: "PROGRAM_INCREMENT" } } } },
          ],
        },
      ],
    });
  });
});

/** Every key anywhere in a where tree, except inside a person's `memberships`. */
function keysIn(o: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(o)) o.forEach((x) => keysIn(x, out));
  else if (o && typeof o === "object" && !(o instanceof Date)) {
    for (const [k, v] of Object.entries(o)) {
      out.add(k);
      if (k !== "memberships") keysIn(v, out);
    }
  }
  return out;
}

/** Every `orgId` value inside a person's `memberships` (the team join's hop), anywhere in a where tree. */
function membershipOrgIds(o: unknown, inside = false, out: unknown[] = []): unknown[] {
  if (Array.isArray(o)) o.forEach((x) => membershipOrgIds(x, inside, out));
  else if (o && typeof o === "object" && !(o instanceof Date)) {
    for (const [k, v] of Object.entries(o)) {
      if (inside && k === "orgId") out.push(v);
      membershipOrgIds(v, inside || k === "memberships", out);
    }
  }
  return out;
}

describe("compile — the scope envelope holds for any query", () => {
  it("orgId never appears in the user predicate; the envelope carries org + readable projects", () => {
    let compiled = 0;
    let joined = 0;
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
        // The predicate never scopes the item by org. The one orgId it may
        // carry is the team join's, holding a person's membership to the
        // envelope's own org (compile.ts, `onTeams`).
        expect(keysIn(c.where).has("orgId")).toBe(false);
        const orgs = membershipOrgIds(c.where);
        if (orgs.length) joined++;
        for (const org of orgs) expect(org).toBe(ORG);
      }),
      // Most random queries fail the typechecker (that's its job), so run many
      // to compile well over a thousand.
      { numRuns: 20000 },
    );
    // The property must not pass by skipping everything, nor by never meeting a join.
    expect(compiled).toBeGreaterThan(1000);
    expect(joined).toBeGreaterThan(0);
  });

  it("the team join's orgId is the envelope's org and sits only inside `memberships`", () => {
    for (const text of ["team IS EMPTY", 'team != "ref:team:t1"', 'assignee NOT IN membersOf("ref:team:t2")', 'watcher IN membersOf("ref:team:t1")']) {
      const w = where(text);
      expect(keysIn(w).has("orgId"), text).toBe(false);
      expect(membershipOrgIds(w).length, text).toBeGreaterThan(0);
      for (const org of membershipOrgIds(w)) expect(org, text).toBe(ORG);
    }
  });

  it("an empty readable set matches nothing whatever the predicate", () => {
    expect(buildScopedWhere({ orgId: ORG, allowedProjectIds: [], archived: "all", user: { OR: [{}, { id: "x" }] } }).projectId).toEqual({ in: [] });
  });
});
