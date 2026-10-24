// @vitest-environment node
//
// GET interval detail through its contract, with WHOLE work-item rows: the
// detail embeds the sprint's work items, and a column the WorkItem contract
// doesn't declare is a 500 outside production (respond()). Sprint review loads
// this route, so that 500 is "Failed to load sprint review".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { intervalRow, workItemRow } from "@/lib/openapi/testing/rows";

const h = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { interval: { findFirst: h.findFirst } } }));
vi.mock("@/lib/openapi/org-context", () => ({ orgContext: vi.fn(async () => ({ org: {}, ctx: { userId: "u1" } })) }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead: vi.fn(async () => undefined) }));

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const INTERVAL = "33333333-3333-4333-8333-333333333333";
const ITEM = "66666666-6666-4666-8666-666666666666";
const IMPORTED = { key: "JIRA-12", fields: { summary: "From Jira" } };

/** findFirst as Prisma answers it: every work-item column unless the query omits it. */
function prismaLike(args: { include: { workItems: { omit?: Record<string, boolean> } } }) {
  const item: Record<string, unknown> = {
    ...(workItemRow({ id: ITEM, orgId: ORG, projectId: PROJECT, intervalId: INTERVAL, sourceRecord: IMPORTED }) as Record<string, unknown>),
    _count: { comments: 2 },
  };
  for (const [k, on] of Object.entries(args.include.workItems.omit ?? {})) if (on) delete item[k];
  return Promise.resolve({
    ...intervalRow({ id: INTERVAL, orgId: ORG, projectId: PROJECT }),
    workItems: [item],
    _count: { workItems: 1 },
  });
}

const get = () =>
  GET(new NextRequest(`http://localhost/api/v1/orgs/${ORG}/projects/${PROJECT}/intervals/${INTERVAL}`), {
    params: Promise.resolve({ orgId: ORG, projectId: PROJECT, intervalId: INTERVAL }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.findFirst.mockImplementation(prismaLike);
});

describe("GET interval detail", () => {
  it("answers 200 with whole work-item rows (no undeclared column reaches respond)", async () => {
    const res = await get();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const body = await res.json();
    expect(body.workItems).toHaveLength(1);
    expect(body.workItems[0]._count).toEqual({ comments: 2 });
  });

  it("keeps sourceRecord, which existing clients could read, and never sends searchVector", async () => {
    const [item] = (await (await get()).json()).workItems;
    expect(item.sourceRecord).toEqual(IMPORTED);
    expect(item).not.toHaveProperty("searchVector");
  });
});
