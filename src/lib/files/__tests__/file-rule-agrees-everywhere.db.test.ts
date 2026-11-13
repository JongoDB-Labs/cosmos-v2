// @vitest-environment node
//
// One rule for who may read a stored file, and every door asks it:
//
// - An INHERIT file is as readable as its project: the PROJECT_READ bit, any
//   allow/deny rule on that project, and team scoping. The project's own
//   document routes ask exactly that, so the org library, its download, its
//   list and search must too.
// - A RESTRICTED file is for its uploader, the people it was shared with and
//   org administrators. An explicit share opens it on every door, even from
//   outside a team-scoped project, unless a deny rule on that project or an
//   API key's project limit says otherwise.
// - Search, @-mentions and the "is there a supporting file" questions are doors
//   too: a title in a search result, or a prompt that does not appear, tells
//   somebody a hidden file exists.
//
// Through the real routes, against a real database. Every refusal is paired
// with somebody who is entitled to the same file and gets it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { getStorage } from "@/lib/storage";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/teams-notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/teams-notify")>()),
  teamsNotify: vi.fn(),
}));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => undefined) }));

import { GET as search } from "@/app/api/v1/orgs/[orgId]/search/route";
import { GET as mentionSearch } from "@/app/api/v1/orgs/[orgId]/mentions/search/route";
import { POST as mentionResolve } from "@/app/api/v1/orgs/[orgId]/mentions/resolve/route";
import { GET as orgList } from "@/app/api/v1/orgs/[orgId]/documents/route";
import { GET as orgGet } from "@/app/api/v1/orgs/[orgId]/documents/[docId]/route";
import { GET as orgOriginal } from "@/app/api/v1/orgs/[orgId]/documents/[docId]/original/route";
import { GET as projGet } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[docId]/route";
import { GET as projOriginal } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[docId]/original/route";
import { PUT as putItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { seedBoardColumns } from "@/lib/workflow/provision.server";
import { evidenceFiles } from "@/lib/pm/closing-evidence.server";
import { readableDocument } from "@/lib/files/access";

const stamp = Math.random().toString(36).slice(2, 8);
// One word in every title, so a single search reaches all of them.
const TOKEN = `ledger${stamp}`;
const T_RESTRICTED_P = `${TOKEN}-restricted-p`;
const T_OPEN_P = `${TOKEN}-open-p`;
const T_RESTRICTED_T = `${TOKEN}-restricted-t`;
const BYTES_T = `bytes-t-${stamp}`;

let orgId = "", orgSlug = "", P = "", T = "";
let uploader = "", reader = "", sharee = "", admin = "";
let restrictedP = "", openP = "", restrictedT = "";
let typeId = "", item = "", phaseId = "", deliverableId = "";

const STATUSES: { key: string; name: string; category: ColumnCategory }[] = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "doing", name: "Doing", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
];

beforeAll(async () => {
  const mk = async (tag: string) =>
    (await prisma.user.create({ data: { email: `${tag}-${stamp}@agree.test`, displayName: `${tag} ${stamp}` } })).id;
  [uploader, reader, sharee, admin] = await Promise.all(["uploader", "reader", "sharee", "admin"].map(mk));
  orgSlug = `agree-${stamp}`;
  orgId = (await prisma.organization.create({
    data: { name: `agree ${stamp}`, slug: orgSlug, settings: { workflow: { closingRule: true } } },
  })).id;
  const om: Record<string, string> = {};
  for (const u of [uploader, reader, sharee]) {
    om[u] = (await prisma.orgMember.create({ data: { orgId, userId: u, role: "MEMBER", permissions: "0" } })).id;
  }
  await prisma.orgMember.create({ data: { orgId, userId: admin, role: "ADMIN", permissions: "0" } });
  // P is an ordinary project. T is limited to its members: the uploader is one,
  // the reader and the sharee are not.
  P = (await prisma.project.create({ data: { orgId, name: "P", key: `AP${stamp.slice(0, 3).toUpperCase()}` } })).id;
  T = (await prisma.project.create({
    data: { orgId, name: "T", key: `AT${stamp.slice(0, 3).toUpperCase()}`, teamScopedAccess: true },
  })).id;
  await prisma.projectMember.create({ data: { projectId: T, orgMemberId: om[uploader], role: "MEMBER" } });

  const board = await prisma.board.create({ data: { orgId, projectId: P, name: "Board", type: "KANBAN", config: {} } });
  await seedBoardColumns(prisma, board, STATUSES);
  typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  item = (await prisma.workItem.create({
    data: {
      orgId, projectId: P, workItemTypeId: typeId, createdById: uploader, title: "closes with a hidden file",
      description: "", columnKey: "doing", ticketNumber: 1,
    },
  })).id;
  phaseId = (await prisma.projectPhase.create({ data: { orgId, projectId: P, key: "design", name: `Phase ${stamp}`, lifecycle: "custom", fee: 0 } })).id;
  deliverableId = (await prisma.deliverable.create({
    data: { orgId, projectId: P, code: "D-1", title: `Deliverable ${stamp}` } as never,
  })).id;

  const storage = getStorage();
  const doc = async (
    title: string, visibility: "INHERIT" | "RESTRICTED", projectId: string, bytes: string,
    on: { workItemId?: string; phaseId?: string; deliverableId?: string } = {},
  ) => {
    const key = `test/agree/${stamp}/${title}.txt`;
    await storage.put(key, Buffer.from(bytes), { contentType: "text/plain", filename: `${title}.txt` });
    return (await prisma.document.create({
      data: {
        orgId, projectId, visibility, title, storageKey: key, filename: `${title}.txt`, contentType: "text/plain",
        size: bytes.length, uploadedById: uploader, status: "READY", ...on,
      },
    })).id;
  };
  // The restricted file on P is the only supporting file on the item, the phase
  // and the deliverable, so whether it counts is visible in each close.
  restrictedP = await doc(T_RESTRICTED_P, "RESTRICTED", P, "bytes-p", { workItemId: item, phaseId, deliverableId });
  openP = await doc(T_OPEN_P, "INHERIT", P, "open bytes");
  restrictedT = await doc(T_RESTRICTED_T, "RESTRICTED", T, BYTES_T);
  for (const documentId of [restrictedP, restrictedT]) {
    await prisma.documentShare.create({ data: { orgId, documentId, userId: sharee, grantedById: uploader } });
  }
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [uploader, reader, sharee, admin] } } }).catch(() => undefined);
});

const as = (userId: string, over: Partial<AuthContext> = {}): AuthContext => {
  const ctx: AuthContext = {
    userId, orgId, orgRole: "MEMBER", abacRules: [],
    permissions: RolePermissions.MEMBER, basePermissions: RolePermissions.MEMBER, ...over,
  };
  h.ctx = ctx;
  return ctx;
};
const deny = (action: string, projectId: string): AbacRule =>
  ({ effect: "deny", actions: [action], conditions: [{ attr: "projectId", op: "eq", value: projectId }] }) as AbacRule;
const req = (url = "http://localhost/x") => new NextRequest(url);
const orgP = () => ({ params: Promise.resolve({ orgId }) });
const onDoc = (docId: string) => ({ params: Promise.resolve({ orgId, docId }) });
const onProjDoc = (projectId: string, docId: string) => ({ params: Promise.resolve({ orgId, projectId, docId }) });

/** The status of a project-route call, treating a thrown error as the 500 the client would get. */
async function status(call: Promise<Response>): Promise<number> {
  try {
    return (await call).status;
  } catch {
    return 500;
  }
}

/** Every door onto one file, for the signed-in caller. */
async function doors(projectId: string, docId: string) {
  const listed = ((await (await orgList(req(), orgP())).json()) as Array<{ id: string }>).some((d) => d.id === docId);
  const original = await orgOriginal(req(), onDoc(docId));
  return {
    orgGet: (await orgGet(req(), onDoc(docId))).status,
    orgOriginal: original.status,
    listed,
    projGet: await status(projGet(req(), onProjDoc(projectId, docId))),
    projOriginal: await status(projOriginal(req(), onProjDoc(projectId, docId))),
  };
}
const OPENS = { orgGet: 200, orgOriginal: 200, listed: true, projGet: 200, projOriginal: 200 };

/** Document titles from the palette search, @-mention search and the mention resolver. */
async function titles() {
  const palette = ((await (await search(req(`http://localhost/x?q=${TOKEN}`), orgP())).json()) as Array<{ type: string; name: string }>)
    .filter((r) => r.type === "document").map((r) => r.name);
  const typeahead = ((await (await mentionSearch(req(`http://localhost/x?q=${TOKEN}&types=document&perType=15`), orgP())).json()) as Array<{ label: string }>)
    .map((r) => r.label);
  const resolved = ((await (await mentionResolve(
    new NextRequest("http://localhost/x", {
      method: "POST",
      body: JSON.stringify({ refs: [restrictedP, openP, restrictedT].map((id) => ({ type: "document", id })) }),
      headers: { "Content-Type": "application/json" },
    }),
    orgP(),
  )).json()) as Array<{ label: string }>).map((r) => r.label);
  return { palette: palette.sort(), typeahead: typeahead.sort(), resolved: resolved.sort() };
}

describe("search and @-mentions name a file only to somebody who may open it", () => {
  it("a project reader who was not named gets the open file and no restricted title, from all three", async () => {
    as(reader);
    const t = await titles();
    expect(t).toEqual({ palette: [T_OPEN_P], typeahead: [T_OPEN_P], resolved: [T_OPEN_P] });
  });

  it("the person both files were shared with gets them, even the one on a project they are not on", async () => {
    as(sharee);
    const all = [T_OPEN_P, T_RESTRICTED_P, T_RESTRICTED_T];
    expect(await titles()).toEqual({ palette: all, typeahead: all, resolved: all });
  });

  it("a rule denying PROJECT_READ on P takes P's open file out of search too", async () => {
    as(reader, { abacRules: [deny("PROJECT_READ", P)] });
    expect(await titles()).toEqual({ palette: [], typeahead: [], resolved: [] });
  });
});

describe("a deny rule on the project closes every door, as the project's own routes do", () => {
  it("control: without the rule, the reader opens P's open file everywhere", async () => {
    as(reader);
    expect(await doors(P, openP)).toEqual(OPENS);
  });

  it("with PROJECT_READ denied on P: no door opens it, and the file is not listed", async () => {
    as(reader, { abacRules: [deny("PROJECT_READ", P)] });
    expect(await doors(P, openP)).toEqual({ orgGet: 404, orgOriginal: 404, listed: false, projGet: 403, projOriginal: 404 });
  });

  it("a share does not override the rule either", async () => {
    as(sharee, { abacRules: [deny("PROJECT_READ", P)] });
    expect(await doors(P, restrictedP)).toEqual({ orgGet: 404, orgOriginal: 404, listed: false, projGet: 403, projOriginal: 404 });
  });
});

describe("an explicit share opens the file on every door, even from outside a limited project", () => {
  it("the sharee, who is not on T, reads and downloads T's restricted file everywhere", async () => {
    as(sharee);
    expect(await doors(T, restrictedT)).toEqual(OPENS);
    expect(await (await orgOriginal(req(), onDoc(restrictedT))).text()).toBe(BYTES_T);
    expect(await (await projOriginal(req(), onProjDoc(T, restrictedT))).text()).toBe(BYTES_T);
  });

  it("somebody not named, also not on T, gets nothing from any door, and a 404 rather than a server error", async () => {
    as(reader);
    expect(await doors(T, restrictedT)).toEqual({ orgGet: 404, orgOriginal: 404, listed: false, projGet: 403, projOriginal: 404 });
  });

  it("a deny rule on T still closes it to the sharee", async () => {
    as(sharee, { abacRules: [deny("PROJECT_READ", T)] });
    expect(await doors(T, restrictedT)).toEqual({ orgGet: 404, orgOriginal: 404, listed: false, projGet: 403, projOriginal: 404 });
  });

  it("so does an API key limited to another project", async () => {
    as(sharee, { isApiKey: true, projectScope: [P] });
    expect(await doors(T, restrictedT)).toEqual({ orgGet: 404, orgOriginal: 404, listed: false, projGet: 403, projOriginal: 404 });
    // Control: the same key still opens the shared file inside its project.
    expect((await orgGet(req(), onDoc(restrictedP))).status).toBe(200);
  });
});

describe("whether a supporting file exists is answered from the files the caller may see", () => {
  it("phase and deliverable: the hidden file counts for its uploader and not for a reader", async () => {
    expect(await evidenceFiles(orgId, { phaseId }, as(reader), P)).toBe(0);
    expect(await evidenceFiles(orgId, { deliverableId }, as(reader), P)).toBe(0);
    expect(await evidenceFiles(orgId, { phaseId }, as(uploader), P)).toBe(1);
    expect(await evidenceFiles(orgId, { deliverableId }, as(uploader), P)).toBe(1);
  });

  it("an item: a reader moving it to Done is asked for the reason, as if no file were attached", async () => {
    as(reader);
    const res = await putItem(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ columnKey: "done" }) }),
      { params: Promise.resolve({ orgId, projectId: P, itemId: item }) },
    );
    const body = (await res.json()) as { code?: string };
    expect([res.status, body.code]).toEqual([422, "transition_input_required"]);
  });

  it("control: the uploader, who can see the file, closes it without being asked", async () => {
    as(uploader);
    const res = await putItem(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ columnKey: "done" }) }),
      { params: Promise.resolve({ orgId, projectId: P, itemId: item }) },
    );
    expect(res.status).toBe(200);
  });
});

describe("an API key reaches a restricted file only with the scope for it, whoever minted it", () => {
  // A key's permissions are its minter's narrowed by its scopes; its org ROLE is
  // the minter's, unnarrowed. So the role, the upload and the share each open a
  // restricted file only once the key holds the bit that reading files needs.
  const NO_FILES = Permission.ORG_READ | Permission.ITEM_READ;
  const listed = async () =>
    ((await (await orgList(req(), orgP())).json()) as Array<{ id: string }>).map((d) => d.id);
  const keyOf = (userId: string, orgRole: AuthContext["orgRole"]) =>
    as(userId, { orgRole, isApiKey: true, permissions: NO_FILES, basePermissions: RolePermissions[orgRole] });

  it("control: the administrator in person opens and lists both restricted files", async () => {
    const ctx = as(admin, { orgRole: "ADMIN", permissions: RolePermissions.ADMIN, basePermissions: RolePermissions.ADMIN });
    expect([(await orgGet(req(), onDoc(restrictedP))).status, (await orgGet(req(), onDoc(restrictedT))).status]).toEqual([200, 200]);
    expect(await listed()).toEqual(expect.arrayContaining([restrictedP, restrictedT]));
    expect(await readableDocument(orgId, restrictedP, ctx)).not.toBeNull();
  });

  for (const [who, role] of [["administrator", "ADMIN"], ["uploader", "MEMBER"], ["sharee", "MEMBER"]] as const) {
    it(`the ${who}'s key without the scope: 404 by id, and absent from the list and search`, async () => {
      const userId = { administrator: admin, uploader, sharee }[who];
      const ctx = keyOf(userId, role);
      expect(await readableDocument(orgId, restrictedP, ctx)).toBeNull();
      expect([(await orgGet(req(), onDoc(restrictedP))).status, (await orgGet(req(), onDoc(restrictedT))).status]).toEqual([404, 404]);
      const ids = await listed();
      expect(ids).not.toContain(restrictedP);
      expect(ids).not.toContain(restrictedT);
      const { palette, typeahead } = await titles();
      expect([...palette, ...typeahead].filter((t) => t.includes("restricted"))).toEqual([]);
    });
  }
});
