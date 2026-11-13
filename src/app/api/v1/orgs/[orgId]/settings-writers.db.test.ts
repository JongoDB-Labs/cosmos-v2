// @vitest-environment node
//
// Organization.settings is one JSON object shared by many features, and some
// of them gate who may change them: turning feedback automation on is the
// instance operator's call (see automation-operator.server.ts). A route that
// reads the whole object, changes its own key in memory and writes the whole
// object back puts every OTHER key back as it was when it read, so it can
// quietly undo an operator turning automation off, with no audit row.
//
// Each route here writes only its own key. The test changes the automation
// config in the middle of each request, after the route has read the org and
// before it writes (the auth lookup sits in that window), and checks the
// change survives alongside the route's own write.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown, midRequest: null as null | (() => Promise<void>), ran: 0 }));
vi.mock("@/lib/auth/session", () => ({
  getAuthContext: async () => {
    if (h.midRequest) {
      const change = h.midRequest;
      h.midRequest = null;
      h.ran += 1;
      await change();
    }
    return h.ctx;
  },
}));
// Object storage is not under test; the logo routes only need it to succeed.
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ put: async () => undefined, delete: async () => undefined, stream: async () => null }),
}));
vi.mock("@/lib/cache/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache/queries")>()),
  revalidateOrg: () => undefined,
}));

import { PUT as putNavLayout } from "./nav-layout/route";
import { PUT as putCalendarFeeds } from "./calendar-feeds/settings/route";
import { POST as uploadLogo, DELETE as deleteLogo } from "./logo/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "";
let ownerId = "";
const projectId = "00000000-0000-4000-8000-000000000001";

// A 1x1 PNG the sniffer recognises.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const at = () => ({ params: Promise.resolve({ orgId }) });
const json = (path: string, method: string, body: unknown) =>
  new NextRequest(`http://localhost/api/v1/orgs/${orgId}/${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

type Settings = Record<string, unknown> & { autonomousDelivery?: { enabled?: boolean } };
const settings = async () => ((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).settings ?? {}) as Settings;
const setSettings = (value: Record<string, unknown>) =>
  prisma.organization.update({ where: { id: orgId }, data: { settings: value as object } });

/** The operator turns delivery off, as the automation config route would. */
async function operatorTurnsDeliveryOff() {
  const current = await settings();
  await setSettings({ ...current, autonomousDelivery: { ...current.autonomousDelivery, enabled: false } });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `sw ${stamp}`, slug: `sw-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `sw-${stamp}@settings-writers.test`, displayName: "Owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  h.ctx = {
    userId: ownerId,
    orgId,
    orgRole: "OWNER",
    permissions: RolePermissions.OWNER,
    basePermissions: RolePermissions.OWNER,
    abacRules: [],
  } satisfies AuthContext;
});

afterAll(async () => {
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

beforeEach(async () => {
  h.ran = 0;
  h.midRequest = operatorTurnsDeliveryOff;
  await setSettings({
    unrelated: { keep: "me" },
    autonomousDelivery: { enabled: true, projectIds: [projectId], notify: { parked: true, shipped: true }, workers: 2 },
    logoStorageKey: `${orgId}/branding/logo-old.png`,
    logoContentType: "image/png",
  });
});

/** The mid-request change ran, survived, and nothing else was lost. */
async function expectOperatorChangeKept(res: Response) {
  expect(h.ran).toBe(1);
  expect(res.status).toBeLessThan(300);
  const after = await settings();
  expect(after.autonomousDelivery?.enabled).toBe(false);
  expect(after.unrelated).toEqual({ keep: "me" });
  return after;
}

describe("settings writers change only their own key", () => {
  it("nav layout: hiding a section keeps a turn-off made during the request", async () => {
    const after = await expectOperatorChangeKept(await putNavLayout(json("nav-layout", "PUT", { hidden: ["docs"] }), at()));
    expect((after.navLayout as { hidden?: string[] }).hidden).toEqual(["docs"]);
  });

  it("calendar feeds: switching feeds on keeps a turn-off made during the request", async () => {
    const after = await expectOperatorChangeKept(
      await putCalendarFeeds(json("calendar-feeds/settings", "PUT", { enabled: true }), at()),
    );
    expect((after.calendarFeeds as { enabled?: boolean }).enabled).toBe(true);
  });

  it("logo upload: a new logo keeps a turn-off made during the request", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(PNG)], "logo.png", { type: "image/png" }));
    const res = await uploadLogo(
      new NextRequest(`http://localhost/api/v1/orgs/${orgId}/logo`, { method: "POST", body: form }),
      at(),
    );
    const after = await expectOperatorChangeKept(res);
    expect(after.logoStorageKey).toMatch(new RegExp(`^${orgId}/branding/logo-.+\\.png$`));
    expect(after.logoStorageKey).not.toBe(`${orgId}/branding/logo-old.png`);
    expect(after.logoContentType).toBe("image/png");
  });

  it("logo removal: removing the logo keeps a turn-off made during the request", async () => {
    const res = await deleteLogo(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/logo`, { method: "DELETE" }), at());
    const after = await expectOperatorChangeKept(res);
    expect(after.logoStorageKey).toBeUndefined();
    expect(after.logoContentType).toBeUndefined();
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).logoUrl).toBeNull();
  });
});
