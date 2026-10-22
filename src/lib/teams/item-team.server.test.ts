// COSMOS-204, server side: the create and update APIs ask teamProjectError
// before writing an item's team, so no request can file work under a team
// from another project.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { team: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { teamProjectError, TEAM_NOT_IN_PROJECT_MESSAGE } from "./item-team.server";

beforeEach(() => vi.clearAllMocks());

describe("teamProjectError", () => {
  it("accepts a team from the item's own project", async () => {
    prisma.team.findFirst.mockResolvedValue({ id: "t1" });
    expect(await teamProjectError({ projectId: "p1", teamId: "t1" })).toBeNull();
    expect(prisma.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1", projectId: "p1" } }),
    );
  });

  it("rejects a team that isn't in the project", async () => {
    prisma.team.findFirst.mockResolvedValue(null);
    expect(await teamProjectError({ projectId: "p1", teamId: "elsewhere" })).toBe(
      TEAM_NOT_IN_PROJECT_MESSAGE,
    );
  });

  it("lets a team be left out or cleared without a lookup", async () => {
    expect(await teamProjectError({ projectId: "p1", teamId: null })).toBeNull();
    expect(await teamProjectError({ projectId: "p1", teamId: undefined })).toBeNull();
    expect(prisma.team.findFirst).not.toHaveBeenCalled();
  });
});
