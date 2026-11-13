// @vitest-environment node
//
// An org's MCP servers are managed on a page only MCP_MANAGE opens; the API
// that page reads must hold the same line, and never send a server's sealed
// env or headers (API tokens, auth headers) back out, to anyone. Against a
// real database.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma } from "@/lib/db/client";
import { RolePermissions, Permission } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import * as list from "./route";
import * as byId from "./[serverId]/route";
import { sealMcpJson } from "@/lib/integrations/mcp-secrets";

const VAULT = process.env.SSO_VAULT_KEY;
process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", userId = "", serverId = "";
let envEnc = "", headersEnc = "";

const owner = (): AuthContext => ({
  userId, orgId, orgRole: OrgRole.OWNER, abacRules: [],
  permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
});
/** A member: reads the org, doesn't manage its MCP servers. */
const member = (): AuthContext => {
  const p = RolePermissions.MEMBER & ~Permission.MCP_MANAGE;
  return { userId, orgId, orgRole: OrgRole.MEMBER, abacRules: [], permissions: p, basePermissions: p };
};

function req(body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/mcp-servers`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}
const at = () => ({ params: Promise.resolve({ orgId }) });
const atOne = () => ({ params: Promise.resolve({ orgId, serverId }) });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `mcp ${stamp}`, slug: `mcp-${stamp}` } })).id;
  userId = (await prisma.user.create({ data: { email: `o-${stamp}@mcp.test`, displayName: "Owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "OWNER", permissions: "0" } });
  envEnc = sealMcpJson({ API_TOKEN: `tok-${stamp}` })!;
  headersEnc = sealMcpJson({ Authorization: `Bearer hdr-${stamp}` })!;
  serverId = (await prisma.mcpServer.create({
    data: { orgId, name: `Tracker ${stamp}`, transport: "http", url: "https://mcp.example.com/sse", envEnc, headersEnc },
  })).id;
});

afterAll(async () => {
  await prisma.mcpServer.deleteMany({ where: { orgId } });
  // Audit rows are append-only, so an org that wrote some may not delete.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  if (VAULT === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = VAULT;
});

describe("reading MCP servers needs MCP_MANAGE", () => {
  it("a member who can't manage them can't list them", async () => {
    h.ctx = member();
    const res = await list.GET(req(), at());
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(`Tracker ${stamp}`);
  });

  it("nor read one", async () => {
    h.ctx = member();
    const res = await byId.GET(req(), atOne());
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(`Tracker ${stamp}`);
  });

  it("an owner lists and reads them (positive control)", async () => {
    h.ctx = owner();
    expect(await (await list.GET(req(), at())).text()).toContain(`Tracker ${stamp}`);
    expect(await (await byId.GET(req(), atOne())).text()).toContain(`Tracker ${stamp}`);
  });
});

describe("no response carries the sealed env or headers", () => {
  const SEALED_KEYS = ["envEnc", "headersEnc"];
  function clean(text: string) {
    expect(text).not.toContain(envEnc);
    expect(text).not.toContain(headersEnc);
    expect(text).not.toContain(`tok-${stamp}`);
    expect(text).not.toContain(`hdr-${stamp}`);
    const body = JSON.parse(text) as Record<string, unknown> | Record<string, unknown>[];
    for (const row of Array.isArray(body) ? body : [body]) {
      for (const k of SEALED_KEYS) expect(Object.keys(row)).not.toContain(k);
      expect(row.name).toBeTruthy(); // positive control: it IS the server
    }
  }

  it("list", async () => {
    h.ctx = owner();
    const res = await list.GET(req(), at());
    expect(res.status).toBe(200);
    clean(await res.text());
  });

  it("read one", async () => {
    h.ctx = owner();
    const res = await byId.GET(req(), atOne());
    expect(res.status).toBe(200);
    clean(await res.text());
  });

  it("edit", async () => {
    h.ctx = owner();
    const res = await byId.PATCH(req({ name: `Tracker ${stamp}` }), atOne());
    expect(res.status).toBe(200);
    clean(await res.text());
    // The edit kept the secrets it didn't touch.
    const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(row.envEnc).toBe(envEnc);
  });

  it("create", async () => {
    h.ctx = owner();
    const res = await list.POST(
      req({ name: `New ${stamp}`, transport: "http", url: "https://mcp2.example.com/sse", env: { API_TOKEN: `tok-${stamp}` }, headers: { Authorization: `Bearer hdr-${stamp}` } }),
      at(),
    );
    expect(res.status).toBe(201);
    clean(await res.text());
    const created = await prisma.mcpServer.findFirstOrThrow({ where: { orgId, name: `New ${stamp}` } });
    expect(created.envEnc).toBeTruthy(); // sealed and stored
  });
});

describe("a server URL is an endpoint Cosmos would call", () => {
  it.each(["http://169.254.169.254/latest/", "http://metadata.google.internal/", "http://[fd00:ec2::254]/", "http://10.0.0.5/sse", "http://localhost:3000/sse"])(
    "refuses to create one at %s",
    async (url) => {
      vi.stubEnv("OUTBOUND_ALLOW_PRIVATE_CIDRS", "");
      h.ctx = owner();
      const res = await list.POST(req({ name: `Bad ${stamp}`, transport: "http", url }), at());
      expect(res.status).toBe(400);
      expect(await prisma.mcpServer.count({ where: { orgId, name: `Bad ${stamp}` } })).toBe(0);
      vi.unstubAllEnvs();
    },
  );

  it("refuses to move one to a metadata address, and keeps the old URL", async () => {
    h.ctx = owner();
    const res = await byId.PATCH(req({ url: "http://169.254.169.254/latest/" }), atOne());
    expect(res.status).toBe(400);
    expect((await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).url).toBe("https://mcp.example.com/sse");
  });

  it("accepts a private address inside the operator's ranges (control)", async () => {
    vi.stubEnv("OUTBOUND_ALLOW_PRIVATE_CIDRS", "10.0.0.0/8");
    h.ctx = owner();
    const res = await list.POST(req({ name: `Private ${stamp}`, transport: "http", url: "http://10.0.0.5/sse" }), at());
    expect(res.status).toBe(201);
    vi.unstubAllEnvs();
  });
});
