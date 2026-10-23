import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthContext, findUnique } = vi.hoisted(() => ({ getAuthContext: vi.fn(), findUnique: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma: { organization: { findUnique } } }));

import { orgContext } from "../org-context";
import { ProblemError } from "../problem";

beforeEach(() => vi.clearAllMocks());

describe("orgContext", () => {
  it("resolves the org by id and the caller within it by slug", async () => {
    findUnique.mockResolvedValue({ id: "o1", slug: "acme" });
    getAuthContext.mockResolvedValue({ userId: "u1" });
    expect(await orgContext("o1")).toEqual({ org: { id: "o1", slug: "acme" }, ctx: { userId: "u1" } });
    expect(getAuthContext).toHaveBeenCalledWith("acme");
  });

  it("an unknown org is a 404 problem, before any auth lookup", async () => {
    findUnique.mockResolvedValue(null);
    await expect(orgContext("o1")).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it("no caller is a 401 problem", async () => {
    findUnique.mockResolvedValue({ id: "o1", slug: "acme" });
    getAuthContext.mockResolvedValue(null);
    const err = await orgContext("o1").catch((e) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 401, code: "unauthorized" });
  });
});
