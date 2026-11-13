// @vitest-environment node
//
// ⌘K finds a work item by a LABEL it carries or a CUSTOM-FIELD value set on it,
// not only by its title or ticket number. The match must never widen what the
// caller could already see: a team-scoped project's items stay hidden from
// people off the team, an API key's project scope still binds, a role without
// item reads gets nothing, and a field defined on a project the caller can't
// see is not searched. Driven through the real routes against a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";
import { withCqlEnabled } from "@/lib/query/flag";
import { ATTRIBUTE_BUDGET_MS, itemAttributeMatch } from "./item-attributes.server";

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  /** Budgets the search ran its attribute query under, in ms. */
  budgets: [] as number[],
  /** Make a work-item query run under a budget outlast it, for real: Postgres cancels it. */
  slow: false,
  /** Make describing the attribute matches fail. */
  failDescribe: false,
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/query/timeout.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/query/timeout.server")>();
  return {
    ...real,
    withStatementTimeout: (ms: number, fn: Parameters<typeof real.withStatementTimeout>[1]) => {
      h.budgets.push(ms);
      return real.withStatementTimeout(ms, (tx) => {
        if (!h.slow) return fn(tx);
        // Only a work-item read inside the budget is slowed, so this is the
        // search's own query, not CQL's preparation.
        const workItem = new Proxy(tx.workItem, {
          get: (d, prop) =>
            prop === "findMany"
              ? async (args: unknown) => {
                  await tx.$queryRaw`SELECT pg_sleep(3)`;
                  return (d.findMany as (a: unknown) => Promise<unknown>)(args);
                }
              : Reflect.get(d, prop),
        });
        return fn(new Proxy(tx, { get: (t, prop) => (prop === "workItem" ? workItem : Reflect.get(t, prop)) }));
      });
    },
  };
});
vi.mock("@/lib/mentions/item-attributes.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mentions/item-attributes.server")>();
  return {
    ...real,
    itemAttributeMatch: async (...args: Parameters<typeof real.itemAttributeMatch>) => {
      const match = await real.itemAttributeMatch(...args);
      if (!match || !h.failDescribe) return match;
      return { ...match, describe: async () => { throw new Error("describe failed (test)"); } };
    },
  };
});

import { GET as globalSearch } from "@/app/api/v1/orgs/[orgId]/search/route";
import { GET as mentionSearch } from "@/app/api/v1/orgs/[orgId]/mentions/search/route";

type Role = "MEMBER" | "BILLING_ADMIN";
const stamp = Math.random().toString(36).slice(2, 8);
// The searched text. No title below contains it, so every hit is an attribute match.
const M = `zq${stamp}`;
let orgId = "";
const u = { insider: "", outsider: "", billing: "" };
const roles: Record<keyof typeof u, Role> = { insider: "MEMBER", outsider: "MEMBER", billing: "BILLING_ADMIN" };
const id: Record<string, string> = {};
const key = { text: `cust${stamp}`, pick: `tier${stamp}`, multi: `tags${stamp}`, secret: `hush${stamp}` };

function session(who: keyof typeof u, extra: Partial<AuthContext> = {}): AuthContext {
  const permissions = RolePermissions[roles[who]];
  return { userId: u[who], orgId, orgRole: roles[who], abacRules: [], basePermissions: permissions, permissions, ...extra };
}
const req = (path: string) => new NextRequest(`http://localhost/api/v1/orgs/${orgId}${path}`);
const at = () => ({ params: Promise.resolve({ orgId }) });

type Hit = { id: string; type: string; name: string; description?: string };
async function search(ctx: AuthContext, q: string): Promise<Hit[]> {
  h.ctx = ctx;
  const res = await globalSearch(req(`/search?q=${encodeURIComponent(q)}`), at());
  expect(res.status).toBe(200);
  return ((await res.json()) as Hit[]).filter((r) => r.type === "workItem");
}
const ids = (hits: Hit[]) => hits.map((x) => x.id).sort();

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `sat ${stamp}`, slug: `sat-${stamp}` } })).id;
  const om: Record<string, string> = {};
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@sat.test`, displayName: `${k} ${stamp}` } })).id;
    om[k] = (await prisma.orgMember.create({ data: { orgId, userId: u[k], role: roles[k], permissions: "0" } })).id;
  }
  const open = await prisma.project.create({ data: { orgId, name: `Open ${stamp}`, key: `O${stamp}`.toUpperCase().slice(0, 7) } });
  const sec = await prisma.project.create({
    data: { orgId, name: `Sec ${stamp}`, key: `S${stamp}`.toUpperCase().slice(0, 7), teamScopedAccess: true },
  });
  await prisma.projectMember.create({ data: { projectId: sec.id, orgMemberId: om.insider } });
  id.open = open.id;
  id.sec = sec.id;

  const typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
  const item = async (projectId: string, name: string, customFields?: Prisma.InputJsonObject) => {
    const row = await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: u.insider, title: `${name} ${stamp}`, columnKey: "todo" });
    if (customFields) await prisma.workItem.update({ where: { id: row.id }, data: { customFields } });
    return row.id;
  };

  // A label carried by one item in each project.
  const label = await prisma.label.create({ data: { orgId, name: `Security-${M}-lbl` } });
  id.openLabel = await item(open.id, "open labelled");
  id.secLabel = await item(sec.id, "sec labelled");
  for (const workItemId of [id.openLabel, id.secLabel]) {
    await prisma.workItemLabel.create({ data: { orgId, workItemId, labelId: label.id } });
  }

  // Org-wide custom fields: free text, a single choice and a multiple choice.
  await prisma.customField.createMany({
    data: [
      { orgId, name: "Customer", key: key.text, fieldType: "TEXT" },
      { orgId, name: "Tier", key: key.pick, fieldType: "SELECT", options: [`gold-${M}-pick`, "silver"] },
      { orgId, name: "Areas", key: key.multi, fieldType: "MULTI_SELECT", options: [`north-${M}-multi`, "south"] },
      // Defined on the team-scoped project only.
      { orgId, projectId: sec.id, name: "Codename", key: key.secret, fieldType: "TEXT" },
    ],
  });
  id.openText = await item(open.id, "open texted", { [key.text]: `ACME ${M.toUpperCase()}-CUST corp` });
  id.secText = await item(sec.id, "sec texted", { [key.text]: `acme ${M}-cust corp` });
  id.openPick = await item(open.id, "open picked", { [key.pick]: `gold-${M}-pick` });
  id.openMulti = await item(open.id, "open multi", { [key.multi]: ["south", `north-${M}-multi`] });
  // A value under the sec-only field, on an item in EACH project.
  id.openHush = await item(open.id, "open hushed", { [key.secret]: `${M}-hush` });
  id.secHush = await item(sec.id, "sec hushed", { [key.secret]: `${M}-hush` });
  // A near miss: the same field, another value.
  id.openOther = await item(open.id, "open other", { [key.text]: "globex" });

  // One item found by its title and one by a label, for the same text.
  id.budTitle = await item(open.id, `titled ${M}-bud`);
  id.budLabel = await item(open.id, "budget labelled");
  // Labels whose names hold a short needle, a `*` mid-text, and LIKE's `%`.
  id.shortLabel = await item(open.id, "short labelled");
  id.starLabel = await item(open.id, "star labelled");
  for (const [workItemId, name] of [
    [id.budLabel, `Budget-${M}-bud`],
    [id.shortLabel, `Short #@! ${M}`],
    [id.starLabel, `Tier*1-${M}`],
  ] as const) {
    const l = await prisma.label.create({ data: { orgId, name } });
    await prisma.workItemLabel.create({ data: { orgId, workItemId, labelId: l.id } });
  }
});

afterAll(async () => {
  await prisma.workItemLabel.deleteMany({ where: { orgId } });
  await prisma.label.deleteMany({ where: { orgId } });
  await prisma.customField.deleteMany({ where: { orgId } });
  await prisma.workItem.deleteMany({ where: { orgId } });
  await prisma.projectMember.deleteMany({ where: { project: { orgId } } });
  await prisma.workflowStatus.deleteMany({ where: { project: { orgId } } }).catch(() => {});
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } });
});

describe("⌘K matches a work item's labels", () => {
  it("finds both labelled items for someone on the team (positive control)", async () => {
    const hits = await search(session("insider"), `${M}-lbl`);
    expect(ids(hits)).toEqual([id.openLabel, id.secLabel].sort());
    // The palette says why an item matched when its title doesn't.
    expect(hits.find((x) => x.id === id.openLabel)?.description).toBe(`Label: Security-${M}-lbl`);
  });

  it("matches a label case-insensitively and in part", async () => {
    expect(ids(await search(session("outsider"), `SECURITY-${M.toUpperCase()}`))).toEqual([id.openLabel]);
  });

  it("never shows a team-scoped project's item to someone off the team", async () => {
    expect(ids(await search(session("outsider"), `${M}-lbl`))).toEqual([id.openLabel]);
  });

  it("holds an API key to its project scope", async () => {
    const keyed = session("insider", { isApiKey: true, projectScope: [id.open] });
    expect(ids(await search(keyed, `${M}-lbl`))).toEqual([id.openLabel]);
  });

  it("gives a role without item reads no attribute matches", async () => {
    expect(await search(session("billing"), `${M}-lbl`)).toEqual([]);
  });
});

describe("⌘K matches a work item's custom-field values", () => {
  it("finds a free-text value in part and in any case, in each project the caller can read", async () => {
    const hits = await search(session("insider"), `${M}-cust`);
    expect(ids(hits)).toEqual([id.openText, id.secText].sort());
    expect(hits.find((x) => x.id === id.secText)?.description).toBe(`Customer: acme ${M}-cust corp`);
  });

  it("never shows a team-scoped project's value to someone off the team", async () => {
    expect(ids(await search(session("outsider"), `${M}-cust`))).toEqual([id.openText]);
  });

  it("finds a single-choice and a multiple-choice value by part of the option", async () => {
    const pick = await search(session("outsider"), `${M}-pick`);
    expect(ids(pick)).toEqual([id.openPick]);
    expect(pick[0].description).toBe(`Tier: gold-${M}-pick`);
    const multi = await search(session("outsider"), `${M}-multi`);
    expect(ids(multi)).toEqual([id.openMulti]);
    expect(multi[0].description).toBe(`Areas: north-${M}-multi`);
  });

  it("searches a field defined on a team-scoped project only for people who can see that project", async () => {
    // Positive control: the insider sees the field, so both values match.
    expect(ids(await search(session("insider"), `${M}-hush`))).toEqual([id.openHush, id.secHush].sort());
    // Off the team, the field itself is out of reach, so neither does.
    expect(await search(session("outsider"), `${M}-hush`)).toEqual([]);
  });

  it("does not match an item whose value differs (negative control)", async () => {
    const hits = await search(session("insider"), `${M}-cust`);
    expect(hits.some((x) => x.id === id.openOther)).toBe(false);
  });
});

describe("what the attribute branch costs, and when it runs", () => {
  it("runs under its time budget, and a query that outlasts it still returns the title matches", async () => {
    h.budgets = [];
    // Control: within budget, the title match and the label match.
    expect(ids(await search(session("outsider"), `${M}-bud`))).toEqual([id.budTitle, id.budLabel].sort());
    expect(h.budgets.length).toBeGreaterThan(0);
    expect(h.budgets.every((ms) => ms === ATTRIBUTE_BUDGET_MS)).toBe(true);
    // Past it, Postgres cancels the query and the search answers with names only.
    h.slow = true;
    try {
      expect(ids(await search(session("outsider"), `${M}-bud`))).toEqual([id.budTitle]);
    } finally {
      h.slow = false;
    }
  }, 15_000);

  it("keeps every match when saying why one matched fails", async () => {
    h.failDescribe = true;
    try {
      const hits = await search(session("outsider"), `${M}-bud`);
      expect(ids(hits)).toEqual([id.budTitle, id.budLabel].sort());
      expect(hits.find((x) => x.id === id.budLabel)?.description).toBeUndefined();
    } finally {
      h.failDescribe = false;
    }
  });

  it("matches labels and fields only from three characters", async () => {
    expect(await search(session("outsider"), "#@")).toEqual([]);
    // Control: one more character, and the label matches.
    expect(ids(await search(session("outsider"), "#@!"))).toEqual([id.shortLabel]);
  });

  it("matches titles only in an org that has switched CQL off", async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { settings: withCqlEnabled({}, false) as Prisma.InputJsonObject } });
    try {
      expect(await search(session("insider"), `${M}-lbl`)).toEqual([]);
      expect(ids(await search(session("insider"), `${M}-bud`))).toEqual([id.budTitle]);
    } finally {
      await prisma.organization.update({ where: { id: orgId }, data: { settings: {} } });
    }
    // Control: switched back on, the label matches again.
    expect(ids(await search(session("insider"), `${M}-lbl`))).toEqual([id.openLabel, id.secLabel].sort());
  });

  it("still matches labels for text with a `*` before its end, which a free-text field can't take", async () => {
    expect(ids(await search(session("outsider"), `r*1-${M}`))).toEqual([id.starLabel]);
  });

  it("reads `%` in the text as itself when choosing labels, not as a wildcard", async () => {
    // At the matcher: ⌘K's title match is a separate query, and this is the label side.
    const matches = async (q: string) => {
      const m = await itemAttributeMatch(session("outsider"), q);
      return m ? (await prisma.workItem.findMany({ where: m.where, select: { id: true } })).map((r) => r.id).sort() : [];
    };
    expect(await matches("%%%")).toEqual([]);
    // Control: ordinary text does choose a label.
    expect(await matches(`${M}-lbl`)).toEqual([id.openLabel]);
  });
});

describe("the @-mention typeahead", () => {
  it("still names items by title and number only", async () => {
    h.ctx = session("insider");
    const res = await mentionSearch(req(`/mentions/search?q=${M}-lbl&types=workItem`), at());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    // Control: the same route does find these items by title.
    const byTitle = await mentionSearch(req(`/mentions/search?q=${encodeURIComponent(`open labelled ${stamp}`)}&types=workItem`), at());
    expect(((await byTitle.json()) as Array<{ id: string }>).map((x) => x.id)).toEqual([id.openLabel]);
  });
});
