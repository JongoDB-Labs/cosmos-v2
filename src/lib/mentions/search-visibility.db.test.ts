// @vitest-environment node
//
// Global search (⌘K), the @-mention typeahead and the token resolver filtered
// every type but projects and notes by org alone. Anyone signed in found the
// titles of work items, boards, registers and documents in team-scoped
// projects they are not on, restricted files they were never shared, and the
// meetings, contacts and notes of modules their role cannot open. "Mentioned
// in" named private channels and DMs. Driven through the real routes.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";
import { scopeMask } from "@/lib/auth/api-key";
import { resolveRefs, searchEntities } from "./registry.server";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as globalSearch } from "@/app/api/v1/orgs/[orgId]/search/route";
import { GET as mentionSearch } from "@/app/api/v1/orgs/[orgId]/mentions/search/route";
import { POST as resolveTokens } from "@/app/api/v1/orgs/[orgId]/mentions/resolve/route";
import { GET as backlinks } from "@/app/api/v1/orgs/[orgId]/mentions/backlinks/route";

type Role = "MEMBER" | "VIEWER" | "BILLING_ADMIN" | "ADMIN";
const stamp = Math.random().toString(36).slice(2, 8);
const M = `zq${stamp}`;
let orgId = "";
const u = { insider: "", outsider: "", billing: "", viewer: "" };
const roles: Record<keyof typeof u, Role> = { insider: "MEMBER", outsider: "MEMBER", billing: "BILLING_ADMIN", viewer: "VIEWER" };
const id: Record<string, string> = {};

function session(who: keyof typeof u): AuthContext {
  const permissions = RolePermissions[roles[who]];
  return { userId: u[who], orgId, orgRole: roles[who], abacRules: [], basePermissions: permissions, permissions };
}
const req = (path: string, init?: { method: string; body: unknown }) =>
  new NextRequest(`http://localhost/api/v1/orgs/${orgId}${path}`, init && { method: init.method, body: JSON.stringify(init.body), headers: { "Content-Type": "application/json" } });
const at = () => ({ params: Promise.resolve({ orgId }) });

async function search(who: keyof typeof u): Promise<string[]> {
  h.ctx = session(who);
  const res = await globalSearch(req(`/search?q=${M}`), at());
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ name: string }>).map((r) => r.name);
}
async function mentions(who: keyof typeof u): Promise<string[]> {
  h.ctx = session(who);
  const res = await mentionSearch(req(`/mentions/search?q=${M}&perType=15`), at());
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ label: string }>).map((r) => r.label);
}
async function resolve(who: keyof typeof u, refs: Array<{ type: string; id: string }>): Promise<string[]> {
  h.ctx = session(who);
  const res = await resolveTokens(req(`/mentions/resolve`, { method: "POST", body: { refs } }), at());
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
}
async function mentionedIn(who: keyof typeof u): Promise<string[]> {
  h.ctx = session(who);
  const res = await backlinks(req(`/mentions/backlinks?type=workItem&id=${id.openItem}`), at());
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ sourceId: string; label: string }>).map((r) => `${r.sourceId} ${r.label}`);
}

const SEC_TITLES = ["sec item", "sec board", "sec risk", "sec doc", "sec meeting", "Sec project"];
const MODULE_TITLES = ["open item", "open meeting", "contact", "note"];

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `srv ${stamp}`, slug: `srv-${stamp}` } })).id;
  const om: Record<string, string> = {};
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@srv.test`, displayName: `${k} ${stamp}` } })).id;
    om[k] = (await prisma.orgMember.create({ data: { orgId, userId: u[k], role: roles[k], permissions: "0" } })).id;
  }
  const open = await prisma.project.create({ data: { orgId, name: `${M} Open project`, key: `O${stamp}`.toUpperCase().slice(0, 7) } });
  const sec = await prisma.project.create({ data: { orgId, name: `${M} Sec project`, key: `S${stamp}`.toUpperCase().slice(0, 7), teamScopedAccess: true } });
  await prisma.projectMember.create({ data: { projectId: sec.id, orgMemberId: om.insider } });
  id.open = open.id;
  id.sec = sec.id;

  const typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
  const item = (projectId: string, title: string) =>
    createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: u.insider, title, columnKey: "todo" });
  id.openItem = (await item(open.id, `${M} open item`)).id;
  id.secItem = (await item(sec.id, `${M} sec item`)).id;
  id.secBoard = (await prisma.board.create({ data: { orgId, projectId: sec.id, name: `${M} sec board`, type: "KANBAN", sortOrder: 0 } })).id;
  id.secRisk = (await prisma.risk.create({ data: { orgId, projectId: sec.id, code: "R-1", title: `${M} sec risk` } })).id;
  const doc = (projectId: string | null, title: string, visibility: "INHERIT" | "RESTRICTED") =>
    prisma.document.create({
      data: { orgId, projectId, title, storageKey: `k/${stamp}/${title}`, filename: "a.pdf", contentType: "application/pdf", size: 1, uploadedById: u.insider, visibility },
    });
  id.secDoc = (await doc(sec.id, `${M} sec doc`, "INHERIT")).id;
  id.secretDoc = (await doc(open.id, `${M} secret file`, "RESTRICTED")).id;
  const meeting = (projectId: string | null, title: string) =>
    prisma.syncMeeting.create({ data: { orgId, projectId, title, meetingDate: new Date("2026-01-05"), durationMinutes: 30, createdById: u.insider, notes: "" } });
  id.secMeeting = (await meeting(sec.id, `${M} sec meeting`)).id;
  id.openMeeting = (await meeting(null, `${M} open meeting`)).id;
  await prisma.crmContact.create({ data: { orgId, name: `${M} contact` } });
  await prisma.note.create({ data: { orgId, authorId: u.insider, title: `${M} note`, visibility: "ORG" } });

  // "Mentioned in": the open item is mentioned in a public channel, a private
  // channel only the insider is in, and a DM.
  const channel = async (name: string | null, kind: "CHANNEL" | "DM", isPrivate: boolean) => {
    const ch = await prisma.chatChannel.create({ data: { orgId, kind, name, slug: name && `${name}-${stamp}`, isPrivate, createdById: u.insider, dmKey: kind === "DM" ? `dm-${stamp}` : null } });
    await prisma.chatChannelMember.create({ data: { channelId: ch.id, userId: u.insider } });
    const msg = await prisma.chatMessage.create({ data: { channelId: ch.id, authorId: u.insider, content: `see ${M}` } });
    await prisma.reference.create({ data: { orgId, sourceType: "chatMessage", sourceId: msg.id, targetType: "workItem", targetId: id.openItem } });
    return msg.id;
  };
  id.publicMsg = await channel(`lobby${stamp}`, "CHANNEL", false);
  id.privateMsg = await channel(`hush${stamp}`, "CHANNEL", true);
  id.dmMsg = await channel(null, "DM", false);
});

afterAll(async () => {
  await prisma.reference.deleteMany({ where: { orgId } });
  const channels = await prisma.chatChannel.findMany({ where: { orgId }, select: { id: true } });
  await prisma.chatMessage.deleteMany({ where: { channelId: { in: channels.map((c) => c.id) } } });
  await prisma.chatChannelMember.deleteMany({ where: { channelId: { in: channels.map((c) => c.id) } } });
  await prisma.chatChannel.deleteMany({ where: { orgId } });
  await prisma.note.deleteMany({ where: { orgId } });
  await prisma.crmContact.deleteMany({ where: { orgId } });
  await prisma.syncMeeting.deleteMany({ where: { orgId } });
  await prisma.document.deleteMany({ where: { orgId } });
  await prisma.risk.deleteMany({ where: { orgId } });
  await prisma.board.deleteMany({ where: { orgId } });
  await prisma.workItem.deleteMany({ where: { orgId } });
  await prisma.projectMember.deleteMany({ where: { project: { orgId } } });
  await prisma.workflowStatus.deleteMany({ where: { project: { orgId } } }).catch(() => {});
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } });
});

const hits = (names: string[], title: string) => names.filter((n) => n.includes(title));

describe("global search", () => {
  it("finds a team-scoped project's records for someone on the team (positive control)", async () => {
    const names = await search("insider");
    for (const t of [...SEC_TITLES, ...MODULE_TITLES, "secret file"]) expect(hits(names, t), t).not.toEqual([]);
  });

  it("finds nothing of a team-scoped project for someone off the team", async () => {
    const names = await search("outsider");
    for (const t of SEC_TITLES) expect(hits(names, t), t).toEqual([]);
    for (const t of MODULE_TITLES) expect(hits(names, t), t).not.toEqual([]);
  });

  it("does not show a restricted file to someone it was not shared with", async () => {
    expect(hits(await search("outsider"), "secret file")).toEqual([]);
  });

  it("shows a role only the modules it can open", async () => {
    // BILLING_ADMIN reads projects, not items, meetings, contacts or notes.
    const names = await search("billing");
    expect(hits(names, "Open project")).not.toEqual([]);
    for (const t of MODULE_TITLES) expect(hits(names, t), t).toEqual([]);
  });

  it("applies the same rules to the @-mention typeahead", async () => {
    const labels = await mentions("outsider");
    for (const t of SEC_TITLES) expect(hits(labels, t), t).toEqual([]);
    expect(hits(labels, "open item")).not.toEqual([]);
  });
});

describe("mention tokens", () => {
  it("resolve only for someone who may see what they name", async () => {
    const refs = [
      { type: "workItem", id: id.secItem },
      { type: "board", id: id.secBoard },
      { type: "risk", id: id.secRisk },
      { type: "document", id: id.secDoc },
      { type: "document", id: id.secretDoc },
      { type: "meeting", id: id.secMeeting },
    ];
    expect((await resolve("insider", refs)).sort()).toEqual(refs.map((r) => r.id).sort());
    expect(await resolve("outsider", refs)).toEqual([]);
    expect(await resolve("billing", [{ type: "meeting", id: id.openMeeting }])).toEqual([]);
  });
});

describe("mentioned in", () => {
  it("lists a chat source only where the reader may read that channel", async () => {
    const insider = await mentionedIn("insider");
    expect(insider.some((l) => l.startsWith(id.privateMsg))).toBe(true);

    const outsider = await mentionedIn("outsider");
    expect(outsider.some((l) => l.startsWith(id.publicMsg))).toBe(true);
    expect(outsider.some((l) => l.startsWith(id.privateMsg) || l.includes(`hush${stamp}`))).toBe(false);
    expect(outsider.some((l) => l.startsWith(id.dmMsg))).toBe(false);
  });

  it("lists no chat source to a role without chat", async () => {
    expect(await mentionedIn("viewer")).toEqual([]);
  });
});

describe("every project-bound type in search", () => {
  // Its own marker, so these rows don't crowd the cases above.
  const M2 = `zr${stamp}`;
  const MODELS = ["milestone", "objective", "goal", "kpi", "deliverable", "blocker", "changeRequest", "clin"] as const;
  /** One row of the type in the given project, titled `${M2} <tag> <type>`. */
  const make: Record<string, (projectId: string, tag: string) => Promise<unknown>> = {
    item: async (projectId, tag) => {
      const typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
      return createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: u.insider, title: `${M2} ${tag} item`, columnKey: "todo" });
    },
    meeting: (projectId, tag) =>
      prisma.syncMeeting.create({ data: { orgId, projectId, title: `${M2} ${tag} meeting`, meetingDate: new Date("2026-01-05"), durationMinutes: 30, createdById: u.insider, notes: "" } }),
    board: (projectId, tag) => prisma.board.create({ data: { orgId, projectId, name: `${M2} ${tag} board`, type: "KANBAN", sortOrder: 0 } }),
    milestone: (projectId, tag) => prisma.milestone.create({ data: { orgId, projectId, title: `${M2} ${tag} milestone`, dueDate: new Date("2026-03-01") } }),
    objective: (projectId, tag) => prisma.objective.create({ data: { orgId, projectId, title: `${M2} ${tag} objective` } }),
    goal: (projectId, tag) => prisma.goal.create({ data: { orgId, projectId, title: `${M2} ${tag} goal` } }),
    kpi: (projectId, tag) => prisma.kpi.create({ data: { orgId, projectId, name: `${M2} ${tag} kpi` } }),
    risk: (projectId, tag) => prisma.risk.create({ data: { orgId, projectId, code: `R-${M2}-${tag}`, title: `${M2} ${tag} risk` } }),
    deliverable: (projectId, tag) => prisma.deliverable.create({ data: { orgId, projectId, code: `D-${tag}`, title: `${M2} ${tag} deliverable` } }),
    blocker: (projectId, tag) => prisma.blocker.create({ data: { orgId, projectId, code: `B-${tag}`, title: `${M2} ${tag} blocker` } }),
    changeRequest: (projectId, tag) => prisma.changeRequest.create({ data: { orgId, projectId, code: `C-${tag}`, title: `${M2} ${tag} changeRequest` } }),
    clin: (projectId, tag) => prisma.clin.create({ data: { orgId, projectId, code: `L-${tag}`, title: `${M2} ${tag} clin` } }),
    document: (projectId, tag) =>
      prisma.document.create({
        data: { orgId, projectId, title: `${M2} ${tag} document`, storageKey: `k/${stamp}/${M2}-${tag}`, filename: "a.pdf", contentType: "application/pdf", size: 1, uploadedById: u.insider, visibility: "INHERIT" },
      }),
  };

  beforeAll(async () => {
    for (const create of Object.values(make)) {
      await create(id.open, "open");
      await create(id.sec, "sec");
    }
  });

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one delete per model by name
    for (const m of MODELS) await (prisma as any)[m].deleteMany({ where: { orgId } });
  });

  const names = async (who: keyof typeof u) => {
    h.ctx = session(who);
    const res = await globalSearch(req(`/search?q=${M2}`), at());
    expect(res.status).toBe(200);
    return ((await res.json()) as Array<{ name: string }>).map((r) => r.name.toLowerCase());
  };

  it("covers every type the registry bounds by project", () => {
    expect(Object.keys(make)).toHaveLength(13);
  });

  it.each(Object.keys(make))("%s: found off a team-scoped project only by someone on its team", async (type) => {
    const t = type.toLowerCase();
    const [insider, outsider] = [await names("insider"), await names("outsider")];
    expect(hits(insider, `sec ${t}`), "insider, sec").not.toEqual([]);
    expect(hits(outsider, `open ${t}`), "outsider, open").not.toEqual([]);
    expect(hits(outsider, `sec ${t}`), "outsider, sec").toEqual([]);
  });
});

describe("people in search, for a project-scoped key", () => {
  // People need ORG_READ, which no key scope grants today, so a real key finds
  // nobody. The roster ceiling is what holds if one ever does: these keys keep
  // the member's own bits to reach it. The insider created every item in the
  // open project, so they are in a key scoped to it; the other three are not.
  const scopedKey = (scopes: string[]): AuthContext => {
    const s = session("insider");
    return { ...s, isApiKey: true, scopes, projectScope: [id.open] };
  };

  it("finds nobody with a real key's grant (no scope grants ORG_READ)", async () => {
    const s = session("insider");
    const mask = scopeMask(["read", "members:read"]);
    const real: AuthContext = { ...s, isApiKey: true, scopes: ["read", "members:read"], projectScope: [id.open], permissions: s.permissions & mask, basePermissions: s.basePermissions & mask };
    expect(await searchEntities({ ctx: real, orgSlug: `srv-${stamp}`, query: stamp, types: ["user"] })).toEqual([]);
  });
  const people = (hits: Array<{ type: string; id: string }>) => hits.filter((x) => x.type === "user").map((x) => x.id).sort();

  it("finds and resolves only the people inside the key's roster", async () => {
    const everyone = Object.values(u).sort();
    const asSession = await searchEntities({ ctx: session("insider"), orgSlug: `srv-${stamp}`, query: stamp, types: ["user"], perType: 15 });
    expect(people(asSession)).toEqual(everyone);

    const key = scopedKey(["read", "members:read"]);
    expect(people(await searchEntities({ ctx: key, orgSlug: `srv-${stamp}`, query: stamp, types: ["user"], perType: 15 }))).toEqual([u.insider]);
    const refs = everyone.map((userId) => ({ type: "user" as const, id: userId }));
    expect(people(await resolveRefs({ ctx: key, orgSlug: `srv-${stamp}`, refs }))).toEqual([u.insider]);
  });

  it("shows their emails only with members:read", async () => {
    const withEmails = await searchEntities({ ctx: scopedKey(["read", "members:read"]), orgSlug: `srv-${stamp}`, query: stamp, types: ["user"] });
    expect(JSON.stringify(withEmails)).toContain(`insider-${stamp}@srv.test`);
    const without = await searchEntities({ ctx: scopedKey(["read"]), orgSlug: `srv-${stamp}`, query: stamp, types: ["user"] });
    expect(people(without)).toEqual([u.insider]);
    expect(JSON.stringify(without)).not.toContain("@srv.test");
  });
});
