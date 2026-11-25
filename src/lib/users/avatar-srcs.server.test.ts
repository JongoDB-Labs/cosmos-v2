import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prismaUnfiltered: { orgMember: { findMany } } }));

import { avatarSrcs } from "./avatar-srcs.server";
import { avatarSrc } from "./avatar-url.server";

const ORG = "11111111-1111-1111-1111-111111111111";
const MEMBER = "22222222-2222-2222-2222-222222222222";
const GONE = "33333333-3333-3333-3333-333333333333";
const PNG = `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`;
const SVG = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;

beforeEach(() => {
  findMany.mockReset();
});

describe("avatarSrcs", () => {
  it("does not query when no avatar is servable", async () => {
    const out = await avatarSrcs(ORG, [
      { id: MEMBER, avatarUrl: null },
      { id: GONE, avatarUrl: SVG },
      { id: GONE, avatarUrl: "https://cdn.example.com/a.png" },
    ]);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("maps a member's servable avatar to the same URL avatarSrc gives", async () => {
    findMany.mockResolvedValue([{ userId: MEMBER }]);
    const out = await avatarSrcs(ORG, [{ id: MEMBER, avatarUrl: PNG }]);
    expect(out.get(MEMBER)).toBe(avatarSrc(ORG, MEMBER, PNG));
    expect(out.get(MEMBER)).toMatch(new RegExp(`^/api/v1/orgs/${ORG}/users/${MEMBER}/avatar\\?v=`));
  });

  it("leaves out a user with no membership row in this org, so they keep their stored value", async () => {
    findMany.mockResolvedValue([{ userId: MEMBER }]);
    const out = await avatarSrcs(ORG, [{ id: MEMBER, avatarUrl: PNG }, { id: GONE, avatarUrl: PNG }]);
    expect(out.has(GONE)).toBe(false);
    expect(out.has(MEMBER)).toBe(true);
  });

  it("asks once, scoped to this org, with each user once however many rows name them", async () => {
    findMany.mockResolvedValue([{ userId: MEMBER }]);
    await avatarSrcs(ORG, Array.from({ length: 50 }, () => ({ id: MEMBER, avatarUrl: PNG })));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ orgId: ORG, userId: { in: [MEMBER] } });
  });
});
