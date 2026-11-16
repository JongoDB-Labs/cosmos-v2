// @vitest-environment node
//
// `channelProjectReaders` picks who a message in a project's channel may
// notify. It answers for every recipient at once, so it must give exactly the
// answer `isProjectVisible` gives for each of them, judged from their own
// stored access, and in a fixed number of queries however many there are.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { channelProjectReaders } from "./access";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", otherOrgId = "";
const project = { scoped: "", open: "", otherOrg: "", missing: randomUUID() };

// owner, admin: org administrators outside the project. onTeam: a MEMBER on
// it. offTeam: a MEMBER not on it. guestOnTeam: a GUEST on it (the most
// restricted role). viewer, billing: a VIEWER and a BILLING_ADMIN not on it.
// noGrants: a MEMBER on it with no stored permissions. removed: on it, but
// removed from the org. stranger: never in the org.
type Person = { role: "OWNER" | "ADMIN" | "BILLING_ADMIN" | "MEMBER" | "VIEWER" | "GUEST" | null; onTeam: boolean; removed?: boolean };
const PEOPLE: Record<string, Person> = {
  owner: { role: "OWNER", onTeam: false },
  admin: { role: "ADMIN", onTeam: false },
  onTeam: { role: "MEMBER", onTeam: true },
  offTeam: { role: "MEMBER", onTeam: false },
  guestOnTeam: { role: "GUEST", onTeam: true },
  viewer: { role: "VIEWER", onTeam: false },
  billing: { role: "BILLING_ADMIN", onTeam: false },
  noGrants: { role: "MEMBER", onTeam: true },
  removed: { role: "MEMBER", onTeam: true, removed: true },
  stranger: { role: null, onTeam: false },
};
const ids: Record<string, string> = {};
const everyone = () => Object.values(ids);
const named = (set: Set<string>) => Object.keys(ids).filter((k) => set.has(ids[k])).sort();

/** The per-person rule, one person at a time: what a recipient's own session would be told. */
async function oneByOne(projectId: string | null): Promise<Set<string>> {
  const out = new Set<string>();
  for (const userId of everyone()) {
    const ctx = await loadMemberAuthContext(orgId, userId);
    if (ctx && (!projectId || (await isProjectVisible(ctx, projectId)))) out.add(userId);
  }
  return out;
}

/** Database calls made while `fn` runs, on the models the rule reads. */
async function queriesDuring(fn: () => Promise<unknown>): Promise<number> {
  const db = prisma as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;
  const spies = [];
  for (const model of ["orgMember", "projectMember", "project", "orgMemberWorkRole", "organization", "user"]) {
    for (const method of ["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count"]) {
      if (typeof db[model]?.[method] === "function") spies.push(vi.spyOn(db[model], method));
    }
  }
  try {
    await fn();
    return spies.reduce((n, s) => n + s.mock.calls.length, 0);
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `cpr ${stamp}`, slug: `cpr-${stamp}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `cpr2 ${stamp}`, slug: `cpr2-${stamp}` } })).id;
  project.scoped = (await prisma.project.create({ data: { orgId, name: "Scoped", key: `C${stamp}`.toUpperCase().slice(0, 8), teamScopedAccess: true } })).id;
  project.open = (await prisma.project.create({ data: { orgId, name: "Open", key: `D${stamp}`.toUpperCase().slice(0, 8) } })).id;
  project.otherOrg = (await prisma.project.create({ data: { orgId: otherOrgId, name: "Theirs", key: `E${stamp}`.toUpperCase().slice(0, 8) } })).id;
  for (const [k, p] of Object.entries(PEOPLE)) {
    ids[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@cpr.test`, displayName: k } })).id;
    if (!p.role) continue;
    const om = await prisma.orgMember.create({
      data: { orgId, userId: ids[k], role: p.role, permissions: k === "noGrants" ? "0" : undefined, removedAt: p.removed ? new Date() : null },
    });
    if (p.onTeam) {
      await prisma.projectMember.create({ data: { projectId: project.scoped, orgMemberId: om.id } });
      await prisma.projectMember.create({ data: { projectId: project.otherOrg, orgMemberId: om.id } });
    }
  }
});

afterAll(async () => {
  await prismaUnfiltered.projectMember.deleteMany({ where: { projectId: { in: [project.scoped, project.open, project.otherOrg] } } });
  await prisma.project.deleteMany({ where: { id: { in: [project.scoped, project.open, project.otherOrg] } } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { id: { in: everyone() } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
});

describe("who may read a project's channel", () => {
  it("is, for a team-scoped project, its team and the org's owners and admins", async () => {
    expect(named(await channelProjectReaders(orgId, project.scoped, everyone()))).toEqual(
      ["admin", "guestOnTeam", "noGrants", "onTeam", "owner"],
    );
  });

  it("is, for a project open to the org, every current member", async () => {
    expect(named(await channelProjectReaders(orgId, project.open, everyone()))).toEqual(
      ["admin", "billing", "guestOnTeam", "noGrants", "offTeam", "onTeam", "owner", "viewer"],
    );
  });

  it("is no one for a project that no longer exists, or that belongs to another org", async () => {
    expect(named(await channelProjectReaders(orgId, project.missing, everyone()))).toEqual([]);
    expect(named(await channelProjectReaders(orgId, project.otherOrg, everyone()))).toEqual([]);
  });

  it.each(["scoped", "open", "missing", "otherOrg"] as const)(
    "matches isProjectVisible person by person, for the %s project",
    async (which) => {
      expect(named(await channelProjectReaders(orgId, project[which], everyone()))).toEqual(named(await oneByOne(project[which])));
    },
  );

  it("is everyone asked about, for a channel under no project", async () => {
    expect(named(await channelProjectReaders(orgId, null, everyone()))).toEqual(Object.keys(ids).sort());
  });

  it("takes the same few queries for two people as for ten", async () => {
    const two = await queriesDuring(() => channelProjectReaders(orgId, project.scoped, [ids.onTeam, ids.offTeam]));
    const ten = await queriesDuring(() => channelProjectReaders(orgId, project.scoped, everyone()));
    // The counter sees the rule's queries at all (else both are 0 and equal).
    expect(two).toBeGreaterThan(0);
    expect(ten).toBe(two);
    expect(ten).toBeLessThanOrEqual(3);
    // And the per-person rule, for scale, makes several per person.
    expect(await queriesDuring(() => oneByOne(project.scoped))).toBeGreaterThan(ten * 5);
  });
});
