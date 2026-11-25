// @vitest-environment node
//
// The board also loads the project's teams, which inlined each member's
// `data:` avatar: 186 KB of a 195 KB response, and base64 does not compress.
// The list must carry a URL to the avatar endpoint instead, and that URL must
// serve the image.
//
// Against a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { noisePngDataUri } from "@/lib/users/__tests__/noise-png";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET } from "./route";
import { GET as getAvatar } from "../../../users/[userId]/avatar/route";

const stamp = Math.random().toString(36).slice(2, 8);
const PNG = noisePngDataUri(64);
const TEAMS = 3;

let orgId = "", projectId = "", member = "", viewer = "";

const session = (): AuthContext => ({
  userId: viewer, orgId, orgRole: OrgRole.ADMIN, abacRules: [],
  permissions: RolePermissions.ADMIN, basePermissions: RolePermissions.ADMIN,
});

async function list() {
  h.ctx = session();
  const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${projectId}/teams`), {
    params: Promise.resolve({ orgId, projectId }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const body = JSON.parse(text);
  const teams = (body.data ?? body) as Array<{ members: Array<{ userId: string; avatarUrl: string | null }> }>;
  return { text, members: teams.flatMap((t) => t.members) };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `tma ${stamp}`, slug: `tma-${stamp}` } })).id;
  member = (await prisma.user.create({ data: { email: `m-${stamp}@tma.test`, displayName: "Member", avatarUrl: PNG } })).id;
  viewer = (await prisma.user.create({ data: { email: `v-${stamp}@tma.test`, displayName: "Viewer" } })).id;
  const om = (await prisma.orgMember.create({ data: { orgId, userId: member, role: "MEMBER", permissions: "0" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: viewer, role: "ADMIN", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: `tma ${stamp}`, key: `TM${stamp.slice(0, 4).toUpperCase()}` } })).id;
  const pm = (await prisma.projectMember.create({ data: { projectId, orgMemberId: om } })).id;
  for (let n = 1; n <= TEAMS; n++) {
    const team = await prisma.team.create({ data: { orgId, projectId, name: `team ${n}` } });
    await prisma.teamMember.create({ data: { teamId: team.id, projectMemberId: pm } });
  }
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [member, viewer] } } }).catch(() => undefined);
});

describe("the project's teams list does not inline avatar bytes", () => {
  it("sends a URL to the member's own avatar, never the data: URI, and weighs less than one avatar", async () => {
    const { text, members } = await list();
    expect(text).not.toContain("data:");
    expect(text.length).toBeLessThan(PNG.length);
    expect(members).toHaveLength(TEAMS);
    for (const m of members) {
      expect(m.avatarUrl).toMatch(new RegExp(`^/api/v1/orgs/${orgId}/users/${member}/avatar\\?v=[0-9a-f]+$`));
    }
  });

  it("points at a URL that serves the original image", async () => {
    const { members } = await list();
    const src = members[0].avatarUrl!;
    // Follow the URL as emitted: the ids come from it, not from the test.
    const m = /^\/api\/v1\/orgs\/([^/]+)\/users\/([^/]+)\/avatar\?v=[0-9a-f]+$/.exec(src);
    expect(m, src).not.toBeNull();
    h.ctx = session();
    const res = await getAvatar(new NextRequest(`http://localhost${src}`), {
      params: Promise.resolve({ orgId: m![1], userId: m![2] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG.split(",")[1], "base64"))).toBe(true);
  });
});
