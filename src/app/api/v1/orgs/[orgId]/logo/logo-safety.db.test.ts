// @vitest-environment node
//
// The org logo is a file in object storage, named by `settings.logoStorageKey`
// and served with `settings.logoContentType`. Three things must hold, against
// a real database and the local storage adapter (the default):
//
//  1. Only the upload route writes those two settings. The general org update
//     can't, so nobody can point the logo at another file: on the local
//     adapter `../` reached any file on the server, and on S3 another org's
//     objects.
//  2. Even a stored key that does not belong to this org's logo folder is
//     never read or deleted.
//  3. A logo can't run script on the app's origin: SVG is refused at upload,
//     the stored type is checked against what was sniffed, and every logo is
//     served with nosniff and a sandboxing CSP. An SVG stored before this
//     still displays, sandboxed.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { getStorage } from "@/lib/storage";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx }));
// Cache-tag invalidation needs a Next request store this test has no use for.
vi.mock("@/lib/cache/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache/queries")>()),
  revalidateOrg: () => undefined,
}));

import { GET, POST, DELETE } from "./route";
import { PUT as updateOrg } from "../route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", otherOrgId = "", adminId = "";

// A 1x1 PNG: real bytes the sniffer recognises.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>`,
);

const at = (id = orgId) => ({ params: Promise.resolve({ orgId: id }) });
const get = (id = orgId) => GET(new NextRequest(`http://localhost/api/v1/orgs/${id}/logo`), at(id));
function upload(bytes: Buffer, type: string, name: string) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return POST(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/logo`, { method: "POST", body: form }), at());
}
const putOrg = (body: unknown) =>
  updateOrg(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    at(),
  );
const settingsOf = async (id = orgId) =>
  ((await prisma.organization.findUniqueOrThrow({ where: { id } })).settings ?? {}) as Record<string, unknown>;
const setSettings = (settings: Record<string, unknown>, id = orgId) =>
  prisma.organization.update({ where: { id }, data: { settings: settings as Prisma.InputJsonObject } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `logo ${stamp}`, slug: `logo-${stamp}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `other ${stamp}`, slug: `other-${stamp}` } })).id;
  adminId = (await prisma.user.create({ data: { email: `logo-${stamp}@example.com`, displayName: "Admin" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: adminId, role: "ADMIN", permissions: "0" } });
  h.ctx = {
    userId: adminId, orgId, orgRole: "ADMIN", abacRules: [],
    permissions: RolePermissions.ADMIN, basePermissions: RolePermissions.ADMIN,
  } satisfies AuthContext;
  // Another org's logo, sitting in the same storage.
  await getStorage().put(`${otherOrgId}/branding/logo-theirs.png`, PNG, { contentType: "image/png", filename: "logo.png" });
});

afterAll(async () => {
  await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), at()).catch(() => undefined);
  await getStorage().delete(`${otherOrgId}/branding/logo-theirs.png`).catch(() => undefined);
  await getStorage().delete(`${orgId}/branding/logo-legacy.svg`).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
});

describe("the general org update can't set the logo's storage", () => {
  it("refuses settings, and leaves the stored settings as they were", async () => {
    await setSettings({ navLayout: { hidden: ["x"] } });
    const res = await putOrg({
      settings: { logoStorageKey: "../../package.json", logoContentType: "text/plain" },
    });
    expect(res.status).toBe(400);
    expect(await settingsOf()).toEqual({ navLayout: { hidden: ["x"] } });
  });

  it("positive control: a name change still saves, and keeps every settings key", async () => {
    const res = await putOrg({ name: `renamed ${stamp}` });
    expect(res.status).toBe(200);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.name).toBe(`renamed ${stamp}`);
    expect(org.settings).toEqual({ navLayout: { hidden: ["x"] } });
  });
});

describe("a stored key outside this org's logo folder is never used", () => {
  it("does not stream a file outside storage", async () => {
    await setSettings({ logoStorageKey: "../../package.json", logoContentType: "text/plain" });
    const res = await get();
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain('"devDependencies"');
  });

  it("does not stream another org's logo", async () => {
    await setSettings({ logoStorageKey: `${otherOrgId}/branding/logo-theirs.png`, logoContentType: "image/png" });
    expect((await get()).status).toBe(404);
    // Positive control: the object is really there, and its own org can read it.
    await setSettings({ logoStorageKey: `${otherOrgId}/branding/logo-theirs.png`, logoContentType: "image/png" }, otherOrgId);
    h.ctx = { ...(h.ctx as AuthContext), orgId: otherOrgId };
    expect((await get(otherOrgId)).status).toBe(200);
    h.ctx = { ...(h.ctx as AuthContext), orgId };
  });

  it("does not delete another org's logo when a new one replaces the stored key", async () => {
    await setSettings({ logoStorageKey: `${otherOrgId}/branding/logo-theirs.png`, logoContentType: "image/png" });
    expect((await upload(PNG, "image/png", "mine.png")).status).toBe(200);
    expect(await getStorage().stream(`${otherOrgId}/branding/logo-theirs.png`)).not.toBeNull();
  });
});

describe("a logo can't run script", () => {
  it("refuses an SVG upload", async () => {
    const res = await upload(SVG, "image/svg+xml", "logo.svg");
    expect(res.status).toBe(415);
  });

  it("refuses an SVG that claims to be a PNG", async () => {
    const res = await upload(SVG, "image/png", "logo.png");
    expect(res.status).toBe(415);
  });

  it("serves an uploaded PNG as an image, with nosniff and a sandbox", async () => {
    expect((await upload(PNG, "image/png", "logo.png")).status).toBe(200);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="logo\.png"$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("still shows an SVG stored before, sandboxed", async () => {
    const key = `${orgId}/branding/logo-legacy.svg`;
    await getStorage().put(key, SVG, { contentType: "image/svg+xml", filename: "logo.svg" });
    await setSettings({ logoStorageKey: key, logoContentType: "image/svg+xml" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/\bsandbox\b/);
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).not.toMatch(/script-src/);
  });

  it("never serves a stored type that isn't an image as itself", async () => {
    const key = `${orgId}/branding/logo-legacy.svg`;
    await setSettings({ logoStorageKey: key, logoContentType: "text/html" });
    const res = await get();
    expect(res.headers.get("content-type")).not.toMatch(/html/);
    expect(res.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
  });
});
