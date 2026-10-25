// @vitest-environment node
//
// /api/v1/admin/updates/settings — the switch, the installer's report, and the
// registry settings. DB-free: prisma, requireSystemAdmin and the registry
// client are mocked; validation, layering and the vault run for real.
//
// The rules pinned here:
//   - a bad repository reference is a 400 and saves nothing;
//   - a registry that cannot list versions with the new settings is a 400 and
//     saves nothing ("never store a credential that cannot do the job");
//   - the password is never echoed back, in success or in error;
//   - a saved password is not silently carried to a different registry host.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

const { requireSystemAdmin, listTags, prisma } = vi.hoisted(() => ({
  requireSystemAdmin: vi.fn(),
  listTags: vi.fn(),
  prisma: {
    updateSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    updateReconcileStatus: { findUnique: vi.fn() },
    // The event backlog: [domain_events], then [webhook_deliveries].
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/lib/internal/require-system-admin", () => ({ requireSystemAdmin }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/updates/registry", async (orig) => ({
  ...(await orig<typeof import("@/lib/updates/registry")>()),
  listTags,
}));

import { GET, PUT } from "./route";
import { appJobRunner } from "@/lib/jobs/runner";
import { sealField } from "@/lib/crypto/field-seal";

const ORIGINAL = {
  key: process.env.SSO_VAULT_KEY,
  repo: process.env.COSMOS_UPDATE_IMAGE_REPO,
  user: process.env.COSMOS_UPDATE_REGISTRY_USERNAME,
  pass: process.env.COSMOS_UPDATE_REGISTRY_PASSWORD,
};
process.env.SSO_VAULT_KEY = randomBytes(32).toString("base64");
afterAll(() => {
  for (const [k, v] of [
    ["SSO_VAULT_KEY", ORIGINAL.key],
    ["COSMOS_UPDATE_IMAGE_REPO", ORIGINAL.repo],
    ["COSMOS_UPDATE_REGISTRY_USERNAME", ORIGINAL.user],
    ["COSMOS_UPDATE_REGISTRY_PASSWORD", ORIGINAL.pass],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ENV_REPO = "registry.example.com/cosmos/assembly/alpha";

/** The settings row as Prisma would return it for each `select`. */
let stored: Record<string, unknown>;

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/v1/admin/updates/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.COSMOS_UPDATE_IMAGE_REPO = ENV_REPO;
  process.env.COSMOS_UPDATE_REGISTRY_USERNAME = "env-user";
  process.env.COSMOS_UPDATE_REGISTRY_PASSWORD = "env-pass";
  stored = {
    autoUpdate: true,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    imageRepo: null,
    tagSuffix: null,
    registryUsername: null,
    registryPasswordEnc: null,
  };
  requireSystemAdmin.mockResolvedValue({ id: "admin-1", email: "admin@example.com" });
  prisma.updateSettings.findUnique.mockImplementation(async () => stored);
  prisma.updateSettings.upsert.mockImplementation(async (args: { update: Record<string, unknown> }) => {
    stored = { ...stored, ...args.update, updatedAt: new Date() };
    return stored;
  });
  prisma.updateReconcileStatus.findUnique.mockResolvedValue(null);
  listTags.mockResolvedValue(["2.431.0-alpha", "2.431.1-alpha", "latest"]);
});

describe("GET", () => {
  it("is system-admin only", async () => {
    requireSystemAdmin.mockResolvedValue(null);
    expect((await GET()).status).toBe(403);
  });

  it("returns the installer's report and its health line alongside the switch", async () => {
    prisma.updateReconcileStatus.findUnique.mockResolvedValue({
      outcome: "failing",
      message: "pull access denied",
      latestReleased: "2.431.1",
      runningVersion: "2.427.0",
      source: ENV_REPO,
      checkedAt: new Date(),
      failingSince: new Date(Date.now() - 3_600_000),
    });
    const body = await (await GET()).json();
    expect(body.autoUpdate).toBe(true);
    expect(body.reconcile).toMatchObject({ outcome: "failing", runningVersion: "2.427.0" });
    expect(body.reconcileHealth.tone).toBe("error");
  });

  it("says whether the event worker is keeping up, and stays up if that read fails", async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ unprocessed: BigInt(7), oldest: new Date(Date.now() - 30 * 60_000) }])
      .mockResolvedValueOnce([{ pending: BigInt(0), failed: BigInt(0) }]);
    const stalled = await (await GET()).json();
    expect(stalled.eventBacklog).toMatchObject({ tone: "error", backlog: { unprocessed: 7, oldestAgeSeconds: expect.any(Number) } });
    expect(stalled.eventBacklog.headline).toMatch(/^7 change events are waiting/);

    prisma.$queryRaw.mockRejectedValueOnce(new Error("relation does not exist"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).eventBacklog).toMatchObject({ tone: "muted", backlog: null });
  });

  it("says whether this instance runs the background jobs, and why not", async () => {
    vi.stubEnv("JOBS_DISABLED", "1");
    expect((await (await GET()).json()).jobs).toEqual({ enabled: false, reason: "JOBS_DISABLED", jobs: [] });
    vi.stubEnv("JOBS_DISABLED", "");
    vi.stubEnv("DATABASE_URL", "postgres://x");
    // Registered but never started: what production showed before the runner fix.
    appJobRunner().register({ name: "route-test-job", everyMs: 60_000, run: async () => undefined });
    const jobs = (await (await GET()).json()).jobs;
    expect(jobs).toMatchObject({ enabled: false, reason: expect.stringMatching(/wasn't started/) });
    expect(jobs.jobs).toContainEqual(expect.objectContaining({ name: "route-test-job", leader: false, stuck: false, lastSucceededAt: null, everySeconds: 60 }));
    vi.unstubAllEnvs();
  });

  it("reports reconcile: null when the installer has never reported", async () => {
    const body = await (await GET()).json();
    expect(body.reconcile).toBeNull();
    expect(body.reconcileHealth.tone).toBe("muted");
  });

  it("says where each registry value comes from, and never returns a password", async () => {
    stored.registryPasswordEnc = sealField("db-secret");
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain("db-secret");
    expect(text).not.toContain("env-pass");
    expect(text).not.toContain(stored.registryPasswordEnc as string);
    const body = JSON.parse(text);
    expect(body.registry.imageRepo).toMatchObject({ value: ENV_REPO, source: "env" });
    expect(body.registry.password).toEqual({ set: true, source: "settings", envSet: true });
  });
});

describe("PUT", () => {
  it("is system-admin only", async () => {
    requireSystemAdmin.mockResolvedValue(null);
    expect((await put({ autoUpdate: false })).status).toBe(403);
  });

  it("still flips the switch on its own", async () => {
    const res = await put({ autoUpdate: false });
    expect(res.status).toBe(200);
    expect(stored.autoUpdate).toBe(false);
    expect(listTags).not.toHaveBeenCalled();
  });

  it("rejects a malformed repository with a 400 and saves nothing", async () => {
    const res = await put({ registry: { imageRepo: "https://registry.example.com/cosmos" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/without a scheme/);
    expect(prisma.updateSettings.upsert).not.toHaveBeenCalled();
    expect(listTags).not.toHaveBeenCalled();
  });

  it("rejects a Docker Hub shorthand (no explicit registry host)", async () => {
    const res = await put({ registry: { imageRepo: "cosmos/app" } });
    expect(res.status).toBe(400);
    expect(prisma.updateSettings.upsert).not.toHaveBeenCalled();
  });

  it("PROBES the new settings and refuses with a 400 when the registry cannot list tags", async () => {
    listTags.mockRejectedValue(new Error("registry listing failed: HTTP 401"));
    const res = await put({
      registry: { imageRepo: "registry.example.com/cosmos/assembly/beta", password: "wrong-pass" },
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/Could not list versions in registry\.example\.com\/cosmos\/assembly\/beta/);
    expect(text).toMatch(/HTTP 401/);
    expect(text).not.toContain("wrong-pass");
    expect(prisma.updateSettings.upsert).not.toHaveBeenCalled();
  });

  it("probes with the CANDIDATE repository and credentials, not the stored ones", async () => {
    await put({ registry: { imageRepo: "registry.example.com/cosmos/assembly/alpha2", username: "u2", password: "p2" } });
    expect(listTags).toHaveBeenCalledWith("registry.example.com/cosmos/assembly/alpha2", { username: "u2", password: "p2" });
  });

  it("refuses a registry whose tags carry no release for the suffix", async () => {
    listTags.mockResolvedValue(["latest", "2.431.1-beta"]);
    const res = await put({ registry: { tagSuffix: "gamma" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no release tags ending in "-gamma"/);
    expect(prisma.updateSettings.upsert).not.toHaveBeenCalled();
  });

  it("a refused registry change also leaves the switch alone", async () => {
    listTags.mockRejectedValue(new Error("registry listing failed: HTTP 404"));
    const res = await put({ autoUpdate: false, registry: { tagSuffix: "beta" } });
    expect(res.status).toBe(400);
    expect(stored.autoUpdate).toBe(true);
  });

  it("saves a probed change, seals the password, and never echoes it", async () => {
    const res = await put({
      registry: { imageRepo: "registry.example.com/cosmos/assembly/alpha", username: "deploy", password: "s3cret-token" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("s3cret-token");
    expect(stored.registryPasswordEnc).toBeTruthy();
    expect(stored.registryPasswordEnc).not.toBe("s3cret-token");
    expect(JSON.parse(text).registry.password).toMatchObject({ set: true, source: "settings" });
  });

  it("an empty string clears an override back to the environment", async () => {
    stored.imageRepo = "registry.example.com/cosmos/assembly/beta";
    const res = await put({ registry: { imageRepo: "" } });
    expect(res.status).toBe(200);
    expect(stored.imageRepo).toBeNull();
    expect((await res.json()).registry.imageRepo).toMatchObject({ value: ENV_REPO, source: "env" });
  });

  it("clearPassword removes the saved password", async () => {
    stored.registryPasswordEnc = sealField("old");
    const res = await put({ registry: { clearPassword: true } });
    expect(res.status).toBe(200);
    expect(stored.registryPasswordEnc).toBeNull();
  });

  // Moving to another host while keeping the saved password would send that
  // registry's credential to whatever host was just typed in.
  it("refuses to carry a SAVED password to a different registry host", async () => {
    stored.registryPasswordEnc = sealField("old-host-token");
    const res = await put({ registry: { imageRepo: "other.example.org/cosmos/app" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/saved password is for registry\.example\.com/);
    expect(listTags).not.toHaveBeenCalled();
  });

  it("does not send the ENVIRONMENT's credentials to a different host when probing", async () => {
    await put({ registry: { imageRepo: "other.example.org/cosmos/app" } });
    expect(listTags).toHaveBeenCalledWith("other.example.org/cosmos/app", { username: undefined, password: undefined });
  });

  it("rejects a body that is not a settings change, without echoing it", async () => {
    const res = await put({ registry: { password: 12345, extra: "x" } });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("12345");
  });
});
