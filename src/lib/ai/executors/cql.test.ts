// The assistant's query-language tools (query design §12.3), against the CQL
// test world: the same scope as the Issues list, diagnostics the model can act
// on, and a GOV view that keeps ids and counts and drops the free text.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { seedWorld, type World } from "@/lib/query/__tests__/cql-fixture";
import { withCqlEnabled } from "@/lib/query/flag";
import { projectResult, entityTypeForTool } from "@/lib/ai/egress/projection";
import { stubToolCtx } from "@/lib/testing/tool-auth";
import { searchWorkItems, describeCql } from "./cql";
import type { ToolContext } from "./_ctx";

let w: World;
let ctx: ToolContext;
const setCql = (on: boolean) =>
  prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, on) as object } });

beforeAll(async () => {
  w = await seedWorld();
  ctx = { orgId: w.orgA, userId: w.actor.id, auth: w.ctx({ denyP3: true }) };
  await setCql(true);
}, 60_000);
afterAll(async () => {
  await w?.cleanup();
});

type Search = {
  count: number;
  total: number | null;
  cql: string;
  url: string;
  items: Record<string, unknown>[];
  error?: string;
  diagnostics?: { message: string; line: number; column: number; fixes?: string[] }[];
};
const search = async (input: Record<string, unknown>, c: ToolContext = ctx) => (await searchWorkItems(input, c)) as Search;
const titles = (r: Search) => r.items.map((i) => i.title).sort();

describe("search_work_items", () => {
  it("searches every readable project, never a restricted, denied or other-org item", async () => {
    const r = await search({ cql: "priority = CRITICAL" });
    // The CRITICAL twins in P2 (restricted), P3 (ABAC-denied) and org B stay out.
    expect(titles(r)).toEqual(["p1-login-bug"]);
    expect(r.total).toBe(1);
    const all = JSON.stringify(await search({ cql: 'text ~ "login"' }));
    for (const secret of w.secrets) expect(all).not.toContain(secret);
    expect(titles(await search({ cql: 'text ~ "login"' }))).toEqual(["p1-login-bug", "p1-unassigned"]);
  });

  it("an API key's project ceiling binds the assistant too", async () => {
    const scoped: ToolContext = { orgId: w.orgA, userId: w.actor.id, auth: w.ctx({ projectScope: [w.P3.id] }) };
    const r = await search({ cql: "priority = CRITICAL" }, scoped);
    expect(r.items.map((i) => i.projectId)).toEqual([w.P3.id]);
  });

  it("returns the normalized query, a link to it on Issues, and the total beyond the limit", async () => {
    const r = await search({ cql: "priority in (low, high) order by priority", limit: 1 });
    expect(r.cql).toBe("priority IN (LOW, HIGH) ORDER BY priority ASC");
    const slug = (await prisma.organization.findUniqueOrThrow({ where: { id: w.orgA } })).slug;
    expect(r.url).toBe(`/${slug}/issues?cql=${encodeURIComponent(r.cql)}`);
    expect(r.count).toBe(1);
    expect(r.total).toBe(2);
    expect(titles(r)).toEqual(["p1-coowned"]);
  });

  it("fields picks what comes back beyond ids and dates", async () => {
    const [item] = (await search({ cql: "priority = CRITICAL", fields: ["priority", "assignee"] })).items;
    expect(item).toMatchObject({ id: w.items["p1-login-bug"].id, priority: "CRITICAL", assigneeId: w.actor.id, assigneeName: "Ada Actor" });
    expect(item).not.toHaveProperty("title");
    expect(item).not.toHaveProperty("labels");
    const full = (await search({ cql: "priority = CRITICAL" })).items[0];
    expect(full).toMatchObject({ title: "p1-login-bug", columnKey: "in-progress", storyPoints: 5, dueDate: expect.stringMatching(/^2026-10-20/) });
  });

  it("bad CQL comes back as positioned diagnostics with the fix, for the model to retry", async () => {
    const r = await search({ cql: "priority = HIGH AND priorty = LOW" });
    expect(r.error).toMatch(/Fix the query/);
    expect(r.diagnostics?.[0]).toMatchObject({ line: 1, column: 21 });
    expect(r.diagnostics?.[0].fixes?.[0]).toMatch(/priority/);
  });

  it("refuses without ITEM_READ, a bad input, and an org without the query language", async () => {
    expect(await searchWorkItems({ cql: "priority = HIGH" }, stubToolCtx(w.orgA, w.actor.id))).toEqual({ error: "Insufficient permissions" });
    expect((await search({ cql: "" })).error).toMatch(/Invalid input/);
    expect((await search({ cql: "priority = HIGH", limit: 500 })).error).toMatch(/Invalid input/);
    await setCql(false);
    try {
      expect((await search({ cql: "priority = HIGH" })).error).toMatch(/not switched on.*list_work_items/);
    } finally {
      await setCql(true);
    }
  });

  it("a GOV tenant's view keeps counts and ids and drops titles, the query text and the link", () => {
    const output = {
      count: 1, total: 1, totalCapped: false, cql: 'summary ~ "Secret"', url: "/x/issues?cql=…",
      items: [{ id: "i1", ticketNumber: 3, ticketKey: "ACME-3", projectId: "p", title: "Secret", columnKey: "todo", assigneeName: "Ada", labels: ["a"] }],
    };
    expect(entityTypeForTool("search_work_items")).toBe("work_item");
    expect(projectResult(output, entityTypeForTool("search_work_items"))).toEqual({
      count: 1, total: 1, totalCapped: false, items: [{ id: "i1", ticketNumber: 3, projectId: "p" }],
    });
    // describe_cql lists names (people, sprints): withheld whole.
    expect(projectResult({ values: [{ value: "Ada" }] }, entityTypeForTool("describe_cql"))).toMatchObject({ withheld: true });
  });
});

describe("describe_cql", () => {
  it("with no field: the reference, including this org's custom fields", async () => {
    const r = (await describeCql({}, ctx)) as { reference: string };
    expect(r.reference).toContain("statusCategory");
    expect(r.reference).toContain("openSprints()");
    expect(r.reference).toContain(`sev_${w.stamp}`);
  });

  it("with a field: the values that exist here, as written in a query, never a restricted one", async () => {
    const r = (await describeCql({ field: "status" }, ctx)) as { field: string; values: { value: string; label: string }[] };
    expect(r.field).toMatch(/^status/);
    expect(r.values.map((v) => v.label)).toEqual(expect.arrayContaining(["To Do", "Review", "Done"]));
    expect(JSON.stringify(r)).not.toContain("Secret Review Lane");
    const people = (await describeCql({ field: "assignee", prefix: "Bob" }, ctx)) as { values: { value: string }[] };
    expect(people.values[0].value).toBe('"Bob Builder"');
  });

  it("an unknown field lists the real ones", async () => {
    expect(((await describeCql({ field: "severity_typo" }, ctx)) as { error: string }).error).toMatch(/Unknown field.*statusCategory/);
  });
});
