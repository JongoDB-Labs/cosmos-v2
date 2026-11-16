// @vitest-environment node
//
// A request body that isn't JSON (empty, cut short, or plain text) is the
// client's mistake, so it is a 400 that says so. `request.json()` throws a
// SyntaxError for it, which no branch of handleApiError recognised, so every
// route that read its body that way answered 500 and reported a server fault.
// Routes read the body with readJsonBody (src/lib/api-helpers.ts) instead;
// `request-json.arch.test.ts` keeps them on it.
//
// One route per method that carries a body, through the real handler and a
// real database: only the auth context is stubbed. Each case first sends a
// valid body, so a 400 below is about the body and not about getting there.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { INVALID_JSON_BODY } from "@/lib/openapi/problem";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx }));
vi.mock("@/lib/cache/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache/queries")>()),
  revalidateOrg: () => undefined,
}));

import { PUT as putSecuritySettings } from "./security/settings/route";
import { POST as createLabel } from "./labels/route";
import { PATCH as patchLabel } from "./labels/[labelId]/route";
import { DELETE as unlinkObjective } from "./projects/[projectId]/objectives/[objectiveId]/links/route";
import { POST as resolveMentions } from "./mentions/resolve/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "";
let ownerId = "";
let projectId = "";
let objectiveId = "";
let labelId = "";

/** A request whose body is exactly `raw`: no JSON.stringify, so it can be malformed. */
const send = (method: string, raw: string | undefined) =>
  new NextRequest("http://localhost/api/v1/orgs/x", {
    method,
    ...(raw !== undefined && { body: raw, headers: { "content-type": "application/json" } }),
  });

/** The bodies that aren't JSON, as a browser or a script can send them. */
const MALFORMED: [label: string, raw: string][] = [
  ["cut short", '{"name": "Re'],
  ["empty", ""],
  ["not JSON at all", "name=Release"],
];

async function expectInvalidJson(res: Response) {
  const body = await res.json();
  expect({ status: res.status, code: body.code, detail: body.detail, error: body.error }).toEqual({
    status: 400,
    code: "invalid_request",
    detail: INVALID_JSON_BODY,
    error: INVALID_JSON_BODY,
  });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `mb ${stamp}`, slug: `mb-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `mb-${stamp}@malformed-body.test`, displayName: "Owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "MB", key: `MB${stamp.slice(0, 4).toUpperCase()}` } })).id;
  objectiveId = (await prisma.objective.create({ data: { orgId, projectId, title: "Objective" } })).id;
  h.ctx = {
    userId: ownerId,
    orgId,
    orgRole: "OWNER",
    permissions: RolePermissions.OWNER,
    basePermissions: RolePermissions.OWNER,
    abacRules: [],
  } satisfies AuthContext;
});

afterAll(async () => {
  await prisma.objective.deleteMany({ where: { orgId } });
  await prisma.label.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

const inOrg = () => ({ params: Promise.resolve({ orgId }) });

describe("a body that isn't JSON is a 400, on every method that takes one", () => {
  it("PUT security settings: valid JSON is applied, a malformed body is a 400", async () => {
    const ok = await putSecuritySettings(send("PUT", JSON.stringify({ sessionTimeoutMinutes: 120 })), inOrg());
    expect(ok.status).toBe(200);
    for (const [, raw] of MALFORMED) await expectInvalidJson(await putSecuritySettings(send("PUT", raw), inOrg()));
  });

  it("POST a label: valid JSON creates it, a malformed body is a 400 and creates nothing", async () => {
    const ok = await createLabel(send("POST", JSON.stringify({ name: `Label ${stamp}` })), inOrg());
    expect(ok.status).toBe(201);
    labelId = (await ok.json()).id;
    for (const [, raw] of MALFORMED) await expectInvalidJson(await createLabel(send("POST", raw), inOrg()));
    expect(await prisma.label.count({ where: { orgId } })).toBe(1);
  });

  it("PATCH a label: valid JSON renames it, a malformed body is a 400 and changes nothing", async () => {
    const at = () => ({ params: Promise.resolve({ orgId, labelId }) });
    const ok = await patchLabel(send("PATCH", JSON.stringify({ name: `Renamed ${stamp}` })), at());
    expect(ok.status).toBe(200);
    for (const [, raw] of MALFORMED) await expectInvalidJson(await patchLabel(send("PATCH", raw), at()));
    expect((await prisma.label.findUniqueOrThrow({ where: { id: labelId } })).name).toBe(`Renamed ${stamp}`);
  });

  it("DELETE an objective link: a body naming the item is read, a malformed body is a 400", async () => {
    const at = () => ({ params: Promise.resolve({ orgId, projectId, objectiveId }) });
    // A well-formed body gets past the read: the route answers about the item.
    const ok = await unlinkObjective(send("DELETE", JSON.stringify({ workItemId: "00000000-0000-4000-8000-000000000000" })), at());
    expect(ok.status).toBe(200);
    for (const [, raw] of MALFORMED) await expectInvalidJson(await unlinkObjective(send("DELETE", raw), at()));
  });
});

describe("a route whose body is optional keeps reading a bad one as empty", () => {
  it("POST mentions/resolve: no body, or one that isn't JSON, resolves nothing, as before", async () => {
    const valid = await resolveMentions(send("POST", JSON.stringify({ refs: [] })), inOrg());
    expect(valid.status).toBe(200);
    for (const [, raw] of MALFORMED) {
      const res = await resolveMentions(send("POST", raw), inOrg());
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: [] });
    }
    const none = await resolveMentions(send("POST", undefined), inOrg());
    expect({ status: none.status, body: await none.json() }).toEqual({ status: 200, body: [] });
  });
});
