// @vitest-environment node
//
// The rule table behind `assertRefsInScope`, one kind at a time, against a
// real database: the caller's own row passes, another org's row is refused,
// and for a row that lives in a project, another project's row is refused
// when the write names a project (and passes when it names none). `MAKE` is
// typed over every kind, so a kind added to the table without a factory here
// does not type-check.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { ProblemError } from "@/lib/openapi/problem";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { REF_KINDS, assertRefsInScope, foreignRef, refsError, withoutForeign, type RefKind } from "./foreign-refs";

const stamp = Math.random().toString(36).slice(2, 8);
const K = stamp.slice(0, 3).toUpperCase();
let orgA = "", orgB = "", user = "", p1 = "", p2 = "", hidden = "", pB = "", typeId = "";

beforeAll(async () => {
  user = (await prisma.user.create({ data: { email: `u-${stamp}@refs.test`, displayName: "U" } })).id;
  orgA = (await prisma.organization.create({ data: { name: `refs a ${stamp}`, slug: `refs-a-${stamp}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `refs b ${stamp}`, slug: `refs-b-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId: orgA, userId: user, role: "MEMBER", permissions: "0" } });
  p1 = (await prisma.project.create({ data: { orgId: orgA, name: "P1", key: `RA${K}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId: orgA, name: "P2", key: `RB${K}` } })).id;
  hidden = (await prisma.project.create({ data: { orgId: orgA, name: "Hidden", key: `RC${K}`, teamScopedAccess: true } })).id;
  pB = (await prisma.project.create({ data: { orgId: orgB, name: "PB", key: `RD${K}` } })).id;
  for (const p of [p1, p2, hidden, pB]) await ensureFixtureStatuses(p);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.workItem.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.workItemType.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [user, ...people] } } }).catch(() => undefined);
});

let n = 0;
const next = () => `${stamp}-${++n}`;
/** Users made for the `member` kind, removed after. */
const people: string[] = [];
const person = async (orgId: string, removedAt: Date | null = null) => {
  const id = (await prisma.user.create({ data: { email: `p-${next()}@refs.test`, displayName: "P" } })).id;
  people.push(id);
  await prisma.orgMember.create({ data: { orgId, userId: id, role: "MEMBER", permissions: "0", removedAt } });
  return { id };
};

/** One row of each kind, in `orgId` and (for project-owned kinds) `projectId`. */
const MAKE: Record<RefKind, (orgId: string, projectId: string) => Promise<{ id: string }>> = {
  partner: (orgId) => prisma.partner.create({ data: { orgId, name: next() } }),
  product: (orgId) => prisma.product.create({ data: { orgId, name: next() } }),
  client: (orgId) => prisma.client.create({ data: { orgId, name: next() } }),
  label: (orgId) => prisma.label.create({ data: { orgId, name: next() } }),
  project: (orgId) => prisma.project.create({ data: { orgId, name: next(), key: `R${K}${n}` } }),
  contract: (orgId, projectId) => prisma.contract.create({ data: { orgId, projectId, title: next() } }),
  invoice: (orgId) => prisma.invoice.create({ data: { orgId, number: next(), billToName: "B", createdById: user } }),
  projectTemplate: (orgId) => prisma.projectTemplate.create({ data: { orgId, slug: next(), sector: "general", name: "PT" } }),
  workItemType: (orgId) => prisma.workItemType.create({ data: { orgId, key: `refs.${next()}`, name: "T" } }),
  workItem: (orgId, projectId) =>
    createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: user, title: next(), columnKey: "todo" }),
  interval: (orgId, projectId) =>
    prisma.interval.create({ data: { orgId, projectId, number: ++n, name: "S", startDate: new Date("2026-11-02"), endDate: new Date("2026-11-13") } }),
  team: (orgId, projectId) => prisma.team.create({ data: { orgId, projectId, name: next() } }),
  milestone: (orgId, projectId) => prisma.milestone.create({ data: { orgId, projectId, title: next(), dueDate: new Date("2026-12-01") } }),
  objective: (orgId, projectId) => prisma.objective.create({ data: { orgId, projectId, title: next() } }),
  clin: (orgId, projectId) => prisma.clin.create({ data: { orgId, projectId, code: next(), title: "C" } }),
  deliverable: (orgId, projectId) => prisma.deliverable.create({ data: { orgId, projectId, code: next(), title: "D" } }),
  goal: (orgId, projectId) => prisma.goal.create({ data: { orgId, projectId, title: next() } }),
  kpi: (orgId, projectId) => prisma.kpi.create({ data: { orgId, projectId, name: next() } }),
  board: (orgId, projectId) => prisma.board.create({ data: { orgId, projectId, name: next(), type: "KANBAN" } }),
  member: (orgId) => person(orgId),
};

/** Kinds that don't live in a project, so another project of the org is fine. */
const ORG_LEVEL: ReadonlySet<RefKind> = new Set(["partner", "product", "client", "label", "project", "invoice", "projectTemplate", "workItemType", "member"]);

describe.each(REF_KINDS)("%s", (kind) => {
  it("passes the org's own row, and refuses another org's", async () => {
    const mine = await MAKE[kind](orgA, p1);
    const theirs = await MAKE[kind](orgB, pB);
    expect(await foreignRef(prisma, { orgId: orgA, projectId: p1 }, { [kind]: mine.id })).toBeNull();
    expect(await foreignRef(prisma, { orgId: orgA, projectId: p1 }, { [kind]: theirs.id })).toBe(kind);
    // A list fails if any one of it is foreign.
    expect(await foreignRef(prisma, { orgId: orgA }, { [kind]: [mine.id, theirs.id] })).toBe(kind);
  });

  it(ORG_LEVEL.has(kind) ? "is not bound to a project" : "is bound to the project the write names", async () => {
    const elsewhere = await MAKE[kind](orgA, p2);
    const named = await foreignRef(prisma, { orgId: orgA, projectId: p1 }, { [kind]: elsewhere.id });
    expect(named).toBe(ORG_LEVEL.has(kind) ? null : kind);
    // With no project named, the org is the bound.
    expect(await foreignRef(prisma, { orgId: orgA }, { [kind]: elsewhere.id })).toBeNull();
  });
});

describe("the helper's other forms", () => {
  it("a missing id gets the same answer as another org's", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(await refsError({ orgId: orgA }, { partner: missing })).toBe("That partner doesn't exist in this organization.");
    const theirs = await MAKE.partner(orgB, pB);
    expect(await refsError({ orgId: orgA }, { partner: theirs.id })).toBe("That partner doesn't exist in this organization.");
  });

  it("unset and cleared references pass", async () => {
    expect(await foreignRef(prisma, { orgId: orgA, projectId: p1 }, { partner: null, workItem: undefined, label: [] })).toBeNull();
  });

  it("assertRefsInScope throws a 400 naming the project for a project-owned row", async () => {
    const other = await MAKE.interval(orgA, p2);
    const err = await assertRefsInScope({ orgId: orgA, projectId: p1 }, { interval: other.id }).catch((e) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect([err.status, err.message]).toEqual([400, "That interval isn't part of this project."]);
  });

  it("with a viewer and no project, a row in a project the viewer can't see is refused", async () => {
    const viewer: AuthContext = { userId: user, orgId: orgA, orgRole: "MEMBER", permissions: 0n, basePermissions: 0n, abacRules: [] };
    const inHidden = await MAKE.milestone(orgA, hidden);
    const inOpen = await MAKE.milestone(orgA, p2);
    expect(await foreignRef(prisma, { orgId: orgA, viewer }, { milestone: inHidden.id })).toBe("milestone");
    expect(await foreignRef(prisma, { orgId: orgA, viewer }, { milestone: inOpen.id })).toBeNull();
    expect(await foreignRef(prisma, { orgId: orgA, viewer }, { project: hidden })).toBe("project");
    expect(await foreignRef(prisma, { orgId: orgA, viewer }, { project: p2 })).toBeNull();
    // A key's project ceiling binds the same way.
    const key = { ...viewer, isApiKey: true, projectScope: [p1] };
    expect(await foreignRef(prisma, { orgId: orgA, viewer: key }, { milestone: inOpen.id })).toBe("milestone");
  });

  it("a built-in project template is not the org's own", async () => {
    const builtIn = await prisma.projectTemplate.create({ data: { orgId: null, isBuiltIn: true, slug: next(), sector: "general", name: "Built-in" } });
    try {
      expect(await foreignRef(prisma, { orgId: orgA }, { projectTemplate: builtIn.id })).toBe("projectTemplate");
    } finally {
      await prisma.projectTemplate.delete({ where: { id: builtIn.id } });
    }
  });

  it("a person is a CURRENT member: one the org removed is refused, with its own message", async () => {
    const former = await person(orgA, new Date());
    expect(await refsError({ orgId: orgA }, { member: former.id })).toBe("That person isn't a member of this organization.");
    const current = await person(orgA);
    expect(await refsError({ orgId: orgA }, { member: current.id })).toBeNull();
    // Even through the client that does not filter removed members by default.
    expect(await foreignRef(prismaUnfiltered, { orgId: orgA }, { member: former.id })).toBe("member");
    expect(await foreignRef(prismaUnfiltered, { orgId: orgA }, { member: current.id })).toBeNull();
  });

  it("withoutForeign drops a to-one relation from another org, and keeps the org's own", () => {
    const row = { id: "c", partner: { id: "p", orgId: orgB }, product: { id: "q", orgId: orgA } };
    expect(withoutForeign(row, orgA, ["partner", "product"])).toEqual({ ...row, partner: null });
    expect(withoutForeign(row, orgB, ["partner"])).toBe(row);
  });
});
