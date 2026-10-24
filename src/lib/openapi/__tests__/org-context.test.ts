import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthContext, findUnique } = vi.hoisted(() => ({ getAuthContext: vi.fn(), findUnique: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma: { organization: { findUnique } } }));

import { orgContext } from "../org-context";
import { ProblemError } from "../problem";

beforeEach(() => vi.clearAllMocks());

describe("orgContext", () => {
  it("resolves the org by id and the caller within it by slug", async () => {
    findUnique.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", slug: "acme" });
    getAuthContext.mockResolvedValue({ userId: "u1" });
    expect(await orgContext("11111111-1111-4111-8111-111111111111")).toEqual({ org: { id: "11111111-1111-4111-8111-111111111111", slug: "acme" }, ctx: { userId: "u1" } });
    expect(getAuthContext).toHaveBeenCalledWith("acme");
  });

  it("an unknown org is a 404 problem, before any auth lookup", async () => {
    findUnique.mockResolvedValue(null);
    await expect(orgContext("11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it("no caller is a 401 problem", async () => {
    findUnique.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", slug: "acme" });
    getAuthContext.mockResolvedValue(null);
    const err = await orgContext("11111111-1111-4111-8111-111111111111").catch((e) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("orgContext: the org id's shape", () => {
  it("a non-UUID org id is a 400, before any lookup", async () => {
    await expect(orgContext("nope")).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
