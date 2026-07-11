// @vitest-environment node
//
// Token-guarded "Foreman appears down" dead-man's-switch endpoint. Not org-
// scoped and not session-authed — a watchdog calls this with a static shared
// secret, so there's no `getAuthContext` to mock here (unlike the org-scoped
// foreman routes). `notifyOrgOwners` IS mocked: its own fanout behavior is
// covered by delivery-notify.test.ts, and mocking it here keeps this file
// from depending on which real orgs in the shared e2e DB currently have
// `autonomousDelivery.enabled`. Proves:
//   - no FOREMAN_ALERT_TOKEN configured → 503;
//   - a missing or mismatched bearer → 401;
//   - an invalid `check` value → 400;
//   - a valid call inserts a kind:"error" event and calls notifyOrgOwners,
//     and an identical call within the dedupe window returns
//     `{ deduped: true }` without calling notifyOrgOwners again.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { notifyOrgOwners } = vi.hoisted(() => ({ notifyOrgOwners: vi.fn() }));
vi.mock("@/lib/feedback/delivery-notify", () => ({ notifyOrgOwners }));

import { prisma } from "@/lib/db/client";
import { POST as postAlert } from "./alert/route";

const ORIGINAL_TOKEN = process.env.FOREMAN_ALERT_TOKEN;

function req(body: unknown, bearer?: string) {
  return new NextRequest("http://localhost/api/foreman/alert", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(bearer !== undefined ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  });
}

/** The dedupe key (`kind:"error"` + `data.check`) can't be namespaced with a
 *  per-test random stamp — `check` is a closed zod enum — so this file scopes
 *  cleanup to the exact (kind, check) pairs it exercises instead, both before
 *  and after each test (defensive against a prior crashed run leaving a row
 *  inside the 6h dedupe window). */
async function purgeDedupeRows() {
  await prisma.foremanEvent.deleteMany({
    where: { kind: "error", data: { path: ["check"], equals: "stale" } },
  });
}

beforeEach(async () => {
  notifyOrgOwners.mockClear();
  delete process.env.FOREMAN_ALERT_TOKEN;
  await purgeDedupeRows();
});

afterEach(async () => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.FOREMAN_ALERT_TOKEN;
  else process.env.FOREMAN_ALERT_TOKEN = ORIGINAL_TOKEN;
  await purgeDedupeRows();
});

describe("POST /api/foreman/alert", () => {
  it("503s when FOREMAN_ALERT_TOKEN is unset", async () => {
    const res = await postAlert(req({ check: "stale" }, "anything"));
    expect(res.status).toBe(503);
    expect(notifyOrgOwners).not.toHaveBeenCalled();
  });

  it("401s when the bearer token is missing", async () => {
    process.env.FOREMAN_ALERT_TOKEN = "secret-token";
    const res = await postAlert(req({ check: "stale" }));
    expect(res.status).toBe(401);
  });

  it("401s when the bearer token doesn't match", async () => {
    process.env.FOREMAN_ALERT_TOKEN = "secret-token";
    const res = await postAlert(req({ check: "stale" }, "wrong-token"));
    expect(res.status).toBe(401);
  });

  it("400s on an invalid check value", async () => {
    process.env.FOREMAN_ALERT_TOKEN = "secret-token";
    const res = await postAlert(req({ check: "bogus" }, "secret-token"));
    expect(res.status).toBe(400);
  });

  it("400s on a non-ISO lastPassAt (attacker-influencable text is rejected)", async () => {
    process.env.FOREMAN_ALERT_TOKEN = "secret-token";
    const res = await postAlert(req({ check: "stale", lastPassAt: "not-a-date" }, "secret-token"));
    expect(res.status).toBe(400);
    expect(notifyOrgOwners).not.toHaveBeenCalled();
  });

  it("processes the first call, then dedupes an identical check inside the window", async () => {
    process.env.FOREMAN_ALERT_TOKEN = "secret-token";

    const res1 = await postAlert(
      req({ check: "stale", lastPassAt: "2026-07-11T00:00:00.000Z" }, "secret-token"),
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.deduped).toBe(false);
    const callsAfterFirst = notifyOrgOwners.mock.calls.length;

    const event = await prisma.foremanEvent.findFirst({
      where: { kind: "error", data: { path: ["check"], equals: "stale" } },
    });
    expect(event).not.toBeNull();
    expect(event?.severity).toBe("error");
    expect(event?.message).toBe("check: stale — last pass 2026-07-11T00:00:00.000Z");
    expect(event?.orgId).toBeNull();

    const res2 = await postAlert(req({ check: "stale" }, "secret-token"));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.deduped).toBe(true);
    // No NEW notifyOrgOwners calls from the deduped second request.
    expect(notifyOrgOwners.mock.calls.length).toBe(callsAfterFirst);

    const events = await prisma.foremanEvent.findMany({
      where: { kind: "error", data: { path: ["check"], equals: "stale" } },
    });
    expect(events).toHaveLength(1); // the dedup path never inserted a second row
  });
});
