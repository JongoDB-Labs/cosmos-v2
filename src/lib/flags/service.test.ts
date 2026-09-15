// @vitest-environment node
//
// The half that keeps a flag list worth reading.
//
// A rule that only raises produces a screen nobody trusts within a month: the
// alarms outlive the problems. These pin the three behaviours that stop that -
// re-raising updates instead of stacking, the sweep clears what is no longer
// true, and a dismissal survives the rule firing again.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    flag: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { FlagSeverity } from "@prisma/client";

import { raiseFlag, sweepRule, dismissFlag, openFlags } from "./service";

const ORG = "org-1";
const RULE = "finance.burn.over-fee";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.flag.findFirst.mockResolvedValue(null);
  prisma.flag.findMany.mockResolvedValue([]);
  prisma.flag.create.mockResolvedValue({ id: "new" });
  prisma.flag.update.mockResolvedValue({ id: "existing" });
  prisma.flag.updateMany.mockResolvedValue({ count: 0 });
});

describe("raiseFlag", () => {
  it("creates when nothing is standing", async () => {
    await raiseFlag({ orgId: ORG, rule: RULE, severity: "WARNING", title: "t", projectId: "p" });
    expect(prisma.flag.create).toHaveBeenCalledOnce();
    expect(prisma.flag.update).not.toHaveBeenCalled();
  });

  it("updates the standing flag instead of stacking a second", async () => {
    // A rule on a timer must not produce a nightly pile of identical alarms.
    prisma.flag.findFirst.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === "OPEN" ? { id: "existing" } : null,
    );
    await raiseFlag({ orgId: ORG, rule: RULE, severity: "CRITICAL", title: "worse", projectId: "p" });
    expect(prisma.flag.create).not.toHaveBeenCalled();
    expect(prisma.flag.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ severity: "CRITICAL" }) }),
    );
  });

  it("does NOT revive a dismissed flag", async () => {
    // Somebody looked at this exact condition and decided it did not matter.
    // A rule re-raising it nightly is arguing with them, and they cannot win.
    prisma.flag.findFirst.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === "DISMISSED" ? { id: "dismissed" } : null,
    );
    const out = await raiseFlag({ orgId: ORG, rule: RULE, severity: "WARNING", title: "t", projectId: "p" });
    expect(out).toBeNull();
    expect(prisma.flag.create).not.toHaveBeenCalled();
    expect(prisma.flag.update).not.toHaveBeenCalled();
  });

  it("pins every subject column, so an absent one matches NULL and not 'any'", async () => {
    // Prisma reads `undefined` as "do not filter on this column". Let one
    // subject field slip to undefined and the lookup stops being about one
    // subject: raising a flag for project B finds project A's flag and
    // overwrites it, so two projects share one alarm and the second is lost.
    // Every column has to be asserted -- checking three of four is what let
    // this through the first time.
    await raiseFlag({ orgId: ORG, rule: RULE, severity: "INFO", title: "t", projectId: "p" });
    expect(prisma.flag.findFirst.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      rule: RULE,
      status: "DISMISSED",
      projectId: "p",
      userId: null,
      subjectType: null,
      subjectId: null,
    });
  });

  it("an org-level flag with no subject looks for NULL, not for anything", async () => {
    // The case the previous test cannot reach: with `projectId` supplied,
    // `?? null` never fires, so a bug in that fallback hides. An org-wide flag
    // supplies nothing -- and if the fallback yields undefined instead of null,
    // the lookup drops the column entirely and matches the first project flag
    // it finds, quietly turning an org-level alarm into an edit of someone's
    // project alarm.
    await raiseFlag({ orgId: ORG, rule: RULE, severity: "WARNING", title: "org-wide" });
    for (const call of prisma.flag.findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({
        projectId: null,
        userId: null,
        subjectType: null,
        subjectId: null,
      });
    }
    expect(prisma.flag.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: null, userId: null }) }),
    );
  });

  it("keeps two projects' flags apart under the same rule", async () => {
    // The consequence of the above, stated as behaviour: same rule, different
    // project, and the second must not be treated as the first.
    prisma.flag.findFirst.mockImplementation(async ({ where }: { where: { projectId: string | null; status: string } }) =>
      where.status === "OPEN" && where.projectId === "p1" ? { id: "p1-flag" } : null,
    );
    await raiseFlag({ orgId: ORG, rule: RULE, severity: "WARNING", title: "t", projectId: "p2" });
    expect(prisma.flag.update).not.toHaveBeenCalled();
    expect(prisma.flag.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: "p2" }) }),
    );
  });
});

describe("sweepRule", () => {
  const open = [
    { id: "a", projectId: "p1", userId: null, subjectType: null, subjectId: null },
    { id: "b", projectId: "p2", userId: null, subjectType: null, subjectId: null },
    { id: "c", projectId: "p3", userId: null, subjectType: null, subjectId: null },
  ];

  it("resolves the flags whose condition is no longer true", async () => {
    prisma.flag.findMany.mockResolvedValue(open);
    prisma.flag.updateMany.mockResolvedValue({ count: 2 });
    const n = await sweepRule(ORG, RULE, [{ projectId: "p2" }]);
    expect(n).toBe(2);
    expect(prisma.flag.updateMany.mock.calls[0][0].where.id.in.sort()).toEqual(["a", "c"]);
  });

  it("keeps everything when every condition still holds", async () => {
    prisma.flag.findMany.mockResolvedValue(open);
    const n = await sweepRule(ORG, RULE, [{ projectId: "p1" }, { projectId: "p2" }, { projectId: "p3" }]);
    expect(n).toBe(0);
    expect(prisma.flag.updateMany).not.toHaveBeenCalled();
  });

  it("clears the lot when nothing is true any more", async () => {
    prisma.flag.findMany.mockResolvedValue(open);
    prisma.flag.updateMany.mockResolvedValue({ count: 3 });
    expect(await sweepRule(ORG, RULE, [])).toBe(3);
  });

  it("resolves rather than deletes, and credits nobody", async () => {
    // "This was true in March and is not now" is worth keeping, and the
    // condition stopping is not a person resolving it.
    prisma.flag.findMany.mockResolvedValue(open);
    prisma.flag.updateMany.mockResolvedValue({ count: 3 });
    await sweepRule(ORG, RULE, []);
    const data = prisma.flag.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe("RESOLVED");
    expect(data.resolvedById).toBeUndefined();
  });

  it("touches only this rule's flags", async () => {
    prisma.flag.findMany.mockResolvedValue([]);
    await sweepRule(ORG, RULE, []);
    expect(prisma.flag.findMany.mock.calls[0][0].where).toMatchObject({ orgId: ORG, rule: RULE, status: "OPEN" });
  });
});

describe("sweepRule scope", () => {
  const openFlagRows = [
    { id: "a1", projectId: "p1", userId: null, subjectType: null, subjectId: null },
    { id: "b1", projectId: "p2", userId: null, subjectType: null, subjectId: null },
  ];

  it("narrows the candidates to the scope, so an unexamined project is untouched", async () => {
    // The bug this exists to prevent: a rule run for ONE project reports what
    // is live in that project only. Sweeping the whole rule would read every
    // other project's flag as "no longer in keep" and clear it -- silently,
    // and looking exactly like the flags correctly clearing.
    prisma.flag.findMany.mockResolvedValue([openFlagRows[0]]);
    prisma.flag.updateMany.mockResolvedValue({ count: 1 });
    await sweepRule(ORG, RULE, [], { projectId: "p1" });
    expect(prisma.flag.findMany.mock.calls[0][0].where).toMatchObject({
      orgId: ORG,
      rule: RULE,
      status: "OPEN",
      projectId: "p1",
    });
    expect(prisma.flag.updateMany.mock.calls[0][0].where.id.in).toEqual(["a1"]);
  });

  it("without a scope, considers every open flag for the rule", async () => {
    prisma.flag.findMany.mockResolvedValue(openFlagRows);
    prisma.flag.updateMany.mockResolvedValue({ count: 2 });
    await sweepRule(ORG, RULE, []);
    expect(prisma.flag.findMany.mock.calls[0][0].where).not.toHaveProperty("projectId");
    expect(prisma.flag.updateMany.mock.calls[0][0].where.id.in.sort()).toEqual(["a1", "b1"]);
  });

  it("an explicit null scopes to org-level flags rather than meaning 'any'", async () => {
    // `{ projectId: null }` and a missing key are different requests: the first
    // says "only flags attached to no project", the second says "do not narrow".
    prisma.flag.findMany.mockResolvedValue([]);
    await sweepRule(ORG, RULE, [], { projectId: null });
    expect(prisma.flag.findMany.mock.calls[0][0].where.projectId).toBeNull();
  });

  it("scopes by user as well as project", async () => {
    prisma.flag.findMany.mockResolvedValue([]);
    await sweepRule(ORG, RULE, [], { userId: "u1" });
    const where = prisma.flag.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where).not.toHaveProperty("projectId");
  });

  it("still resolves rather than deletes when scoped", async () => {
    prisma.flag.findMany.mockResolvedValue([openFlagRows[0]]);
    prisma.flag.updateMany.mockResolvedValue({ count: 1 });
    await sweepRule(ORG, RULE, [], { projectId: "p1" });
    expect(prisma.flag.updateMany.mock.calls[0][0].data).toMatchObject({ status: "RESOLVED" });
  });
});

describe("dismissFlag", () => {
  it("dismisses an open flag and records who did it", async () => {
    prisma.flag.updateMany.mockResolvedValue({ count: 1 });
    expect(await dismissFlag(ORG, "f1", "user-9")).toBe(true);
    const call = prisma.flag.updateMany.mock.calls[0][0];
    expect(call.where.status).toBe("OPEN");
    expect(call.data).toMatchObject({ status: "DISMISSED", resolvedById: "user-9" });
  });

  it("reports false when there was nothing open to dismiss", async () => {
    prisma.flag.updateMany.mockResolvedValue({ count: 0 });
    expect(await dismissFlag(ORG, "f1", "user-9")).toBe(false);
  });
});

describe("openFlags", () => {
  it("orders worst first", async () => {
    await openFlags(ORG);
    expect(prisma.flag.findMany.mock.calls[0][0].orderBy).toEqual([
      { severity: "desc" },
      { raisedAt: "desc" },
    ]);
  });

  it("severity enum is declared least-worst first, which is what makes desc mean worst-first", () => {
    // Postgres sorts an enum by DECLARATION order, not alphabetically. Reorder
    // these three in schema.prisma and the flag list silently inverts: INFO at
    // the top, CRITICAL buried at the bottom, no error anywhere. Nothing else
    // in the codebase would notice, so this assertion is the alarm.
    expect(Object.keys(FlagSeverity)).toEqual(["INFO", "WARNING", "CRITICAL"]);
  });

  it("narrows to a project when asked, and does not when not", async () => {
    await openFlags(ORG, { projectId: "p1" });
    expect(prisma.flag.findMany.mock.calls[0][0].where).toMatchObject({ status: "OPEN", projectId: "p1" });
    vi.clearAllMocks();
    prisma.flag.findMany.mockResolvedValue([]);
    await openFlags(ORG);
    expect(prisma.flag.findMany.mock.calls[0][0].where).not.toHaveProperty("projectId");
  });
});
