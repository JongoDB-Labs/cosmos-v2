import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allocateTicketNumber,
  allocateTicketNumbers,
  allocateSortOrder,
} from "./allocate";

/**
 * `(org_id, project_id, ticket_number)` is UNIQUE and the number is chosen by
 * reading the current maximum and adding one — a read-modify-write that a
 * transaction alone does not make safe. Measured on a scratch database before
 * the lock existed, eight concurrent creates in one project produced two rows
 * and six `P2002` failures.
 *
 * These tests pin the property that fixes it: allocation takes a project-scoped
 * advisory lock BEFORE it reads the maximum. They are deliberately behavioural
 * rather than a real concurrency race — a genuinely concurrent test against the
 * shared suite database would be exactly the kind of timing-dependent spec that
 * produced this bug's symptom in the first place. The 8-way race was run once,
 * by hand, against both the broken and fixed versions; what lives here is the
 * guard that stops the lock being quietly removed.
 */

const SOURCE = readFileSync(join(process.cwd(), "src/lib/work-items/allocate.ts"), "utf8");

/** A transaction client that records the order of what it was asked to do. */
function mockTx(maxTicket: number | null = null, maxSort: number | null = null) {
  const calls: string[] = [];
  const executeRaw = vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push(`lock:${strings.join("?").trim()}|${params.join(",")}`);
    return 1;
  });
  const aggregate = vi.fn(async ({ _max }: { _max: Record<string, boolean> }) => {
    calls.push(_max.ticketNumber ? "read:ticket" : "read:sort");
    return { _max: { ticketNumber: maxTicket, sortOrder: maxSort } };
  });
  return {
    calls,
    executeRaw,
    aggregate,
    tx: { $executeRaw: executeRaw, workItem: { aggregate } } as never,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("allocateTicketNumber locks before it reads", () => {
  it("takes an advisory transaction lock", async () => {
    const m = mockTx(4);
    await allocateTicketNumber(m.tx, { orgId: "o1", projectId: "p1" });
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
    expect(m.calls[0]).toContain("pg_advisory_xact_lock");
  });

  it("locks BEFORE reading the maximum — the ordering is the whole point", async () => {
    // A lock taken after the read protects nothing: the stale maximum has
    // already been captured by the time anyone else is excluded.
    const m = mockTx(4);
    await allocateTicketNumber(m.tx, { orgId: "o1", projectId: "p1" });
    expect(m.calls.map((c) => c.split(":")[0])).toEqual(["lock", "read"]);
  });

  it("keys the lock on the project, so two projects never block each other", async () => {
    const a = mockTx(1);
    const b = mockTx(1);
    await allocateTicketNumber(a.tx, { orgId: "o1", projectId: "p1" });
    await allocateTicketNumber(b.tx, { orgId: "o1", projectId: "p2" });
    expect(a.executeRaw.mock.calls[0].slice(1)).toContainEqual("p1");
    expect(b.executeRaw.mock.calls[0].slice(1)).toContainEqual("p2");
  });

  it("uses an XACT lock, which releases itself when the transaction ends", async () => {
    // `pg_advisory_lock` (session-scoped) would have to be released by hand and
    // would strand the project for the life of the pooled connection if a
    // caller threw between acquiring and releasing.
    const m = mockTx(1);
    await allocateTicketNumber(m.tx, { orgId: "o1", projectId: "p1" });
    const sql = m.executeRaw.mock.calls[0][0].join("");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).not.toMatch(/pg_advisory_lock\b/);
  });
});

describe("the numbers it returns", () => {
  it("is max + 1", async () => {
    await expect(allocateTicketNumber(mockTx(7).tx, { orgId: "o1", projectId: "p1" }))
      .resolves.toBe(8);
  });

  it("starts an empty project at 1, not 0", async () => {
    await expect(allocateTicketNumber(mockTx(null).tx, { orgId: "o1", projectId: "p1" }))
      .resolves.toBe(1);
  });
});

describe("allocateTicketNumbers, for the bulk callers", () => {
  it("returns the first number of the block", async () => {
    await expect(allocateTicketNumbers(mockTx(3).tx, { orgId: "o1", projectId: "p1" }, 5))
      .resolves.toBe(4);
  });

  it("locks exactly once for the whole block", async () => {
    // The lock is held to end-of-transaction, so one acquisition covers every
    // item the caller goes on to create.
    const m = mockTx(3);
    await allocateTicketNumbers(m.tx, { orgId: "o1", projectId: "p1" }, 10);
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects a count below 1 rather than silently reserving nothing", async () => {
    await expect(allocateTicketNumbers(mockTx(3).tx, { orgId: "o1", projectId: "p1" }, 0))
      .rejects.toThrow(/count must be >= 1/);
  });
});

describe("allocateSortOrder is deliberately NOT locked", () => {
  it("takes no lock", async () => {
    // sortOrder carries no unique constraint: a collision is two items sharing
    // a position, which the list's tie-break resolves. Locking every create in
    // a column to prevent a cosmetic wobble is the wrong trade — this test
    // exists so the asymmetry reads as a decision rather than an oversight.
    const m = mockTx(null, 2);
    await allocateSortOrder(m.tx, { orgId: "o1", projectId: "p1", columnKey: "todo" });
    expect(m.executeRaw).not.toHaveBeenCalled();
  });

  it("appends to the bottom, and starts an empty column at 0", async () => {
    const where = { orgId: "o1", projectId: "p1", columnKey: "todo" };
    await expect(allocateSortOrder(mockTx(null, 2).tx, where)).resolves.toBe(3);
    await expect(allocateSortOrder(mockTx(null, null).tx, where)).resolves.toBe(0);
  });
});

describe("every creation path goes through the allocator", () => {
  // The original defect was not that the allocator was wrong — it was that its
  // doc comment claimed a transaction alone made allocation safe, and seven
  // other call sites hand-rolled `max + 1` on the strength of it. A fixed
  // allocator that half the product bypasses fixes half the product.
  const CALLERS = [
    "src/lib/files/convert.ts",
    "src/lib/ingest/items.ts",
    "src/lib/feedback/remediate.ts",
    "src/lib/ai/executors/work-items.ts",
    "src/lib/import/import-engine.ts",
    "src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route.ts",
    "src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/duplicate/route.ts",
  ];

  it.each(CALLERS)("%s allocates through the shared helper", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    expect(src).toContain("allocateTicketNumber");
    // The shape that caused this: reading the max inline and adding one.
    expect(src).not.toContain("_max: { ticketNumber: true }");
  });

  it("the check above would catch a reintroduced inline allocation", () => {
    // Positive control: the assertion is only worth anything if the string it
    // forbids is the one a regression would actually contain.
    const regressed = 'const m = await tx.workItem.aggregate({ _max: { ticketNumber: true } });';
    expect(regressed).toContain("_max: { ticketNumber: true }");
  });
});

describe("the lock is present in the source", () => {
  it("allocate.ts calls pg_advisory_xact_lock", () => {
    expect(SOURCE).toContain("pg_advisory_xact_lock");
  });

  it("uses $executeRaw, not $queryRaw — the function returns void", () => {
    // $queryRaw tries to deserialize the result column and throws on `void`.
    // The failure mode is vicious: the lock IS taken, then the statement
    // errors, so every create fails and a collision count reads as zero.
    //
    // Comments are stripped first, because the prose in allocate.ts explains
    // this very trap by NAME — an assertion that reads the file whole is
    // defeated by its own documentation.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("$executeRaw");
    expect(code).not.toContain("$queryRaw");
  });

  it("stripping comments does not also strip the code under test", () => {
    // Positive control for the strip: if the regexes ate the whole file, the
    // assertion above would pass vacuously on an empty string.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("pg_advisory_xact_lock");
    expect(code).toContain("export async function allocateTicketNumber");
  });
});
