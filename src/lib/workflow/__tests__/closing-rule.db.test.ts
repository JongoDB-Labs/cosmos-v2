// @vitest-environment node
//
// The closing rule through the real routes and engine, against a real
// database: into Done needs a supporting file or a recorded reason (asked for
// through the transition dialog's input), a closed item is read-only until it
// is reopened, a project can override the org either way, and bulk edits are
// held to the same rule item by item.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, type ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const calls = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/teams-notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/teams-notify")>()),
  teamsNotify: vi.fn(),
}));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => undefined) }));

import { PUT as putItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { PUT as bulkPut } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route";
import { seedBoardColumns } from "../provision.server";

let orgId = "";
let aliceId = "";
let typeId = "";
let ticket = 0;

const ALL = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
const ADMIN = ALL & ~Permission.WORKFLOW_OVERRIDE;

const STATUSES: { key: string; name: string; category: ColumnCategory }[] = [
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "doing", name: "Doing", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
  { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
];

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (
    await prisma.organization.create({
      data: { name: `cr ${stamp}`, slug: `cr-${stamp}`, settings: { workflow: { closingRule: true } } },
    })
  ).id;
  await prisma.orgMember.create({ data: { orgId, userId: aliceId, role: "ADMIN" } });
  typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

beforeEach(() => {
  calls.ctx = {
    userId: aliceId, orgId, orgRole: OrgRole.ADMIN, permissions: ADMIN, basePermissions: ADMIN, abacRules: [],
  } satisfies AuthContext;
});

async function project(settings: object = {}) {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const p = await prisma.project.create({ data: { orgId, name: `C ${suffix}`, key: `C${suffix}`, settings } });
  const board = await prisma.board.create({ data: { orgId, projectId: p.id, name: "Board", type: "KANBAN", config: {} } });
  await seedBoardColumns(prisma, board, STATUSES);
  return p.id;
}

async function item(projectId: string, data: Record<string, unknown> = {}) {
  return (
    await prisma.workItem.create({
      data: {
        orgId, projectId, workItemTypeId: typeId, createdById: aliceId, title: `item ${++ticket}`,
        description: "", columnKey: "doing", ticketNumber: ticket, ...data,
      },
    })
  ).id;
}

async function attach(projectId: string, workItemId: string) {
  await prisma.document.create({
    data: {
      orgId, projectId, workItemId, title: "Signed drawing", storageKey: `k/${Math.random()}`, filename: "a.pdf",
      contentType: "application/pdf", size: 10, uploadedById: aliceId,
    },
  });
}

async function put(projectId: string, itemId: string, body: Record<string, unknown>) {
  const res = await putItem(
    new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ orgId, projectId, itemId }) },
  );
  return { status: res.status, body: await res.json() };
}

const row = (id: string) => prisma.workItem.findUniqueOrThrow({ where: { id } });

describe("closing: evidence", () => {
  it("without a file, a move into Done asks for the reason, and nothing moves", async () => {
    const p = await project();
    const a = await item(p);
    const res = await put(p, a, { columnKey: "done" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("transition_input_required");
    expect(res.body.fields).toEqual([
      { field: { system: "closeEvidenceNote" }, required: true, label: "Why no supporting file is needed" },
    ]);
    expect((await row(a)).columnKey).toBe("doing");
  });

  it("the reason, sent as the dialog sends it, closes the item and is recorded", async () => {
    const p = await project();
    const a = await item(p);
    const res = await put(p, a, {
      columnKey: "done",
      transition: { input: { "system:closeEvidenceNote": "Verbal sign-off on site" } },
    });
    expect(res.status).toBe(200);
    const r = await row(a);
    expect(r.columnKey).toBe("done");
    expect(r.closeEvidenceNote).toBe("Verbal sign-off on site");
    const history = await prisma.activity.findMany({ where: { workItemId: a, field: "closeEvidenceNote" } });
    expect(history.map((h) => h.newValue)).toEqual(["Verbal sign-off on site"]);
  });

  it("a reason of only spaces is no reason", async () => {
    const p = await project();
    const a = await item(p);
    const res = await put(p, a, { columnKey: "done", transition: { input: { "system:closeEvidenceNote": "   " } } });
    expect(res.status).toBe(422);
    expect((await row(a)).columnKey).toBe("doing");
  });

  it("an attached file is enough: it closes without asking", async () => {
    const p = await project();
    const a = await item(p);
    await attach(p, a);
    expect((await put(p, a, { columnKey: "done" })).status).toBe(200);
    expect((await row(a)).closeEvidenceNote).toBeNull();
  });

  it("cancelling is not closing: no evidence asked", async () => {
    const p = await project();
    const a = await item(p);
    expect((await put(p, a, { columnKey: "cancelled" })).status).toBe(200);
  });

  it("a project can turn the rule off for itself", async () => {
    const p = await project({ closingRule: false });
    const a = await item(p);
    expect((await put(p, a, { columnKey: "done" })).status).toBe(200);
  });
});

describe("closing: read-only once closed", () => {
  it("a closed item can't be edited, but can be reopened and then edited", async () => {
    const p = await project();
    const a = await item(p, { columnKey: "done", closeEvidenceNote: "n/a" });

    const edit = await put(p, a, { title: "changed after closing" });
    expect(edit.status).toBe(422);
    expect(edit.body).toMatchObject({ code: "transition_invalid", reasons: [{ validator: "closingRule" }] });
    expect((await row(a)).title).not.toBe("changed after closing");

    expect((await put(p, a, { columnKey: "doing" })).status).toBe(200);
    expect((await put(p, a, { title: "changed after reopening" })).status).toBe(200);
    expect((await row(a)).title).toBe("changed after reopening");
  });

  it("reordering a closed item on the board is housekeeping, not an edit", async () => {
    const p = await project();
    const a = await item(p, { columnKey: "done", closeEvidenceNote: "n/a" });
    expect((await put(p, a, { sortOrder: 5 })).status).toBe(200);
  });

  it("re-closing an item that already recorded a reason doesn't ask again", async () => {
    const p = await project();
    const a = await item(p, { columnKey: "done", closeEvidenceNote: "Verbal sign-off" });
    expect((await put(p, a, { columnKey: "doing" })).status).toBe(200);
    expect((await put(p, a, { columnKey: "done" })).status).toBe(200);
  });

  it("with the rule off, a closed item edits as it always did", async () => {
    const p = await project({ closingRule: false });
    const a = await item(p, { columnKey: "done" });
    expect((await put(p, a, { title: "fine" })).status).toBe(200);
  });
});

describe("closing: bulk", () => {
  it("closes the items with a file and reports the others, item by item", async () => {
    const p = await project();
    const withFile = await item(p);
    const without = await item(p);
    await attach(p, withFile);
    const res = await bulkPut(
      new NextRequest("http://localhost/x", {
        method: "PUT",
        body: JSON.stringify({ ids: [withFile, without], update: { columnKey: "done" } }),
      }),
      { params: Promise.resolve({ orgId, projectId: p }) },
    );
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.denied.map((d: { id: string; code: string }) => [d.id, d.code])).toEqual([[without, "transition_input_required"]]);
    expect((await row(withFile)).columnKey).toBe("done");
    expect((await row(without)).columnKey).toBe("doing");
  });
});
