// @vitest-environment node
//
// The avatar endpoint serves image bytes for one user, so that payloads naming
// that user can carry a URL instead of an inline `data:` URI. Two properties
// are easy to get wrong and are what this file exists for:
//
//   1. the orgId in the path must gate the SUBJECT, not only the caller —
//      otherwise a member of any org reads any user's avatar by guessing an id;
//   2. a REMOVED member's avatar must still resolve, because their name and
//      face remain on the comments and history they left behind.
//
// Against a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
const PNG = `data:image/png;base64,${Buffer.from("PNG-BYTES").toString("base64")}`;
const SVG = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)/>").toString("base64")}`;

let orgA = "", orgB = "";
let withAvatar = "", removed = "", noAvatar = "", svgAvatar = "", outsider = "", offProject = "";
let projectA = "";

const mkUser = async (name: string, avatarUrl: string | null) =>
  (await prisma.user.create({ data: { email: `${name}-${stamp}@av.test`, displayName: name, avatarUrl } })).id;

const caller = (userId: string, orgId: string): AuthContext => ({
  userId, orgId, orgRole: "MEMBER", abacRules: [], basePermissions: 0n, permissions: 0n,
});
const at = (orgId: string, userId: string) => ({ params: Promise.resolve({ orgId, userId }) });
const req = () => new Request("http://localhost/x") as never;

beforeAll(async () => {
  orgA = (await prisma.organization.create({ data: { name: `av-a ${stamp}`, slug: `av-a-${stamp}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `av-b ${stamp}`, slug: `av-b-${stamp}` } })).id;

  withAvatar = await mkUser("WithAvatar", PNG);
  removed = await mkUser("Removed", PNG);
  noAvatar = await mkUser("NoAvatar", null);
  svgAvatar = await mkUser("SvgAvatar", SVG);
  outsider = await mkUser("Outsider", PNG);
  offProject = await mkUser("OffProject", PNG);

  const memberships: Record<string, string> = {};
  for (const userId of [withAvatar, noAvatar, svgAvatar, offProject]) {
    memberships[userId] = (
      await prisma.orgMember.create({ data: { orgId: orgA, userId, role: "MEMBER", permissions: "0" } })
    ).id;
  }
  // withAvatar is on projectA; offProject is in the org but on no project, so a
  // key scoped to projectA must not see them.
  projectA = (await prisma.project.create({ data: { orgId: orgA, name: "A", key: `AV${stamp.slice(0, 3).toUpperCase()}` } })).id;
  await prisma.projectMember.create({ data: { projectId: projectA, orgMemberId: memberships[withAvatar] } });
  await prismaUnfiltered.orgMember.create({
    data: { orgId: orgA, userId: removed, role: "MEMBER", permissions: "0", removedAt: new Date() },
  });
  await prisma.orgMember.create({ data: { orgId: orgB, userId: outsider, role: "MEMBER", permissions: "0" } });
});

afterAll(async () => {
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [withAvatar, removed, noAvatar, svgAvatar, outsider, offProject] } } });
});

describe("avatar endpoint", () => {
  it("serves the decoded bytes, typed, sniff-proofed and immutably cacheable", async () => {
    h.ctx = caller(withAvatar, orgA);
    const res = await GET(req(), at(orgA, withAvatar));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("PNG-BYTES");
  });

  it("refuses a caller with no session for this org", async () => {
    h.ctx = null;
    expect((await GET(req(), at(orgA, withAvatar))).status).toBe(401);
  });

  it("will not serve a user who belongs to a DIFFERENT org, even to a valid caller", async () => {
    h.ctx = caller(withAvatar, orgA);
    expect((await GET(req(), at(orgA, outsider))).status).toBe(404);
    // ...and the same subject does resolve through the org they are in.
    h.ctx = caller(outsider, orgB);
    expect((await GET(req(), at(orgB, outsider))).status).toBe(200);
  });

  it("still serves a REMOVED member, whose face remains on their old comments", async () => {
    h.ctx = caller(withAvatar, orgA);
    const res = await GET(req(), at(orgA, removed));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("PNG-BYTES");
  });

  it("404s a member with no avatar", async () => {
    h.ctx = caller(withAvatar, orgA);
    expect((await GET(req(), at(orgA, noAvatar))).status).toBe(404);
  });

  it("refuses an svg avatar rather than serve script from our own origin", async () => {
    h.ctx = caller(withAvatar, orgA);
    expect((await GET(req(), at(orgA, svgAvatar))).status).toBe(404);
  });

  // The contract declares `scopes: ["read"]`. That is only worth declaring if
  // the handler routes through orgContext, which is what asserts it.
  it("lets in an API key holding `read`, the same scope that reads the members list", async () => {
    h.ctx = { ...caller(withAvatar, orgA), isApiKey: true, scopes: ["read"] };
    expect((await GET(req(), at(orgA, withAvatar))).status).toBe(200);
  });

  it("refuses an API key without `read`, rather than declaring a scope it never checks", async () => {
    h.ctx = { ...caller(withAvatar, orgA), isApiKey: true, scopes: ["members:read"] };
    expect((await GET(req(), at(orgA, withAvatar))).status).toBe(403);
  });

  // listMembers narrows its roster for a project-scoped key, and this endpoint
  // serves the URLs that list hands out. If only the list narrowed, it would
  // hide a colleague while this served their face.
  it("applies the same project-scope narrowing the members list does", async () => {
    const scopedKey = {
      ...caller(withAvatar, orgA),
      orgRole: "OWNER" as const,
      permissions: Permission.PROJECT_READ | Permission.ITEM_READ,
      isApiKey: true,
      scopes: ["read"],
      projectScope: [projectA],
    };
    h.ctx = scopedKey;
    // on the key's project: visible
    expect((await GET(req(), at(orgA, withAvatar))).status).toBe(200);
    // in the org but outside the key's projects: not disclosed
    expect((await GET(req(), at(orgA, offProject))).status).toBe(404);
  });

  it("404s an org that does not exist", async () => {
    h.ctx = caller(withAvatar, orgA);
    expect((await GET(req(), at("00000000-0000-0000-0000-000000000000", withAvatar))).status).toBe(404);
  });
});
