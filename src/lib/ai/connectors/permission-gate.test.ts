// @vitest-environment node
//
// SECURITY: connector dispatch decides the Cosmos permission from the caller's
// own AuthContext before any executor runs. Reads need CHAT_USE; writes (send,
// post, create, update, delete; the Nango proxy unless GET/HEAD) also refuse an
// API key. No usable auth, or auth for someone else, refuses everything.
import { describe, it, expect, vi, beforeEach } from "vitest";

const logEgressDecision = vi.hoisted(() => vi.fn());
vi.mock("../egress/audit", () => ({ logEgressDecision }));

import { registerConnector, resetConnectors, executeConnectorTool, connectorPermissionDenial } from "./registry";
import type { ConnectorDescriptor } from "./types";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ran = vi.fn(async (name: string) => ({ ok: name }));
const fixture: ConnectorDescriptor = {
  provider: "fx",
  toolDefs: ["fx_read", "fx_write", "fx_proxy"].map((name) => ({ name, description: name, input_schema: { type: "object", properties: {}, required: [] } })),
  execute: (name) => ran(name),
  egress: {},
  access: {
    fx_read: "read",
    fx_write: "write",
    fx_proxy: (input) => (["GET", "HEAD"].includes(String(input.method ?? "GET").toUpperCase()) ? "read" : "write"),
  },
};

const as = (role: keyof typeof RolePermissions, extra: Partial<AuthContext> = {}): AuthContext =>
  ({ userId: "u", orgId: "o", orgRole: role, permissions: RolePermissions[role], basePermissions: RolePermissions[role], abacRules: [], ...extra }) as AuthContext;
const call = (name: string, auth: AuthContext | undefined, input: Record<string, unknown> = {}) =>
  executeConnectorTool(name, input, {
    orgId: "o", userId: "u", tenantClass: "commercial", conversationId: "c1",
    offered: new Set(["fx_read", "fx_write", "fx_proxy"]), auth: auth as AuthContext,
  });

beforeEach(() => {
  resetConnectors();
  registerConnector(fixture);
  ran.mockClear();
  logEgressDecision.mockClear();
});

const refusedAudited = (toolName: string) =>
  expect(logEgressDecision).toHaveBeenCalledWith(expect.objectContaining({ toolName, decidedBy: "rbac", exposed: false, conversationId: "c1" }));

describe("who may run a connector tool", () => {
  it("a MEMBER (CHAT_USE) may read and write", async () => {
    expect(await call("fx_read", as("MEMBER"))).toEqual({ ok: "fx_read" });
    expect(await call("fx_write", as("MEMBER"))).toEqual({ ok: "fx_write" });
    expect(logEgressDecision).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "GUEST", "BILLING_ADMIN"] as const)("a %s (no CHAT_USE) may not even read; nothing runs", async (role) => {
    expect(await call("fx_read", as(role))).toEqual({ error: "You don't have permission to use fx_read." });
    expect(await call("fx_write", as(role))).toEqual({ error: "You don't have permission to use fx_write." });
    expect(ran).not.toHaveBeenCalled();
    refusedAudited("fx_read");
  });

  it("an API key may read but never write, even with CHAT_USE", async () => {
    const key = as("MEMBER", { isApiKey: true });
    expect(await call("fx_read", key)).toEqual({ ok: "fx_read" });
    expect(await call("fx_write", key)).toEqual({ error: "fx_write changes data outside Cosmos and can't be used with an API key." });
    expect(ran).toHaveBeenCalledTimes(1);
    refusedAudited("fx_write");
  });

  it("an input-dependent tool is judged on this call's input (proxy GET reads, DELETE writes)", async () => {
    const key = as("MEMBER", { isApiKey: true });
    expect(await call("fx_proxy", key, { method: "get" })).toEqual({ ok: "fx_proxy" });
    expect(await call("fx_proxy", key, {})).toEqual({ ok: "fx_proxy" }); // no method ⇒ GET
    expect(await call("fx_proxy", key, { method: "DELETE" })).toMatchObject({ error: expect.stringMatching(/API key/) });
    expect(ran).toHaveBeenCalledTimes(2);
  });
});

describe("fail closed without a usable caller", () => {
  it.each([
    ["no auth", undefined],
    ["auth for another org", as("OWNER", { orgId: "other" })],
    ["auth for another user", as("OWNER", { userId: "someone-else" })],
    ["a non-bigint mask", { ...as("OWNER"), permissions: "999" as unknown as bigint }],
  ])("%s: refused, audited, nothing runs", async (_label, auth) => {
    expect(await call("fx_read", auth as AuthContext)).toEqual({ error: "You don't have permission to use fx_read." });
    expect(ran).not.toHaveBeenCalled();
    refusedAudited("fx_read");
  });

  it("connectorPermissionDenial is null only for a caller who may", () => {
    const ctx = (auth: AuthContext) => ({ orgId: "o", userId: "u", auth });
    expect(connectorPermissionDenial("fx_write", {}, ctx(as("ADMIN")))).toBeNull();
    expect(connectorPermissionDenial("fx_write", {}, ctx(as("VIEWER")))).not.toBeNull();
  });
});
