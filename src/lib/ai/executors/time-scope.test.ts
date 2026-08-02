// @vitest-environment node
//
// The AI's time tool must obey the SAME read rule as GET /time-entries.
//
// That route was fixed in 2.249.22: every member and viewer could enumerate all
// hours AND rates, and it now narrows through `readableTimeUserIds` and strips
// `rate` unless the row is yours or you hold FINANCE_READ. The assistant reads
// the same table through a different door. A rule fixed in one consumer and
// missed in another is the recurring defect shape in this codebase — `voidedAt`
// and `laborCostFor` both went the same way.
//
// TIME_READ is the crux: MEMBER and VIEWER both hold it, so gating on it alone
// and then querying the whole org is not a gate at all.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, loadEffectivePermissions, readableTimeUserIds } = vi.hoisted(
  () => ({
    prisma: { timeEntry: { findMany: vi.fn() } },
    loadEffectivePermissions: vi.fn(),
    readableTimeUserIds: vi.fn(),
  }),
);

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));
vi.mock("@/lib/time/scope", () => ({
  readableTimeUserIds,
  timeUserIdFilter: (allowed: string[] | null) =>
    allowed ? { in: allowed } : undefined,
}));

import { listTimeEntries } from "./time";

const ORG = "org-1";
// Well-formed v4 UUIDs, version and variant nibbles included. The tool's zod
// schema validates `userId` strictly, so a friendly string — or a repeated-digit
// placeholder — is rejected at PARSE time and the scope check is never reached.
// That would be a test passing for entirely the wrong reason.
const ME = "11111111-1111-4111-a111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-a222-222222222222";

/** An ordinary member: TIME_READ (which everyone has), no finance access. */
function asMember() {
  loadEffectivePermissions.mockResolvedValue({
    orgRole: "MEMBER",
    permissions: Permission.TIME_READ,
  });
}

function asFinance() {
  loadEffectivePermissions.mockResolvedValue({
    orgRole: "ADMIN",
    permissions: Permission.TIME_READ | Permission.FINANCE_READ,
  });
}

const ctx = { orgId: ORG, userId: ME };
const lastWhere = () =>
  prisma.timeEntry.findMany.mock.calls.at(-1)?.[0]?.where as Record<
    string,
    unknown
  >;

beforeEach(() => {
  vi.clearAllMocks();
  asMember();
  // The scope helper is the authority on WHOSE rows are readable.
  readableTimeUserIds.mockResolvedValue([ME]);
  prisma.timeEntry.findMany.mockResolvedValue([]);
});

describe("listTimeEntries — read scope", () => {
  it("narrows to the rows this actor may read", async () => {
    // Without this the tool returns every entry in the org to anyone who can
    // open the chat.
    await listTimeEntries({}, ctx);

    expect(readableTimeUserIds).toHaveBeenCalled();
    expect(lastWhere().userId).toEqual({ in: [ME] });
  });

  it("REFUSES to fetch somebody outside that scope on request", async () => {
    // The tool takes a userId, so "show me Alice's hours" is a supported ask.
    // It must be answered against the scope, not instead of it — naming
    // somebody outside it used to substitute their id for the scope filter
    // outright, which is the leak in one line.
    const out = await listTimeEntries({ userId: SOMEONE_ELSE }, ctx);

    expect(out).toEqual({ error: "Access denied by policy" });
    // Denied BEFORE the query, not filtered after it.
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
  });

  it("passes an in-scope userId through", async () => {
    // A supervisor asking about their own report is the whole point of the
    // parameter; narrowing must not break it.
    readableTimeUserIds.mockResolvedValue([ME, SOMEONE_ELSE]);

    await listTimeEntries({ userId: SOMEONE_ELSE }, ctx);

    expect(lastWhere().userId).toEqual(SOMEONE_ELSE);
  });

  it("does not narrow for a TIME_READ_ALL holder", async () => {
    // `readableTimeUserIds` returns null for them, which means no filter.
    readableTimeUserIds.mockResolvedValue(null);

    await listTimeEntries({}, ctx);

    expect(lastWhere().userId).toBeUndefined();
  });
});

describe("listTimeEntries — rate exposure", () => {
  it("STRIPS the rate off someone else's row", async () => {
    // The 2.249.22 leak in one assertion. A member could enumerate everyone's
    // pay rate; `canSeeRate` is own-row-or-FINANCE_READ.
    readableTimeUserIds.mockResolvedValue([ME, SOMEONE_ELSE]);
    prisma.timeEntry.findMany.mockResolvedValue([
      { id: "e1", userId: SOMEONE_ELSE, hours: 3, rate: 125 },
    ]);

    const out = (await listTimeEntries({}, ctx)) as {
      entries: Array<{ rate: number | null }>;
    };

    expect(out.entries[0].rate).toBeNull();
  });

  it("keeps the rate on the actor's OWN row", async () => {
    // The control: stripping everything would be a different bug, and would
    // stop someone checking their own billing.
    prisma.timeEntry.findMany.mockResolvedValue([
      { id: "e1", userId: ME, hours: 3, rate: 90 },
    ]);

    const out = (await listTimeEntries({}, ctx)) as {
      entries: Array<{ rate: number | null }>;
    };

    expect(out.entries[0].rate).toBe(90);
  });

  it("keeps rates for a FINANCE_READ holder", async () => {
    asFinance();
    readableTimeUserIds.mockResolvedValue([ME, SOMEONE_ELSE]);
    prisma.timeEntry.findMany.mockResolvedValue([
      { id: "e1", userId: SOMEONE_ELSE, hours: 3, rate: 125 },
    ]);

    const out = (await listTimeEntries({}, ctx)) as {
      entries: Array<{ rate: number | null }>;
    };

    expect(out.entries[0].rate).toBe(125);
  });
});
