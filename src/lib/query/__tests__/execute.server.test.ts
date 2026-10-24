// (e2e DB) executeCql end to end against Postgres: parse → typecheck → scoped
// resolve → compile → scoped envelope → rows. Uses the two-org world in
// cql-fixture.ts, where restricted projects hold exact twins of readable values.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OrgRole } from "@prisma/client";
import { executeCql, withStatementTimeout } from "../execute.server";
import { CqlError } from "../errors";
import { CQL_VERSION, type CqlQuery } from "../ast";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z"); // a Thursday

describe("executeCql (e2e DB)", () => {
  let w: World;
  beforeAll(async () => {
    w = await seedWorld();
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const run = async (cql: string, opts: Parameters<typeof executeCql>[2] = {}, role?: OrgRole) => {
    const r = await executeCql(w.ctx({ role }), { cql }, { now: NOW, pageSize: 100, ...opts });
    return { ...r, titles: r.data.map((x) => x.title).sort() };
  };
  const err = async (cql: string, opts: Parameters<typeof executeCql>[2] = {}) => {
    try {
      await executeCql(w.ctx(), { cql }, { now: NOW, ...opts });
    } catch (e) {
      if (e instanceof CqlError) return e.diagnostics;
      throw e;
    }
    throw new Error(`expected ${cql} to fail`);
  };

  it("an empty query is every ACTIVE readable item (archived default, restricted projects excluded)", async () => {
    const r = await run("");
    expect(r.titles).toEqual(["p1-child", "p1-coowned", "p1-done", "p1-login-bug", "p1-unassigned", `p3-denied-${w.stamp}`].sort());
    expect(r.total).toBe(6);
  });

  it("an ABAC deny and an API-key project scope narrow the readable set", async () => {
    const denied = await executeCql(w.ctx({ denyP3: true }), { cql: "" }, { now: NOW, pageSize: 100 });
    expect(denied.data.map((x) => x.title)).not.toContain(`p3-denied-${w.stamp}`);
    const keyed = await executeCql(w.ctx({ projectScope: [w.P3.id] }), { cql: "" }, { now: NOW, pageSize: 100 });
    expect(keyed.data.map((x) => x.title)).toEqual([`p3-denied-${w.stamp}`]);
  });

  it("assignee = me matches primary or co-assignee; != hides unassigned (Jira rule) with a warning", async () => {
    expect((await run("assignee = me")).titles).toEqual(["p1-login-bug", `p3-denied-${w.stamp}`]);
    expect((await run(`assignee = "Bob Builder"`)).titles).toEqual(["p1-coowned", "p1-done"]);
    const neq = await run("assignee != me");
    expect(neq.titles).toEqual(["p1-coowned", "p1-done"]);
    expect(neq.diagnostics.map((d) => d.code)).toContain("CQL_NEQ_EXCLUDES_EMPTY");
    expect((await run("assignee != me OR assignee IS EMPTY")).titles).toEqual(["p1-child", "p1-coowned", "p1-done", "p1-unassigned"]);
    // primaryAssignee ignores co-assignees: p1-coowned's only assignee is a co-assignee.
    expect((await run(`primaryAssignee = "Bob Builder"`)).titles).toEqual(["p1-done"]);
    expect((await run("primaryAssignee IS EMPTY")).titles).toEqual(["p1-child", "p1-coowned", "p1-unassigned"]);
    expect((await run("assignee IN (me, EMPTY)")).titles).toEqual(["p1-child", "p1-login-bug", "p1-unassigned", `p3-denied-${w.stamp}`]);
  });

  it("priority compares in order; statusCategory follows the board's categories and completion", async () => {
    expect((await run("priority > MEDIUM")).titles).toEqual(["p1-coowned", "p1-login-bug", `p3-denied-${w.stamp}`]);
    expect((await run("statusCategory = done")).titles).toEqual(["p1-done"]);
    expect((await run("statusCategory = IN_PROGRESS")).titles).toEqual(["p1-coowned", "p1-login-bug"]);
    expect((await run("statusCategory = cancelled")).titles).toEqual(["p1-child"]);
    expect((await run("status = Review")).titles).toEqual(["p1-coowned"]);
  });

  it("sprints by name resolve only in readable projects; openSprints() too", async () => {
    // "Sprint 1" also exists in restricted P2 and in org B.
    expect((await run(`sprint = "Sprint 1"`)).titles).toEqual(["p1-login-bug"]);
    expect((await run("sprint IN openSprints()")).titles).toEqual(["p1-login-bug"]);
    expect((await run("sprint IN closedSprints()")).titles).toEqual(["p1-done"]);
    expect((await run("sprint IS EMPTY")).titles).toEqual(["p1-child", "p1-coowned", `p3-denied-${w.stamp}`]);
  });

  it("labels, text, blocked, parent, watcher, team and membersOf()", async () => {
    expect((await run("label = auth")).titles).toEqual(["p1-login-bug", `p3-denied-${w.stamp}`]);
    expect((await run("labels IN ALL (auth)")).titles).toEqual(["p1-login-bug", `p3-denied-${w.stamp}`]);
    expect((await run("text ~ login")).titles).toEqual(["p1-login-bug", "p1-unassigned"]);
    expect((await run("summary ~ login")).titles).toEqual(["p1-login-bug"]);
    expect((await run(`summary ~ "p1-c*"`)).titles).toEqual(["p1-child", "p1-coowned"]);
    expect((await run("blocked = true")).titles).toEqual(["p1-unassigned"]);
    expect((await run(`parent = ${w.P1.key}-1`)).titles).toEqual(["p1-child"]);
    expect((await run(`childrenOf(${w.P1.key}-1)`)).titles).toEqual(["p1-child"]);
    expect((await run("watcher = me")).titles).toEqual(["p1-login-bug"]);
    expect((await run("watchedItems()")).titles).toEqual(["p1-login-bug"]);
    expect((await run("team = Platform")).titles).toEqual(["p1-login-bug"]);
    expect((await run("assignee IN membersOf(Platform)")).titles).toEqual(["p1-coowned", "p1-done"]);
  });

  it("dates: relative offsets, functions and literal days in the request time zone", async () => {
    expect((await run("due <= 2026-10-20")).titles).toEqual(["p1-login-bug"]);
    expect((await run("due < 2026-10-20")).titles).toEqual([]);
    expect((await run("due = 2026-10-20")).titles).toEqual(["p1-login-bug"]);
    expect((await run("completed >= startOfWeek(-1w) AND completed < startOfWeek()")).titles).toEqual(["p1-done"]);
    expect((await run("due < now()")).titles).toEqual([]);
    // Everything was created after NOW (a fixed past instant); none before it.
    expect((await run("created < -1d")).titles).toEqual([]);
    // 2026-10-20T00:00Z is still 19 October in Chicago.
    expect((await run("due = 2026-10-19", { tz: "America/Chicago" })).titles).toEqual(["p1-login-bug"]);
  });

  it("dates: IS EMPTY and IS NOT EMPTY split the items between them; != leaves the empty ones out", async () => {
    const all = (await run(`project = ${w.P1.key}`)).titles;
    const empty = (await run(`project = ${w.P1.key} AND due IS EMPTY`)).titles;
    const set = (await run(`project = ${w.P1.key} AND due IS NOT EMPTY`)).titles;
    expect(set).toEqual(["p1-login-bug"]);
    expect([...empty, ...set].sort()).toEqual(all);
    // != leaves out items with no date (the Jira rule); OR IS EMPTY brings them back.
    expect((await run(`project = ${w.P1.key} AND due != 2026-10-21`)).titles).toEqual(["p1-login-bug"]);
    expect((await run(`project = ${w.P1.key} AND (due != 2026-10-21 OR due IS EMPTY)`)).titles).toEqual(all);
  });

  it("custom fields, estimates, highlight, work category, cancel reason", async () => {
    expect((await run(`cf[sev_${w.stamp}] = S1`)).titles).toEqual(["p1-login-bug"]);
    expect((await run(`Severity IN (S1, S2)`)).titles).toEqual(["p1-login-bug"]);
    expect((await run("originalEstimate >= 4h")).titles).toEqual(["p1-login-bug"]);
    expect((await run("originalEstimate > 1d")).titles).toEqual([]);
    expect((await run("highlight = RED")).titles).toEqual(["p1-login-bug"]);
    expect((await run("workCategory = ENABLER AND cancelReason = OBE")).titles).toEqual(["p1-child"]);
  });

  it("archived items appear only when the query mentions archiving", async () => {
    expect((await run("archived = true")).titles).toEqual(["p1-archived"]);
    expect((await run("assignee = me AND (archived = true OR archived = false)")).titles).toEqual(["p1-archived", "p1-login-bug", `p3-denied-${w.stamp}`]);
  });

  it("ORDER BY with a stable tiebreak; paging and totals", async () => {
    const r = await executeCql(w.ctx(), { cql: "ORDER BY priority ASC, key DESC" }, { now: NOW, pageSize: 2, page: 1 });
    expect(r.total).toBe(6);
    expect(r.data).toHaveLength(2);
    expect(r.data[0].priority).toBe("CRITICAL");
    const all = await executeCql(w.ctx(), { cql: "ORDER BY priority ASC, key DESC" }, { now: NOW, pageSize: 100 });
    const p2 = await executeCql(w.ctx(), { cql: "ORDER BY priority ASC, key DESC" }, { now: NOW, pageSize: 2, page: 2 });
    expect(p2.data.map((x) => x.id)).toEqual(all.data.slice(2, 4).map((x) => x.id));
  });

  it("dashboard variables: unset is inert, set narrows, an empty list matches nothing", async () => {
    expect((await run("assignee = $speaker")).total).toBe(6);
    expect((await run("assignee = $speaker", { vars: { speaker: w.bob.id } })).titles).toEqual(["p1-coowned", "p1-done"]);
    expect((await run("assignee IN $team", { vars: { team: [] } })).total).toBe(0);
  });

  it("a JSON query takes the same path; stored refs to unreadable things are dropped silently", async () => {
    const q: CqlQuery = {
      v: CQL_VERSION,
      where: { op: "in", field: { kind: "sys", id: "sprint" }, values: [{ t: "ref", entity: "interval", id: w.sprintP2Active }] },
    };
    const r = await executeCql(w.ctx(), { query: q }, { now: NOW });
    expect(r.total).toBe(0);
    expect(JSON.stringify(r)).not.toContain(w.sprintP2Active);
  });

  it("restricted names are unknown, worded exactly like names that don't exist", async () => {
    const secret = await err(`sprint = "Secretsprint ${w.stamp}"`);
    const missing = await err(`sprint = "No such sprint"`);
    expect(secret[0].code).toBe("CQL_UNKNOWN_VALUE");
    expect(secret[0].message).toBe(missing[0].message.replace("No such sprint", `Secretsprint ${w.stamp}`));
    expect((await err(`project = ${w.P2.key}`))[0].code).toBe("CQL_UNKNOWN_VALUE");
    expect((await err(`team = "Secretteam ${w.stamp}"`))[0].code).toBe("CQL_UNKNOWN_VALUE");
    expect((await err(`assignee = "Nobody Here"`))[0].code).toBe("CQL_UNKNOWN_VALUE");
  });

  it("two people with one name is ambiguous, with a fix per person", async () => {
    const d = await err(`assignee = "Alex Same"`);
    expect(d[0].code).toBe("CQL_AMBIGUOUS_VALUE");
    expect(d[0].fixes).toHaveLength(2);
  });

  it("syntax and type errors carry positions", async () => {
    const d = await err("priority = ");
    expect(d[0].code).toBe("CQL_SYNTAX");
    expect(d[0].from).toBe(11);
    const t = await err("status ~ x");
    expect(t[0].code).toBe("CQL_OPERATOR_NOT_SUPPORTED");
    const u = await err("priorty = HIGH");
    expect(u[0].code).toBe("CQL_UNKNOWN_FIELD");
    expect(u[0].hint).toContain("priority");
  });

  it("% and _ in a search are literal characters", async () => {
    const { prisma } = await import("@/lib/db/client");
    const row = await prisma.workItem.create({
      data: {
        orgId: w.orgA, projectId: w.P1.id, ticketNumber: 900, title: "Ship 100%_now", description: "",
        columnKey: "todo", workItemTypeId: w.typeTask, createdById: w.actor.id,
      },
    });
    try {
      expect((await run('summary ~ "100%_n"')).titles).toEqual(["Ship 100%_now"]);
      expect((await run('summary ~ "100%"')).titles).toEqual(["Ship 100%_now"]);
      expect((await run('summary ~ "1_0"')).titles).toEqual([]);
    } finally {
      await prisma.workItem.delete({ where: { id: row.id } });
    }
  });

  it("reads statuses from the project, not its boards: one no board shows still resolves, a ceremony prompt does not", async () => {
    const { prisma } = await import("@/lib/db/client");
    // A status made through the API, shown by no column, with an item in it.
    await prisma.workflowStatus.create({
      data: { orgId: w.orgA, projectId: w.P1.id, key: "blocked", name: "Blocked", category: "IN_PROGRESS", sortOrder: 50 },
    });
    const board = await prisma.board.create({ data: { orgId: w.orgA, projectId: w.P1.id, name: "Retro", type: "SPRINT_REVIEW" } });
    await prisma.boardColumn.create({ data: { boardId: board.id, key: "went-well", name: "Went well", category: "DONE", sortOrder: 0 } });
    const row = await prisma.workItem.create({
      data: {
        orgId: w.orgA, projectId: w.P1.id, ticketNumber: 901, title: "stuck", description: "",
        columnKey: "blocked", workItemTypeId: w.typeTask, createdById: w.actor.id,
      },
    });
    try {
      expect((await run("status = Blocked")).titles).toEqual(["stuck"]);
      expect((await run("statusCategory = IN_PROGRESS")).titles).toContain("stuck");
      const e = await err('status = "Went well"');
      expect(e[0].code).toBe("CQL_UNKNOWN_VALUE");
    } finally {
      await prisma.workItem.delete({ where: { id: row.id } });
      await prisma.board.delete({ where: { id: board.id } });
      await prisma.workflowStatus.delete({ where: { projectId_key: { projectId: w.P1.id, key: "blocked" } } });
    }
  });

  it("a statement over budget is cancelled and reported as CQL_TIMEOUT", async () => {
    await expect(withStatementTimeout(100, (tx) => tx.$queryRaw`SELECT 1 AS x FROM pg_sleep(2)`)).rejects.toMatchObject({
      status: 422,
      diagnostics: [expect.objectContaining({ code: "CQL_TIMEOUT" })],
    });
    // The timeout was SET LOCAL: the next transaction is not affected.
    await expect(withStatementTimeout(5000, (tx) => tx.$queryRaw`SELECT 1 AS x FROM pg_sleep(0.2)`)).resolves.toBeDefined();
  });

  it("bare words are a text search", async () => {
    expect((await run("login")).titles).toEqual(["p1-login-bug", "p1-unassigned"]);
  });
});
