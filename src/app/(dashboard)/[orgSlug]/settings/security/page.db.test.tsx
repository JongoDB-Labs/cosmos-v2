// @vitest-environment node
//
// The Security settings page prefetches its lists on the server and hands them
// to the browser in the page. The SCIM token list must reach the page exactly
// as GET /security/scim-tokens returns it: never the token hash, and only for
// someone who holds SCIM_MANAGE, the bit that route checks. A token's secret is
// shown once, in the response that creates it. Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { DehydratedState } from "@/lib/query/server";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import SecurityPage from "./page";

const stamp = Math.random().toString(36).slice(2, 8);
const HASH = `hash-${stamp}-${"h".repeat(40)}`;
let orgId = "", userId = "";
const slug = `secpg-${stamp}`;

/** The dehydrated query cache the page renders, found by walking its element tree. */
function dehydratedOf(node: ReactNode): DehydratedState | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = dehydratedOf(n);
      if (found) return found;
    }
    return null;
  }
  const el = node as ReactElement<{ state?: DehydratedState; children?: ReactNode }>;
  if (el.props?.state && Array.isArray(el.props.state.queries)) return el.props.state;
  return dehydratedOf(el.props?.children ?? null);
}

function panelProps(node: ReactNode): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.props && "orgId" in el.props) return el.props;
  return panelProps((el.props?.children as ReactNode) ?? null);
}

async function render(permissions: bigint) {
  h.ctx = {
    userId, orgId, orgRole: "MEMBER", abacRules: [],
    permissions, basePermissions: RolePermissions.MEMBER,
  } satisfies AuthContext;
  return SecurityPage({ params: Promise.resolve({ orgSlug: slug }) });
}

const scimQuery = (state: DehydratedState | null) =>
  state?.queries.find((q) => JSON.stringify(q.queryKey) === JSON.stringify(["org", slug, "security", "scim-tokens"]));

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `secpg ${stamp}`, slug } })).id;
  userId = (await prisma.user.create({ data: { email: `secpg-${stamp}@example.com`, displayName: "Sec" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } });
  await prisma.scimToken.create({ data: { orgId, tokenHash: HASH, prefix: "abcd1234", label: "IdP" } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("the Security page's SCIM token list", () => {
  it("carries the tokens for a SCIM manager, without their hash", async () => {
    const page = await render(Permission.SECURITY_MANAGE | Permission.SCIM_MANAGE);
    const q = scimQuery(dehydratedOf(page));
    // Positive control: the list is there, so the absence below means something.
    const rows = q?.state.data as { prefix: string; label: string }[];
    expect(rows).toEqual([expect.objectContaining({ prefix: "abcd1234", label: "IdP" })]);
    expect(JSON.stringify(q)).not.toContain(HASH);
    expect(JSON.stringify(q)).not.toContain("tokenHash");
    expect(panelProps(page)).toMatchObject({ canManageScim: true });
  });

  it("carries no tokens for someone who manages security but not SCIM", async () => {
    const page = await render(Permission.SECURITY_MANAGE);
    const state = dehydratedOf(page);
    // Positive control: the page did prefetch (the settings row at least).
    expect(state?.queries.length).toBeGreaterThan(0);
    expect(scimQuery(state)).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(HASH);
    expect(JSON.stringify(state)).not.toContain("abcd1234");
    expect(panelProps(page)).toMatchObject({ canManageScim: false, canManageSessions: false });
  });
});
