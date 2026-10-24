// @vitest-environment node
//
// /api/v1/admin/updates/deploy — recording an install, and reading the latest.
// DB-free: prisma, requireSystemAdmin and the update check are mocked. The
// prisma mock is a small in-memory table that ENFORCES the single-flight
// partial unique index (one PENDING/RUNNING row), so the 409 here comes from
// the same place it does in production rather than being scripted.
//
// The rules pinned here:
//   - a RUNNING row whose runner died (no heartbeat for 30 minutes) is marked
//     ABANDONED and no longer blocks a new install;
//   - a RUNNING row with a fresh heartbeat still blocks with a 409;
//   - a PENDING row is never abandoned;
//   - reading the latest request retires a dead claim too.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DEPLOY_HEARTBEAT_STALE_MS, UNIQUE_VIOLATION } from "@/lib/updates/deploy-request";
import type { UpdateCheck } from "@/lib/updates/check";

type Row = {
  id: string;
  version: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABANDONED";
  requestedAt: Date;
  requestedByEmail: string;
  claimedAt: Date | null;
  claimedBy: string | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  log: string;
};

const db = vi.hoisted(() => ({ rows: [] as Row[] }));

/** Just enough of Prisma's `where` semantics for the shapes the route emits. */
function matches(where: Record<string, unknown> | undefined, r: Record<string, unknown>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(w, r));
    if (cond === null) return r[k] === null;
    if (typeof cond === "object") {
      const c = cond as { lt?: Date; in?: unknown[] };
      if (c.lt) return r[k] instanceof Date && (r[k] as Date).getTime() < c.lt.getTime();
      if (c.in) return c.in.includes(r[k]);
    }
    return r[k] === cond;
  });
}

const { requireSystemAdmin, checkForUpdates, prisma } = vi.hoisted(() => ({
  requireSystemAdmin: vi.fn(),
  checkForUpdates: vi.fn(),
  prisma: {
    $queryRaw: vi.fn(),
    deployRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/internal/require-system-admin", () => ({ requireSystemAdmin }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/updates/check", async (orig) => ({
  ...(await orig<typeof import("@/lib/updates/check")>()),
  checkForUpdates,
  resolveUpdateConfig: vi.fn(async () => ({})),
}));

import { GET, POST } from "./route";

const VERSION = "9.9.9";
const READY: UpdateCheck = {
  configured: true,
  checkedAt: "2026-10-23T12:00:00.000Z",
  status: { current: "9.9.8", latest: VERSION, newer: [VERSION], updateAvailable: true, ahead: false },
  candidateDigest: `sha256:${"a".repeat(64)}`,
  rebuildAvailable: null,
  candidateTag: `${VERSION}-alpha`,
  preflights: [],
  notes: [],
  notesOmitted: 0,
  applyable: true,
  error: null,
};

const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

function runningRow(over: Partial<Row>): Row {
  return {
    id: "old",
    version: "9.9.8",
    status: "RUNNING",
    requestedAt: ago(DEPLOY_HEARTBEAT_STALE_MS * 3),
    requestedByEmail: "ops@example.com",
    claimedAt: ago(DEPLOY_HEARTBEAT_STALE_MS * 3),
    claimedBy: "host-1",
    heartbeatAt: null,
    finishedAt: null,
    exitCode: null,
    log: "",
    ...over,
  };
}

function post() {
  return POST(
    new NextRequest("http://localhost/api/v1/admin/updates/deploy", {
      method: "POST",
      body: JSON.stringify({ version: VERSION }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [];
  requireSystemAdmin.mockResolvedValue({ id: "u1", email: "admin@example.com" });
  checkForUpdates.mockResolvedValue(READY);

  prisma.deployRequest.updateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = db.rows.filter((r) => matches(where, r));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  );
  prisma.deployRequest.create.mockImplementation(async ({ data }: { data: Partial<Row> }) => {
    // The partial unique index: at most one PENDING/RUNNING row.
    if (db.rows.some((r) => r.status === "PENDING" || r.status === "RUNNING")) {
      throw Object.assign(new Error("Unique constraint failed"), { code: UNIQUE_VIOLATION });
    }
    const row: Row = {
      ...runningRow({}),
      id: "new",
      status: "PENDING",
      requestedAt: new Date(),
      claimedAt: null,
      claimedBy: null,
      ...data,
    } as Row;
    db.rows.push(row);
    return row;
  });
  prisma.deployRequest.findFirst.mockImplementation(
    async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) => {
      const hits = db.rows.filter((r) => matches(where, r));
      if (orderBy) hits.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
      return hits[0] ?? null;
    },
  );
});

describe("POST /admin/updates/deploy — reinstalling a rebuilt image", () => {
  const REBUILT: UpdateCheck = {
    ...READY,
    status: { current: VERSION, latest: VERSION, newer: [], updateAvailable: false, ahead: false },
    rebuildAvailable: true,
  };

  it("records an install of the RUNNING version when the fresh check found it rebuilt (202)", async () => {
    checkForUpdates.mockResolvedValue(REBUILT);
    const res = await post();
    expect(res.status).toBe(202);
    expect(db.rows.find((r) => r.id === "new")).toMatchObject({ version: VERSION, status: "PENDING" });
  });

  it("refuses the running version when nothing was rebuilt (422), and records nothing", async () => {
    checkForUpdates.mockResolvedValue({ ...REBUILT, rebuildAvailable: false });
    const res = await post();
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("no-update");
    expect(db.rows).toEqual([]);
  });
});

describe("POST /admin/updates/deploy — dead claims", () => {
  it("abandons a RUNNING row with a stale heartbeat and records the new install (202)", async () => {
    db.rows.push(runningRow({ heartbeatAt: ago(DEPLOY_HEARTBEAT_STALE_MS + MIN) }));

    const res = await post();

    expect(res.status).toBe(202);
    const old = db.rows.find((r) => r.id === "old")!;
    expect(old.status).toBe("ABANDONED");
    expect(old.finishedAt).toBeInstanceOf(Date);
    expect(db.rows.find((r) => r.id === "new")?.status).toBe("PENDING");
  });

  it("abandons a RUNNING row that never heartbeated once its claim is stale (202)", async () => {
    db.rows.push(runningRow({ heartbeatAt: null, claimedAt: ago(DEPLOY_HEARTBEAT_STALE_MS + MIN) }));

    const res = await post();

    expect(res.status).toBe(202);
    expect(db.rows.find((r) => r.id === "old")!.status).toBe("ABANDONED");
  });

  it("still refuses with 409 while a RUNNING row has a fresh heartbeat", async () => {
    db.rows.push(runningRow({ heartbeatAt: ago(2 * MIN) }));

    const res = await post();

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("already-running");
    const old = db.rows.find((r) => r.id === "old")!;
    expect(old.status).toBe("RUNNING");
    expect(old.finishedAt).toBeNull();
  });

  it("never abandons a PENDING row, however old — it still blocks with 409", async () => {
    db.rows.push(
      runningRow({ status: "PENDING", claimedAt: null, claimedBy: null, requestedAt: ago(DEPLOY_HEARTBEAT_STALE_MS * 10) }),
    );

    const res = await post();

    expect(res.status).toBe(409);
    expect(db.rows.find((r) => r.id === "old")!.status).toBe("PENDING");
  });
});

describe("GET /admin/updates/deploy — dead claims", () => {
  it("shows a dead install as ABANDONED, not still installing", async () => {
    db.rows.push(runningRow({ heartbeatAt: ago(DEPLOY_HEARTBEAT_STALE_MS + MIN) }));

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latest.status).toBe("ABANDONED");
    expect(body.latest.finishedAt).not.toBeNull();
  });

  it("leaves a live install RUNNING", async () => {
    db.rows.push(runningRow({ heartbeatAt: ago(2 * MIN) }));

    const body = await (await GET()).json();

    expect(body.latest.status).toBe("RUNNING");
    expect(body.latest.finishedAt).toBeNull();
  });
});
