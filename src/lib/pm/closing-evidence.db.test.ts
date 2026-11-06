// @vitest-environment node
//
// The closing rule on deliverables and phases, through the real routes against
// a real database: accepting a deliverable / closing a phase needs a file or a
// reason, a closed record is read-only (and so is its evidence) until it is
// reopened, a project can turn the rule off, and with it off nothing changes.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const calls = vi.hoisted(() => ({ ctx: null as unknown, audit: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/auth/api-key", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/api-key")>()),
  resolveAuth: vi.fn(async () => calls.ctx),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => void calls.audit.push(e)) }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ delete: async () => undefined }) }));

import { PATCH as patchDeliverable, DELETE as deleteDeliverable } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/deliverables/[deliverableId]/route";
import { POST as closePhase } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/phases/[phaseId]/close/route";
import { POST as reopenPhase } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/phases/[phaseId]/reopen/route";
import { PATCH as patchDocument, DELETE as deleteDocument } from "@/app/api/v1/orgs/[orgId]/documents/[docId]/route";

let orgId = "";
let aliceId = "";
let n = 0;
const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (
    await prisma.organization.create({
      data: { name: `ce ${stamp}`, slug: `ce-${stamp}`, settings: { workflow: { closingRule: true } } },
    })
  ).id;
  await prisma.orgMember.create({ data: { orgId, userId: aliceId, role: "OWNER" } });
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});
beforeEach(() => {
  calls.audit.length = 0;
  calls.ctx = { userId: aliceId, orgId, orgRole: OrgRole.OWNER, permissions: ALL, basePermissions: ALL, abacRules: [] } satisfies AuthContext;
});

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, ...(body !== undefined && { body: JSON.stringify(body) }) });

async function project(settings: object = {}) {
  const s = Math.random().toString(36).slice(2, 7).toUpperCase();
  return (await prisma.project.create({ data: { orgId, name: `P ${s}`, key: `P${s}`, settings } })).id;
}
const deliverable = async (projectId: string, data: Record<string, unknown> = {}) =>
  (await prisma.deliverable.create({ data: { orgId, projectId, code: `D-${++n}`, title: `Deliverable ${n}`, status: "SUBMITTED", ...data } })).id;
const phase = async (projectId: string, data: Record<string, unknown> = {}) =>
  (await prisma.projectPhase.create({ data: { orgId, projectId, key: `ph${++n}`, name: `Phase ${n}`, lifecycle: "design", fee: 0, ...data } })).id;
const file = async (projectId: string, link: Record<string, string>) =>
  (
    await prisma.document.create({
      data: { orgId, projectId, title: "Signed", storageKey: `k/${Math.random()}`, filename: "a.pdf", contentType: "application/pdf", size: 1, uploadedById: aliceId, ...link },
    })
  ).id;

const patchD = async (projectId: string, id: string, body: unknown) => {
  const res = await patchDeliverable(req("PATCH", body), { params: Promise.resolve({ orgId, projectId, deliverableId: id }) });
  return { status: res.status, body: await res.json() };
};
const close = async (projectId: string, id: string, body: unknown = {}) => {
  const res = await closePhase(req("POST", body), { params: Promise.resolve({ orgId, projectId, phaseId: id }) });
  return { status: res.status, body: await res.json() };
};
const reopen = async (projectId: string, id: string) =>
  (await reopenPhase(req("POST"), { params: Promise.resolve({ orgId, projectId, phaseId: id }) })).status;

describe("deliverables", () => {
  it("accepting without a file or reason is refused with close_evidence_required, and nothing changes", async () => {
    const p = await project();
    const d = await deliverable(p);
    const res = await patchD(p, d, { status: "ACCEPTED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("close_evidence_required");
    expect((await prisma.deliverable.findUniqueOrThrow({ where: { id: d } })).status).toBe("SUBMITTED");
  });

  it("a reason accepts it and is recorded; a file alone accepts it too", async () => {
    const p = await project();
    const d = await deliverable(p);
    expect((await patchD(p, d, { status: "ACCEPTED_WITH_COMMENTS", closeEvidenceNote: " Accepted at review " })).status).toBe(200);
    expect((await prisma.deliverable.findUniqueOrThrow({ where: { id: d } })).closeEvidenceNote).toBe("Accepted at review");

    const e = await deliverable(p);
    await file(p, { deliverableId: e });
    expect((await patchD(p, e, { status: "ACCEPTED" })).status).toBe(200);
  });

  it("a whitespace reason is no reason", async () => {
    const p = await project();
    const d = await deliverable(p);
    expect((await patchD(p, d, { status: "ACCEPTED", closeEvidenceNote: "   " })).status).toBe(422);
  });

  it("an accepted deliverable is read-only and can't be deleted, until it is moved back out of acceptance", async () => {
    const p = await project();
    const d = await deliverable(p, { status: "ACCEPTED", closeEvidenceNote: "n/a" });
    const edit = await patchD(p, d, { title: "changed" });
    expect(edit.status).toBe(422);
    expect(edit.body.code).toBe("closed_read_only");
    expect((await patchD(p, d, { status: "ACCEPTED_WITH_COMMENTS" })).status).toBe(422);
    const del = await deleteDeliverable(req("DELETE"), { params: Promise.resolve({ orgId, projectId: p, deliverableId: d }) });
    expect(del.status).toBe(422);

    expect((await patchD(p, d, { status: "REVISION_REQUIRED" })).status).toBe(200);
    expect((await patchD(p, d, { title: "changed after reopening" })).status).toBe(200);
    // Accepting again: the recorded reason still counts.
    expect((await patchD(p, d, { status: "ACCEPTED" })).status).toBe(200);
  });

  it("with the project's rule off, accepting and editing work as before", async () => {
    const p = await project({ closingRule: false });
    const d = await deliverable(p);
    expect((await patchD(p, d, { status: "ACCEPTED" })).status).toBe(200);
    expect((await patchD(p, d, { title: "still editable" })).status).toBe(200);
  });
});

describe("phases", () => {
  it("closing needs a file or a reason; closing records who and when, and is audited", async () => {
    const p = await project();
    const ph = await phase(p, { percentComplete: 1 });
    const refused = await close(p, ph);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("close_evidence_required");
    expect((await prisma.projectPhase.findUniqueOrThrow({ where: { id: ph } })).closedAt).toBeNull();

    const ok = await close(p, ph, { closeEvidenceNote: "Client sign-off by email" });
    expect(ok.status).toBe(200);
    const row = await prisma.projectPhase.findUniqueOrThrow({ where: { id: ph } });
    expect(row.closedAt).not.toBeNull();
    expect(row.closedById).toBe(aliceId);
    expect(row.closeEvidenceNote).toBe("Client sign-off by email");
    expect(calls.audit.map((a) => a.action)).toContain("phase.closed");
  });

  it("a file on the phase is enough", async () => {
    const p = await project();
    const ph = await phase(p);
    await file(p, { phaseId: ph });
    expect((await close(p, ph)).status).toBe(200);
  });

  it("closing twice is a 409; reopening clears it, is audited, and keeps the reason", async () => {
    const p = await project();
    const ph = await phase(p);
    expect((await close(p, ph, { closeEvidenceNote: "n/a" })).status).toBe(200);
    expect((await close(p, ph, { closeEvidenceNote: "n/a" })).status).toBe(409);
    expect(await reopen(p, ph)).toBe(200);
    const row = await prisma.projectPhase.findUniqueOrThrow({ where: { id: ph } });
    expect(row.closedAt).toBeNull();
    expect(row.closedById).toBeNull();
    expect(row.closeEvidenceNote).toBe("n/a");
    expect(calls.audit.map((a) => a.action)).toContain("phase.reopened");
    expect(await reopen(p, ph)).toBe(409);
    // Closing again doesn't ask: the reason is still on record.
    expect((await close(p, ph)).status).toBe(200);
  });

  it("closing a phase that's already closed is a 409, not a request for evidence", async () => {
    const p = await project();
    const ph = await phase(p, { closedAt: new Date(), closedById: aliceId });
    expect((await close(p, ph)).status).toBe(409);
  });

  it("with the rule off, a phase closes without evidence", async () => {
    const p = await project({ closingRule: false });
    const ph = await phase(p);
    expect((await close(p, ph)).status).toBe(200);
  });
});

describe("evidence on a closed record", () => {
  it("can't be detached or deleted while the record is closed; can once reopened", async () => {
    const p = await project();
    const ph = await phase(p);
    const doc = await file(p, { phaseId: ph });
    expect((await close(p, ph)).status).toBe(200);

    const detach = await patchDocument(req("PATCH", { phaseId: null }), { params: Promise.resolve({ orgId, docId: doc }) });
    expect(detach.status).toBe(422);
    const del = await deleteDocument(req("DELETE"), { params: Promise.resolve({ orgId, docId: doc }) });
    expect(del.status).toBe(422);
    expect(await prisma.document.count({ where: { id: doc, phaseId: ph } })).toBe(1);

    expect(await reopen(p, ph)).toBe(200);
    expect((await patchDocument(req("PATCH", { phaseId: null }), { params: Promise.resolve({ orgId, docId: doc }) })).status).toBe(200);
  });

  it("a file attaches to a deliverable on its own project, and not to another project's", async () => {
    const p = await project();
    const other = await project();
    const d = await deliverable(p);
    const foreign = await deliverable(other);
    const doc = await file(p, {});
    expect((await patchDocument(req("PATCH", { deliverableId: foreign }), { params: Promise.resolve({ orgId, docId: doc }) })).status).toBe(400);
    expect((await patchDocument(req("PATCH", { deliverableId: d }), { params: Promise.resolve({ orgId, docId: doc }) })).status).toBe(200);
    expect((await patchD(p, d, { status: "ACCEPTED" })).status).toBe(200);
  });

  // A file with no project has no project to validate a link against, and the
  // route's `doc.projectId ? … : {}` scope degraded to the whole org when it
  // was null -- so a deliverable or phase on ANY project could be attached,
  // including ones this caller cannot see, and the attachment list on that
  // record would then disclose the file. One guard covers all three link
  // targets (workItemId, deliverableId, phaseId); two are exercised here.
  it("a file on no project cannot be attached to a project's deliverable or phase", async () => {
    const p = await project();
    const d = await deliverable(p);
    const ph = await phase(p);
    const orphan = (
      await prisma.document.create({
        data: {
          orgId, projectId: null, title: "Orphan", storageKey: `k/${Math.random()}`,
          filename: "o.pdf", contentType: "application/pdf", size: 1, uploadedById: aliceId,
        },
      })
    ).id;
    const at = () => ({ params: Promise.resolve({ orgId, docId: orphan }) });

    expect((await patchDocument(req("PATCH", { deliverableId: d }), at())).status).toBe(400);
    expect((await patchDocument(req("PATCH", { phaseId: ph }), at())).status).toBe(400);

    // Nothing stuck to it.
    expect(
      await prisma.document.findUniqueOrThrow({ where: { id: orphan }, select: { deliverableId: true, phaseId: true } }),
    ).toEqual({ deliverableId: null, phaseId: null });

    // The refusal is about links, not the file: renaming still works, and so
    // does an explicit detach, which narrows nothing.
    expect((await patchDocument(req("PATCH", { title: "Renamed" }), at())).status).toBe(200);
    expect((await patchDocument(req("PATCH", { deliverableId: null }), at())).status).toBe(200);
  });

  it("deleting the deliverable keeps the file (SET NULL)", async () => {
    const p = await project({ closingRule: false });
    const d = await deliverable(p);
    const doc = await file(p, { deliverableId: d });
    await prisma.deliverable.delete({ where: { id: d } });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc } })).deliverableId).toBeNull();
  });
});
