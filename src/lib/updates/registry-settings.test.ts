// @vitest-environment node
//
// Registry settings laid over the environment, and resolveUpdateConfig — the
// one function the page, the deploy route and the Foreman daemon all use to
// decide which registry to read. The vault runs for real under a test key, so
// "the password is sealed" and "the password is unsealed" are both checked
// against the real envelope, not a mock that agrees with itself.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

const { prisma } = vi.hoisted(() => ({
  prisma: { updateSettings: { findUnique: vi.fn(), upsert: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  layerRegistryEnv,
  imageRepoProblem,
  tagSuffixProblem,
  readRegistryOverrides,
  writeRegistryOverrides,
} from "./registry-settings";
import { resolveUpdateConfig, registrySettingsView, updateConfigFromEnv } from "./check";
import { sealField, isSealed, openField } from "@/lib/crypto/field-seal";

const ORIGINAL_KEY = process.env.SSO_VAULT_KEY;
const ORIGINAL_KEYS = process.env.SSO_VAULT_KEYS;
process.env.SSO_VAULT_KEY = randomBytes(32).toString("base64");
delete process.env.SSO_VAULT_KEYS;
afterAll(() => {
  process.env.SSO_VAULT_KEY = ORIGINAL_KEY;
  if (ORIGINAL_KEYS !== undefined) process.env.SSO_VAULT_KEYS = ORIGINAL_KEYS;
});

const ENV = {
  COSMOS_UPDATE_IMAGE_REPO: "registry.old.example.com/cosmos/assembly/alpha",
  COSMOS_UPDATE_REGISTRY_USERNAME: "env-user",
  COSMOS_UPDATE_REGISTRY_PASSWORD: "env-pass",
};

const row = (over: Record<string, string | null> = {}) => ({
  imageRepo: null,
  tagSuffix: null,
  registryUsername: null,
  registryPasswordEnc: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("resolveUpdateConfig", () => {
  it("is the env-only config when nothing is saved", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(null);
    expect(await resolveUpdateConfig(ENV)).toEqual(updateConfigFromEnv(ENV));
  });

  it("a saved repository OVERRIDES the environment, and the suffix is re-derived from it", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(
      row({ imageRepo: "registry.new.example.com/cosmos/assembly/beta" }),
    );
    const c = await resolveUpdateConfig(ENV);
    expect(c?.repo).toBe("registry.new.example.com/cosmos/assembly/beta");
    expect(c?.suffix).toBe("beta");
    expect(c?.migrateRepo).toBe("registry.new.example.com/cosmos/assembly/beta-migrate");
    expect(c?.notesRepo).toBe("registry.new.example.com/cosmos/assembly/beta");
  });

  it("a saved suffix, username and password override theirs", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(
      row({ tagSuffix: "gamma", registryUsername: "db-user", registryPasswordEnc: sealField("db-pass") }),
    );
    const c = await resolveUpdateConfig(ENV);
    expect(c?.suffix).toBe("gamma");
    expect(c?.username).toBe("db-user");
    // Unsealed for the registry call — the sealed envelope would just be a
    // wrong password.
    expect(c?.password).toBe("db-pass");
  });

  it("an EMPTY saved value falls back to the environment", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(
      row({ imageRepo: "", tagSuffix: "", registryUsername: "", registryPasswordEnc: "" }),
    );
    expect(await resolveUpdateConfig(ENV)).toEqual(updateConfigFromEnv(ENV));
  });

  // An unreadable setting must not be able to stop updates.
  it("FAILS OPEN to the environment when the settings row cannot be read", async () => {
    prisma.updateSettings.findUnique.mockRejectedValue(new Error("relation does not exist"));
    expect(await resolveUpdateConfig(ENV)).toEqual(updateConfigFromEnv(ENV));
  });

  it("fails open to the environment when the saved password cannot be unsealed", async () => {
    // A well-formed envelope under a key this instance does not hold.
    const saved = process.env.SSO_VAULT_KEY;
    process.env.SSO_VAULT_KEY = randomBytes(32).toString("base64");
    const foreign = sealField("x");
    process.env.SSO_VAULT_KEY = saved;
    prisma.updateSettings.findUnique.mockResolvedValue(
      row({ imageRepo: "registry.new.example.com/a/b", registryPasswordEnc: foreign }),
    );
    expect(await resolveUpdateConfig(ENV)).toEqual(updateConfigFromEnv(ENV));
  });

  it("never logs the password when it falls back", async () => {
    prisma.updateSettings.findUnique.mockRejectedValue(new Error("boom env-pass db-pass"));
    await resolveUpdateConfig(ENV);
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ");
    expect(logged).not.toMatch(/env-pass|db-pass/);
  });

  it("is null when no repository is configured anywhere", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(null);
    expect(await resolveUpdateConfig({})).toBeNull();
  });
});

describe("layerRegistryEnv — credentials go only to the host they belong to", () => {
  const none = { imageRepo: null, tagSuffix: null, username: null, password: null };

  it("does NOT carry the environment's credentials to a different registry host", () => {
    const { env, sources } = layerRegistryEnv(ENV, { ...none, imageRepo: "evil.example.net/x/y" });
    expect(env.COSMOS_UPDATE_REGISTRY_PASSWORD).toBeUndefined();
    expect(env.COSMOS_UPDATE_REGISTRY_USERNAME).toBeUndefined();
    expect(sources.password).toBe("unset");
  });

  it("keeps them for a different repository on the SAME host", () => {
    const { env } = layerRegistryEnv(ENV, { ...none, imageRepo: "registry.old.example.com/cosmos/assembly/beta" });
    expect(env.COSMOS_UPDATE_REGISTRY_PASSWORD).toBe("env-pass");
  });

  it("uses credentials saved alongside the new host", () => {
    const { env, sources } = layerRegistryEnv(ENV, {
      ...none,
      imageRepo: "registry.new.example.com/a/b",
      username: "u",
      password: "p",
    });
    expect(env.COSMOS_UPDATE_REGISTRY_PASSWORD).toBe("p");
    expect(sources.password).toBe("settings");
  });
});

describe("registrySettingsView", () => {
  it("says where each value came from, and never carries the password", () => {
    const v = registrySettingsView(ENV, {
      imageRepo: null,
      tagSuffix: "gamma",
      username: null,
      passwordEnc: sealField("db-pass"),
    });
    expect(v.imageRepo).toEqual({ value: ENV.COSMOS_UPDATE_IMAGE_REPO, source: "env", envValue: ENV.COSMOS_UPDATE_IMAGE_REPO });
    expect(v.tagSuffix).toMatchObject({ value: "gamma", source: "settings" });
    expect(v.username).toMatchObject({ value: "env-user", source: "env" });
    expect(v.password).toEqual({ set: true, source: "settings", envSet: true });
    expect(JSON.stringify(v)).not.toMatch(/db-pass|env-pass/);
  });

  it("a suffix nobody set is 'default' (derived from the repository)", () => {
    const v = registrySettingsView(ENV, { imageRepo: null, tagSuffix: null, username: null, passwordEnc: null });
    expect(v.tagSuffix).toMatchObject({ value: "alpha", source: "default" });
  });

  it("nothing anywhere is 'unset'", () => {
    const v = registrySettingsView({}, { imageRepo: null, tagSuffix: null, username: null, passwordEnc: null });
    expect(v.imageRepo.source).toBe("unset");
    expect(v.password).toEqual({ set: false, source: "unset", envSet: false });
  });
});

describe("writeRegistryOverrides / readRegistryOverrides", () => {
  it("SEALS the password before it reaches the database", async () => {
    prisma.updateSettings.upsert.mockResolvedValue({ id: "x" });
    await writeRegistryOverrides({ password: "hunter2" }, "user-1");
    const arg = prisma.updateSettings.upsert.mock.calls[0][0];
    expect(arg.update.registryPasswordEnc).not.toBe("hunter2");
    expect(isSealed(arg.update.registryPasswordEnc)).toBe(true);
    expect(openField(arg.update.registryPasswordEnc)).toBe("hunter2");
    expect(JSON.stringify(arg)).not.toContain("hunter2");
  });

  it("leaves untouched fields alone and clears with null", async () => {
    prisma.updateSettings.upsert.mockResolvedValue({ id: "x" });
    await writeRegistryOverrides({ imageRepo: null }, null);
    const { update } = prisma.updateSettings.upsert.mock.calls[0][0];
    expect(update).toEqual({ imageRepo: null, updatedById: null });
  });

  it("reads a missing row as no overrides", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(null);
    expect(await readRegistryOverrides()).toEqual({ imageRepo: null, tagSuffix: null, username: null, passwordEnc: null });
  });
});

describe("imageRepoProblem", () => {
  it.each([
    "registry.example.com/cosmos/app",
    "registry.gitlab.com/jongodb-labs/cosmos/assembly/alpha",
    "localhost:5000/cosmos",
    "10.0.0.5:5000/a/b-c",
    "ghcr.io/jongodb-labs/cosmos-v2",
  ])("accepts %s", (r) => expect(imageRepoProblem(r)).toBeNull());

  it.each([
    ["https://registry.example.com/a", /scheme/],
    ["registry.example.com/a b", /spaces/],
    ["cosmos/app", /registry host/], // Docker Hub shorthand — no explicit host
    ["registry.example.com", /repository path/],
    ["registry.example.com/a:1.2.3", /tag/],
    ["registry.example.com/a@sha256:abc", /digest/],
    ["registry.example.com/Upper", /lowercase/],
    ["registry.example.com//a", /lowercase/],
  ])("rejects %s", (r, why) => expect(imageRepoProblem(r)).toMatch(why));
});

describe("tagSuffixProblem", () => {
  it("accepts a plain suffix and rejects punctuation", () => {
    expect(tagSuffixProblem("alpha")).toBeNull();
    expect(tagSuffixProblem("-alpha")).not.toBeNull();
    expect(tagSuffixProblem("al pha")).not.toBeNull();
  });
});

// A registry MOVE made from the page while the environment still names the old
// host for everything. Honouring the env's explicit migrate/notes/sidecar repos
// would look for the paired migration image on a dead host, and every update
// would read as not applyable.
describe("layerRegistryEnv — companion repositories follow a registry move", () => {
  const none = { imageRepo: null, tagSuffix: null, username: null, password: null };
  const OLD_ENV = {
    COSMOS_UPDATE_IMAGE_REPO: "registry.old.example.com/cosmos/assembly/alpha",
    COSMOS_UPDATE_MIGRATE_REPO: "registry.old.example.com/cosmos/assembly/alpha-migrate",
    COSMOS_UPDATE_NOTES_REPO: "registry.old.example.com/cosmos/core",
    COSMOS_UPDATE_SIDECAR_REPOS: "registry.old.example.com/cosmos/realtime, ghcr.io/public/thing",
    COSMOS_UPDATE_TAG_SUFFIX: "alpha",
  };

  it("host differs: migrate and notes are DERIVED from the saved repository, not the old host", () => {
    const c = updateConfigFromEnv(
      layerRegistryEnv(OLD_ENV, { ...none, imageRepo: "registry.new.example.com/cosmos/assembly/alpha" }).env,
    );
    expect(c?.migrateRepo).toBe("registry.new.example.com/cosmos/assembly/alpha-migrate");
    expect(c?.notesRepo).toBe("registry.new.example.com/cosmos/assembly/alpha");
  });

  it("host differs: old-host sidecars are RE-HOSTED (not dropped); a third-host sidecar is kept", () => {
    const c = updateConfigFromEnv(
      layerRegistryEnv(OLD_ENV, { ...none, imageRepo: "registry.new.example.com/cosmos/assembly/alpha" }).env,
    );
    // Same count as before: dropping one would silently skip its preflight.
    expect(c?.sidecarRepos).toEqual(["registry.new.example.com/cosmos/realtime", "ghcr.io/public/thing"]);
  });

  it("host differs: a notes repository on a THIRD host was chosen deliberately and is kept", () => {
    const c = updateConfigFromEnv(
      layerRegistryEnv(
        { ...OLD_ENV, COSMOS_UPDATE_NOTES_REPO: "ghcr.io/jongodb-labs/cosmos-v2" },
        { ...none, imageRepo: "registry.new.example.com/cosmos/assembly/alpha" },
      ).env,
    );
    expect(c?.notesRepo).toBe("ghcr.io/jongodb-labs/cosmos-v2");
  });

  it("host differs: the env tag suffix still applies (it is host-independent)", () => {
    const c = updateConfigFromEnv(
      layerRegistryEnv(OLD_ENV, { ...none, imageRepo: "registry.new.example.com/cosmos/assembly/beta" }).env,
    );
    expect(c?.suffix).toBe("alpha");
  });

  it("SAME host: the environment's explicit companion repositories are left exactly as they are", () => {
    const c = updateConfigFromEnv(
      layerRegistryEnv(OLD_ENV, { ...none, imageRepo: "registry.old.example.com/cosmos/assembly/beta" }).env,
    );
    expect(c?.migrateRepo).toBe(OLD_ENV.COSMOS_UPDATE_MIGRATE_REPO);
    expect(c?.notesRepo).toBe(OLD_ENV.COSMOS_UPDATE_NOTES_REPO);
    expect(c?.sidecarRepos).toEqual(["registry.old.example.com/cosmos/realtime", "ghcr.io/public/thing"]);
  });

  it("no saved repository: nothing is rewritten", () => {
    expect(layerRegistryEnv(OLD_ENV, none).env).toEqual(OLD_ENV);
  });

  it("resolveUpdateConfig applies the same rule end to end", async () => {
    prisma.updateSettings.findUnique.mockResolvedValue(
      row({ imageRepo: "registry.new.example.com/cosmos/assembly/alpha" }),
    );
    const c = await resolveUpdateConfig(OLD_ENV);
    expect(c?.migrateRepo).toBe("registry.new.example.com/cosmos/assembly/alpha-migrate");
  });
});
