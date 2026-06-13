// @vitest-environment node
//
// Proves the API-key BEARER path reaches a Files handler: a bearer request whose
// `resolveAuth` yields a ctx with ITEM_CREATE converts a block → item (201), and
// a null `resolveAuth` (bad/expired token) short-circuits to 401 before any
// converter runs. Mock ONLY the I/O boundaries (db, auth resolver, convert lib);
// the route's own auth-gate + dispatch logic runs unmocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
const { resolveAuth, prisma, convertBlockToItem, convertTableToWorkItems } = vi.hoisted(() => ({
  resolveAuth: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    document: { findFirst: vi.fn() },
  },
  convertBlockToItem: vi.fn(),
  convertTableToWorkItems: vi.fn(),
}));

vi.mock("@/lib/auth/api-key", () => ({ resolveAuth }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/files/convert", () => ({ convertBlockToItem, convertTableToWorkItems }));

import { POST } from "./route";

// --- fixtures ----------------------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const DOC_ID = "33333333-3333-3333-3333-333333333333";
// Must be a structurally valid v4 UUID — the convert schema validates blockId
// with z.string().uuid(), which enforces the version + variant nibbles.
const BLOCK_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "55555555-5555-5555-5555-555555555555";

function ctx(): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: Permission.PROJECT_READ | Permission.ITEM_CREATE,
    basePermissions: Permission.PROJECT_READ | Permission.ITEM_CREATE,
    abacRules: [],
  };
}

function bearerRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/orgs/${ORG_ID}/projects/${PROJECT_ID}/documents/${DOC_ID}/convert`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer cosmos_x_y",
        "content-type": "application/json",
      },
      body: JSON.stringify({ blockId: BLOCK_ID, itemType: "ISSUE" }),
    },
  );
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID, docId: DOC_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.document.findFirst.mockResolvedValue({ id: DOC_ID });
  convertBlockToItem.mockResolvedValue({ itemType: "WORK_ITEM", itemId: "item-1" });
});

describe("POST /documents/[docId]/convert — API-key bearer auth", () => {
  it("a bearer request resolving to a ctx with ITEM_CREATE converts the block (201)", async () => {
    resolveAuth.mockResolvedValue(ctx());

    const res = await POST(bearerRequest(), { params });

    expect(res.status).toBe(201);
    expect(resolveAuth).toHaveBeenCalledTimes(1);
    // resolveAuth received the org {id, slug} from prisma.organization.findUnique.
    expect(resolveAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: ORG_ID, slug: "acme" }),
    );
    expect(convertBlockToItem).toHaveBeenCalledTimes(1);
    expect(convertBlockToItem).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        blockId: BLOCK_ID,
        userId: ACTOR_ID,
        itemType: "ISSUE",
      }),
    );
  });

  it("a bearer token that resolveAuth rejects → 401, no convert", async () => {
    resolveAuth.mockResolvedValue(null);

    const res = await POST(bearerRequest(), { params });

    expect(res.status).toBe(401);
    expect(convertBlockToItem).not.toHaveBeenCalled();
  });
});
