// (e2e DB) THE CQL safety property, fuzzed.
//
// Generated queries mix readable and restricted names, ids and functions, under
// OR / NOT / parentheses, as text and as JSON with raw refs. Run as four actors
// (member, org admin, ABAC-denied, project-scoped API key) against the
// two-org world. For every one:
//   1. every returned row is from a project the actor can read, where "can
//      read" is written out by hand below, NOT computed by the code under test;
//   2. a successful response contains no restricted name and no restricted id;
//   3. an error mentions no restricted name the query text didn't already say;
//   4. nothing takes longer than the statement budget.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { OrgRole } from "@prisma/client";
import { executeCql } from "../execute.server";
import { CqlError } from "../errors";
import { CQL_VERSION, type CqlNode, type CqlQuery } from "../ast";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");

describe("CQL scope escape (e2e DB, property)", () => {
  let w: World;
  beforeAll(async () => {
    w = await seedWorld();
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  function actors() {
    return [
      { name: "member", ctx: w.ctx(), readable: [w.P1.id, w.P3.id] },
      { name: "admin", ctx: w.ctx({ role: OrgRole.ADMIN }), readable: [w.P1.id, w.P2.id, w.P3.id] },
      { name: "abac-denied", ctx: w.ctx({ denyP3: true }), readable: [w.P1.id] },
      { name: "api-key", ctx: w.ctx({ projectScope: [w.P1.id, w.P2.id] }), readable: [w.P1.id] },
    ];
  }

  /** Clause texts whose values reach into readable AND restricted places. */
  function clauseArb(): fc.Arbitrary<string> {
    const q = (s: string) => JSON.stringify(s);
    const s = w.stamp;
    return fc.oneof(
      fc.constantFrom("Ada Actor", "Bob Builder", `Ghost Secretperson ${s}`, w.actor.email, w.bob.id, "me").map((v) => `assignee = ${v === "me" ? v : q(v)}`),
      fc.constantFrom("Sprint 1", "Sprint 0", `Secretsprint ${s}`, w.sprintP2Active, w.sprintP1Active).map((v) => `sprint = ${q(v)}`),
      fc.constantFrom("Platform", `Secretteam ${s}`, w.teamP2).map((v) => `team = ${q(v)}`),
      fc.constantFrom("auth", "urgent", `secretlabel-${s}`, w.labels.secret).map((v) => `label = ${q(v)}`),
      fc.constantFrom(w.P1.key, w.P2.key, w.P3.key, `Secretproject ${s}`, w.P2.id).map((v) => `project = ${q(v)}`),
      fc.constantFrom("Review", "Secret Review Lane", "todo", "in-progress").map((v) => `status = ${q(v)}`),
      fc.constantFrom(`${w.P1.key}-1`, `${w.P2.key}-1`, `${w.P3.key}-1`).map((v) => `parent = ${v}`),
      fc.constantFrom(`${w.P1.key}-1`, `${w.P2.key}-1`).map((v) => `childrenOf(${v})`),
      fc.constantFrom("Platform", `Secretteam ${s}`).map((v) => `assignee IN membersOf(${q(v)})`),
      fc.constantFrom("Secret", "login", "Secretitem", s).map((v) => `text ~ ${q(v)}`),
      fc.constantFrom("HIGH", "CRITICAL", "LOW").map((v) => `priority >= ${v}`),
      fc.constantFrom("todo", "done", "in progress").map((v) => `statusCategory = ${q(v)}`),
      fc.constant("sprint IN openSprints()"),
      fc.constant("team IN myTeams()"),
      fc.constant("watchedItems()"),
      fc.constant("assignee IS EMPTY"),
      fc.constant("blocked = true"),
      fc.constant("archived = true"),
    );
  }

  const textQueryArb = () => fc.letrec<{ e: string }>((tie) => ({
    e: fc.oneof(
      { depthSize: "small" },
      { weight: 4, arbitrary: clauseArb() },
      { weight: 1, arbitrary: fc.tuple(tie("e"), tie("e")).map(([a, b]) => `(${a} OR ${b})`) },
      { weight: 1, arbitrary: fc.tuple(tie("e"), tie("e")).map(([a, b]) => `${a} AND ${b}`) },
      { weight: 1, arbitrary: tie("e").map((a) => `NOT (${a})`) },
    ),
  })).e;

  /** JSON queries carrying raw ids, as a saved filter or dashboard panel would. */
  function jsonQueryArb(): fc.Arbitrary<CqlQuery> {
    const refs = fc.constantFrom(
      { field: "project", entity: "project", id: w.P2.id },
      { field: "project", entity: "project", id: w.P1.id },
      { field: "sprint", entity: "interval", id: w.sprintP2Active },
      { field: "team", entity: "team", id: w.teamP2 },
      { field: "label", entity: "label", id: w.labels.secret },
      { field: "key", entity: "item", id: w.items[`p2-secret-${w.stamp}`].id },
      { field: "parent", entity: "item", id: w.items[`p2-secret-${w.stamp}`].id },
      { field: "assignee", entity: "user", id: w.actor.id },
    );
    const leaf = fc.tuple(refs, fc.boolean()).map(
      ([r, negate]): CqlNode => ({
        op: "in",
        field: { kind: "sys", id: r.field as never },
        ...(negate ? { negate: true } : {}),
        values: [{ t: "ref", entity: r.entity as never, id: r.id }],
      }),
    );
    return fc.array(leaf, { minLength: 1, maxLength: 3 }).chain((args) =>
      fc.constantFrom("and", "or").map((op): CqlQuery => ({
        v: CQL_VERSION,
        where: args.length === 1 ? args[0] : ({ op, args } as CqlNode),
      })),
    );
  }

  function restrictedIds(): string[] {
    return [w.P2.id, w.sprintP2Active, w.teamP2, w.items[`p2-secret-${w.stamp}`].id, w.items[`b1-otherorg-${w.stamp}`].id];
  }

  async function checkOne(actor: ReturnType<typeof actors>[number], input: { cql?: string; query?: CqlQuery }) {
    const started = Date.now();
    const text = input.cql ?? "";
    const readable = new Set(actor.readable);
    // What the actor can't see, minus what they typed themselves.
    const secrets = w.secrets.filter((s) => !text.includes(s));
    try {
      const r = await executeCql(actor.ctx, input, { now: NOW, pageSize: 100 });
      for (const row of r.data) expect(readable.has(row.project.id), `${actor.name}: ${text}`).toBe(true);
      expect(r.total ?? 0).toBeLessThanOrEqual(20);
      if (actor.name !== "admin") {
        const body = JSON.stringify(r);
        for (const s of secrets) expect(body.includes(s), `${actor.name} leaked "${s}" for ${text || JSON.stringify(input.query)}`).toBe(false);
        for (const id of restrictedIds()) expect(body.includes(id), `${actor.name} leaked id ${id}`).toBe(false);
      }
    } catch (e) {
      if (!(e instanceof CqlError)) throw e;
      if (actor.name !== "admin") {
        const body = JSON.stringify(e.diagnostics);
        for (const s of secrets) expect(body.includes(s), `${actor.name} error leaked "${s}" for ${text}`).toBe(false);
      }
    }
    expect(Date.now() - started).toBeLessThan(3_000);
  }

  it("text queries never return rows outside the readable set or name restricted things", async () => {
    for (const actor of actors()) {
      await fc.assert(
        fc.asyncProperty(textQueryArb(), async (cql) => checkOne(actor, { cql })),
        { numRuns: 120 },
      );
    }
  }, 300_000);

  it("JSON queries with raw restricted ids are narrowed, never widened or echoed", async () => {
    for (const actor of actors()) {
      await fc.assert(
        fc.asyncProperty(jsonQueryArb(), async (query) => checkOne(actor, { query })),
        { numRuns: 60 },
      );
    }
  }, 300_000);

  it("org B's identically keyed project, sprint and label are never reached from org A", async () => {
    const r = await executeCql(w.ctx({ role: OrgRole.ADMIN }), { cql: `sprint = "Sprint 1" OR label = auth OR project = ${w.P1.key}` }, { now: NOW, pageSize: 100 });
    expect(r.data.map((x) => x.title)).not.toContain(`b1-otherorg-${w.stamp}`);
  });

  it("SQL-looking input is just text", async () => {
    for (const cql of [`summary ~ "'; DROP TABLE work_items; --"`, `summary ~ "%"`, `summary ~ "_"`, `summary ~ "\\\\"`, `label = "$1"`]) {
      try {
        const r = await executeCql(w.ctx(), { cql }, { now: NOW });
        expect(r.total, cql).toBe(0);
      } catch (e) {
        expect(e).toBeInstanceOf(CqlError);
      }
    }
  });
});
