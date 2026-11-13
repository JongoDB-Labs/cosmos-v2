// @vitest-environment node
//
// The roster against a REAL database. The unit spec beside this mocks Prisma,
// and its mock rows carried an `archivedAt` that Project does not have, so it
// passed while every real call threw a validation error; the agent loop's
// best-effort catch then left the roster out of every run. Only a real query
// can tell a select from a typo.
//
// Own org and own user; the seeded ones are never touched.
//
// Needs the local e2e DB: DATABASE_URL=postgresql://ci:ci@localhost:5441/<db>
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { AuthContext } from "@/lib/rbac/check";
import { projectRosterBlock } from "./project-roster";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const k = stamp.slice(-4).toUpperCase();
let orgId = "", userId = "", liveId = "", oldId = "";
let auth: AuthContext;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `roster ${stamp}`, slug: `roster-${stamp}` } })).id;
  userId = (await prisma.user.create({ data: { email: `roster-${stamp}@example.com`, displayName: "roster" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "ADMIN" } });
  liveId = (await prisma.project.create({ data: { orgId, name: "Live project", key: `RL${k}` } })).id;
  oldId = (await prisma.project.create({ data: { orgId, name: "Old project", key: `RO${k}`, archived: true } })).id;
  auth = (await memberToolCtx(orgId, userId)).auth!;
});

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
});

describe("projectRosterBlock (e2e DB)", () => {
  it("lists the actor's projects from a real query, archived ones labelled", async () => {
    const out = await projectRosterBlock({
      auth, orgId, tenantClass: "commercial", conversationId: `roster-${stamp}`, ceiling: "UNCLASSIFIED",
    });
    expect(out).not.toBeNull();
    expect(out).toContain(`key RL${k}, id ${liveId})`);
    expect(out).toContain(`key RO${k}, id ${oldId}) [archived]`);
    // Control: the live project is not labelled archived.
    expect(out).not.toContain(`key RL${k}, id ${liveId}) [archived]`);
  });
});
