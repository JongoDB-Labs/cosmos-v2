// @vitest-environment node
//
// A RESTRICTED file is visible to its uploader, the people it is shared with,
// and org administrators. The project and org lists already hid it from
// everyone else in its project, but several other doors did not: the document
// by id (with its parsed text), both "original" downloads, its item links, the
// work item's attachment list, the "created from" chip on an item, convert,
// propose and the assistant's list_documents tool. Each must answer a project
// member who was not named exactly as the list does: as if the file were not
// there.
//
// Every refusal below is paired with the same request from somebody the file
// WAS shared with, so a refusal cannot pass by the route simply being broken.
// Through the real routes, against a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { getStorage } from "@/lib/storage";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { memberToolCtx } from "@/lib/testing/tool-auth";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// Propose calls the org's model. The gate in front of it is what is under test,
// so the model call is replaced and its invocations are counted.
const propose = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/files/propose", () => ({
  proposeItems: async () => {
    propose.calls++;
    return [];
  },
}));

import { GET as getDoc } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[docId]/route";
import { GET as getOriginal } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[docId]/original/route";
import { GET as getLinks } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[docId]/links/route";
import { POST as convert } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[docId]/convert/route";
import { POST as proposeRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[docId]/propose/route";
import { GET as getOrgOriginal } from "@/app/api/v1/orgs/[orgId]/documents/[docId]/original/route";
import { GET as getAttachments } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/attachments/route";
import { DELETE as detach } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/attachments/[docId]/route";
import { GET as getSource } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/document-source/route";
import { listDocuments } from "@/lib/ai/executors/documents";

const stamp = Math.random().toString(36).slice(2, 8);
const SECRET_TITLE = `salary-bands-${stamp}`;
const SECRET_TEXT = `band-c-ceiling-${stamp}`;
const SECRET_BYTES = `bytes-of-${stamp}`;
const OPEN_TITLE = `open-spec-${stamp}`;
const ORG_SECRET_BYTES = `org-bytes-${stamp}`;

let orgId = "", projectId = "", typeId = "";
let uploader = "", reader = "", sharee = "";
let restrictedDoc = "", restrictedBlock = "", openDoc = "", openBlock = "", orgDoc = "";
let item = "", fromRestricted = "", fromOpen = "";

beforeAll(async () => {
  const mk = async (tag: string) =>
    (await prisma.user.create({ data: { email: `${tag}-${stamp}@rdoor.test`, displayName: tag } })).id;
  uploader = await mk("uploader");
  reader = await mk("reader");
  sharee = await mk("sharee");
  orgId = (await prisma.organization.create({ data: { name: `rdoor ${stamp}`, slug: `rdoor-${stamp}` } })).id;
  for (const userId of [uploader, reader, sharee]) {
    await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } });
  }
  // An ordinary project, NOT team-scoped: the reader can see everything in it
  // except the one file that was restricted.
  projectId = (await prisma.project.create({
    data: { orgId, name: "P", key: `RD${stamp.slice(0, 3).toUpperCase()}` },
  })).id;
  await ensureFixtureStatuses(projectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
  const wi = (title: string) =>
    createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: uploader, title, columnKey: "todo" });
  item = (await wi("carries both files")).id;
  fromRestricted = (await wi("made from the restricted file")).id;
  fromOpen = (await wi("made from the open file")).id;

  const storage = getStorage();
  const doc = async (title: string, visibility: "INHERIT" | "RESTRICTED", bytes: string, pid: string | null) => {
    const key = `test/rdoor/${stamp}/${title}.txt`;
    await storage.put(key, Buffer.from(bytes), { contentType: "text/plain", filename: `${title}.txt` });
    return (await prisma.document.create({
      data: {
        orgId, projectId: pid, workItemId: pid ? item : null, visibility, title,
        storageKey: key, filename: `${title}.txt`, contentType: "text/plain",
        size: bytes.length, uploadedById: uploader, status: "READY",
      },
    })).id;
  };
  restrictedDoc = await doc(SECRET_TITLE, "RESTRICTED", SECRET_BYTES, projectId);
  openDoc = await doc(OPEN_TITLE, "INHERIT", "open bytes", projectId);
  orgDoc = await doc(`org-restricted-${stamp}`, "RESTRICTED", ORG_SECRET_BYTES, null);

  const block = async (documentId: string, text: string) =>
    (await prisma.documentBlock.create({
      data: { documentId, orgId, kind: "PARAGRAPH", text, anchor: "p-1", ordinal: 0 },
    })).id;
  restrictedBlock = await block(restrictedDoc, SECRET_TEXT);
  openBlock = await block(openDoc, "open text");
  await prisma.documentItemLink.createMany({
    data: [
      { orgId, projectId, blockId: restrictedBlock, itemType: "WORK_ITEM", itemId: fromRestricted },
      { orgId, projectId, blockId: openBlock, itemType: "WORK_ITEM", itemId: fromOpen },
    ],
  });
  for (const documentId of [restrictedDoc, orgDoc]) {
    await prisma.documentShare.create({ data: { orgId, documentId, userId: sharee, grantedById: uploader } });
  }
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [uploader, reader, sharee] } } }).catch(() => undefined);
});

/** An ordinary member's session: the MEMBER role's bits, plus any a work role adds. */
const as = (userId: string, extra = 0n): AuthContext => {
  const ctx: AuthContext = {
    userId, orgId, orgRole: "MEMBER", abacRules: [],
    permissions: RolePermissions.MEMBER | extra, basePermissions: RolePermissions.MEMBER | extra,
  };
  h.ctx = ctx;
  return ctx;
};
const get = () => new NextRequest("http://localhost/x");
const post = (body: unknown) =>
  new NextRequest("http://localhost/x", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  });
const onDoc = (docId: string) => ({ params: Promise.resolve({ orgId, projectId, docId }) });
const onItem = (itemId: string) => ({ params: Promise.resolve({ orgId, projectId, itemId }) });
const rows = async (res: Response) => {
  return (await res.json()) as Array<{ id: string; title?: string }>;
};

describe("a project member who was not named cannot reach a restricted file by id", () => {
  it("document by id: 404 without the parsed text; 200 with it for a sharee", async () => {
    as(reader);
    const denied = await getDoc(get(), onDoc(restrictedDoc));
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(SECRET_TEXT);

    as(sharee);
    const allowed = await getDoc(get(), onDoc(restrictedDoc));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain(SECRET_TEXT);
  });

  it("an unrestricted file in the same project still opens for the reader", async () => {
    as(reader);
    const res = await getDoc(get(), onDoc(openDoc));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("open text");
  });

  it("project download: 404, not the bytes; the sharee gets the bytes", async () => {
    as(reader);
    const denied = await getOriginal(get(), onDoc(restrictedDoc));
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(SECRET_BYTES);

    as(sharee);
    const allowed = await getOriginal(get(), onDoc(restrictedDoc));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe(SECRET_BYTES);
  });

  it("org-library download, for a project file and an org-wide one", async () => {
    const at = (docId: string) => ({ params: Promise.resolve({ orgId, docId }) });
    as(reader);
    expect((await getOrgOriginal(get(), at(restrictedDoc))).status).toBe(404);
    const orgDenied = await getOrgOriginal(get(), at(orgDoc));
    expect(orgDenied.status).toBe(404);
    expect(await orgDenied.text()).not.toContain(ORG_SECRET_BYTES);

    as(sharee);
    expect(await (await getOrgOriginal(get(), at(restrictedDoc))).text()).toBe(SECRET_BYTES);
    expect(await (await getOrgOriginal(get(), at(orgDoc))).text()).toBe(ORG_SECRET_BYTES);
  });

  it("item links: 404 for the reader, the link for the sharee", async () => {
    as(reader);
    expect((await getLinks(get(), onDoc(restrictedDoc))).status).toBe(404);
    as(sharee);
    const allowed = await getLinks(get(), onDoc(restrictedDoc));
    expect(allowed.status).toBe(200);
    expect((await rows(allowed)).map((l) => (l as unknown as { itemId: string }).itemId)).toEqual([fromRestricted]);
  });

  it("convert: 404 for the reader and nothing is created; 201 for the sharee", async () => {
    const before = await prisma.workItem.count({ where: { projectId } });
    as(reader);
    expect((await convert(post({ blockId: restrictedBlock }), onDoc(restrictedDoc))).status).toBe(404);
    expect(await prisma.workItem.count({ where: { projectId } })).toBe(before);

    as(sharee);
    const ok = await convert(post({ blockId: restrictedBlock }), onDoc(restrictedDoc));
    expect(ok.status).toBe(201);
    expect(await prisma.workItem.count({ where: { projectId } })).toBe(before + 1);
  });

  it("convert: a readable document's id cannot carry a block from a restricted one", async () => {
    as(reader);
    const before = await prisma.workItem.count({ where: { projectId } });
    const res = await convert(post({ blockId: restrictedBlock }), onDoc(openDoc));
    expect(res.status).not.toBe(201);
    expect(await res.text()).not.toContain(SECRET_TEXT);
    expect(await prisma.workItem.count({ where: { projectId } })).toBe(before);
    // The positive control: the open document's own block converts.
    expect((await convert(post({ blockId: openBlock }), onDoc(openDoc))).status).toBe(201);
  });

  it("propose: 404 for the reader without calling the model; the sharee is proposed for", async () => {
    propose.calls = 0;
    as(reader, Permission.PROJECT_UPDATE);
    expect((await proposeRoute(post({}), onDoc(restrictedDoc))).status).toBe(404);
    expect(propose.calls).toBe(0);

    as(sharee, Permission.PROJECT_UPDATE);
    expect((await proposeRoute(post({}), onDoc(restrictedDoc))).status).toBe(200);
    expect(propose.calls).toBe(1);
  });
});

describe("a restricted file is not listed or named where the reader can look", () => {
  it("the work item's attachments omit it for the reader and list it for the sharee", async () => {
    as(reader);
    const seen = await rows(await getAttachments(get(), onItem(item)));
    expect(seen.map((d) => d.id)).toContain(openDoc);
    expect(seen.map((d) => d.id)).not.toContain(restrictedDoc);
    expect(JSON.stringify(seen)).not.toContain(SECRET_TITLE);

    as(sharee);
    const shared = await rows(await getAttachments(get(), onItem(item)));
    expect(shared.map((d) => d.id)).toEqual(expect.arrayContaining([openDoc, restrictedDoc]));
  });

  it("detaching it answers 404 and leaves it attached; the sharee may detach it", async () => {
    const at = (docId: string) => ({ params: Promise.resolve({ orgId, projectId, itemId: item, docId }) });
    const del = () => new NextRequest("http://localhost/x", { method: "DELETE" });
    as(reader);
    expect((await detach(del(), at(restrictedDoc))).status).toBe(404);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: restrictedDoc } })).workItemId).toBe(item);

    as(sharee);
    expect((await detach(del(), at(restrictedDoc))).status).toBe(200);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: restrictedDoc } })).workItemId).toBeNull();
    await prisma.document.update({ where: { id: restrictedDoc }, data: { workItemId: item } });
  });

  it("the 'created from' chip names it only for somebody who may see it", async () => {
    const source = async (itemId: string) => (await getSource(get(), onItem(itemId))).json();
    as(reader);
    expect(await source(fromRestricted)).toBeNull();
    // Positive control: the same reader sees the chip for the open file.
    expect(await source(fromOpen)).toMatchObject({ docId: openDoc, docTitle: OPEN_TITLE });

    as(sharee);
    expect(await source(fromRestricted)).toMatchObject({ docId: restrictedDoc, docTitle: SECRET_TITLE });
  });

  it("the assistant's list_documents omits it for the reader and lists it for the sharee", async () => {
    type Listed = { documents: Array<{ id: string; title: string }> };
    const forReader = (await listDocuments({ projectId }, await memberToolCtx(orgId, reader))) as Listed;
    expect(forReader.documents.map((d) => d.id)).toContain(openDoc);
    expect(forReader.documents.map((d) => d.id)).not.toContain(restrictedDoc);

    const forSharee = (await listDocuments({ projectId }, await memberToolCtx(orgId, sharee))) as Listed;
    expect(forSharee.documents.map((d) => d.id)).toEqual(expect.arrayContaining([openDoc, restrictedDoc]));
  });
});
