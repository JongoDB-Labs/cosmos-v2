// @vitest-environment node
//
// The project import door refuses an ORG-scoped entity.
//
// `ENTITY_DEFS` is one registry serving two doors, and this route's zod schema
// accepts every key in it. Registering the first org-scoped entity therefore
// made "Program Calendar" postable here — where it would be handed a project
// id for records that have no project. The wizard no longer offers the card,
// but a card is not a guard: the request is a POST anyone can repeat.
//
// DB-free: prisma, auth and the engine are mocked, so what runs is exactly the
// route's own decision.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getAuthContext, canManageProject, runEntityImport, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  canManageProject: vi.fn(),
  runEntityImport: vi.fn(),
  prisma: {
    organization: { findFirst: vi.fn() },
    project: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/scope", () => ({ canManageProject }));
vi.mock("@/lib/import/entity-import", () => ({ runEntityImport }));

import { POST } from "./route";

const params = Promise.resolve({ orgId: "alpha", projectId: "ALPHA" });

const post = (entity: string) =>
  POST(
    new NextRequest("http://localhost:3000/api/v1/orgs/alpha/projects/ALPHA/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity,
        mode: "validate",
        mapping: { Title: "title" },
        rows: [{ Title: "anything" }],
      }),
    }),
    { params },
  );

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findFirst.mockResolvedValue({ id: "org-1", slug: "alpha" });
  prisma.project.findFirst.mockResolvedValue({ id: "proj-1" });
  getAuthContext.mockResolvedValue({ orgId: "org-1", userId: "user-1", permissions: 0n });
  canManageProject.mockResolvedValue(true);
  runEntityImport.mockResolvedValue({ total: 1, willCreate: 1, willUpdate: 0, skipped: 0, errors: [] });
});

describe("POST project import — entity scope", () => {
  it("runs a project-scoped entity, with the acting user", async () => {
    // The positive control. Without it, a route broken anywhere earlier would
    // "pass" the refusal below for the wrong reason.
    const res = await post("deliverable");

    expect(res.status).toBe(200);
    expect(runEntityImport).toHaveBeenCalledTimes(1);
    expect(runEntityImport.mock.calls[0][0]).toEqual({
      orgId: "org-1",
      projectId: "proj-1",
      userId: "user-1",
    });
  });

  it("refuses an org-scoped entity with a 409, and writes nothing", async () => {
    const res = await post("programEvent");

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/whole organisation/i);
    expect(runEntityImport).not.toHaveBeenCalled();
  });
});
