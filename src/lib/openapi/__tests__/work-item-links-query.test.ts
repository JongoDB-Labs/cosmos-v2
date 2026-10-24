// @vitest-environment node
//
// The links list's `?item=` filter reads as it did before contracts: blank is
// no filter, a repeated one is its first value; a malformed id is a 400 (it
// used to reach Prisma as a 500).
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { parseRequest } from "../respond";
import { handleApiError } from "@/lib/api-helpers";
import { listWorkItemLinks } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-item-links/route.contract";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const list = (qs: string) =>
  parseRequest(listWorkItemLinks, new NextRequest(`http://localhost/x?${qs}`), Promise.resolve({ orgId: ORG, projectId: ID }));
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => handleApiError(e).status);

describe("listWorkItemLinks ?item=", () => {
  it.each([["", {}], ["item=", { item: "" }], [`item=${ID}`, { item: ID }], [`item=${ID}&item=bad`, { item: ID }]])(
    "?%s reads as %o",
    async (qs, want) => {
      expect((await list(qs)).query).toMatchObject(want);
    },
  );

  it("a malformed id is a 400", async () => {
    expect(await status(list("item=bad"))).toBe(400);
  });
});
