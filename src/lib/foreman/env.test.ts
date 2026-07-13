import { describe, it, expect, vi, afterEach } from "vitest";
import { buildAgentEnv, checkEnv } from "./env";
import { DEFAULT_TEST_DATABASE_URL } from "./test-db";

describe("buildAgentEnv", () => {
  const PROD_DB = "postgresql://cosmos:cosmos@127.0.0.1:55432/cosmos";
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "production", // the daemon's real env — must NOT be inherited
    PATH: "/usr/bin",
    HOME: "/home/defcon",
    DATABASE_URL: PROD_DB,
  };

  it("forces NODE_ENV=test even when the daemon runs production", () => {
    // The whole point: production made the agent's own `npm test` spuriously red.
    expect(buildAgentEnv(base).NODE_ENV).toBe("test");
  });

  it("points DATABASE_URL at the e2e test DB, never the live one", () => {
    const env = buildAgentEnv(base);
    expect(env.DATABASE_URL).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(env.DATABASE_URL).not.toBe(PROD_DB);
  });

  it("forwards PATH / HOME / locale", () => {
    const env = buildAgentEnv({ ...base, LC_ALL: "C.UTF-8" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/defcon");
    expect(env.LC_ALL).toBe("C.UTF-8");
  });

  it("overrides HOME with the injected homeDir (the per-org Foreman creds dir)", () => {
    // runAgent materializes a throwaway HOME holding the org's Foreman OAuth creds
    // and passes it here — the SDK then authenticates as that subscription, NOT the
    // deploy box's ~/.claude. The override wins over the inherited HOME.
    expect(buildAgentEnv({ ...base, HOME: "/real" }, undefined, "/injected").HOME).toBe("/injected");
  });

  it("EXCLUDES GH tokens and metered/cloud-billing vars — never handed to the agent's shell", () => {
    const env = buildAgentEnv({
      ...base,
      GH_TOKEN: "ghp_x",
      GITHUB_TOKEN: "ghs_x",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_AUTH_TOKEN: "tok",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) {
      expect(env[k]).toBeUndefined();
    }
  });
});

describe("checkEnv", () => {
  // process.env.NODE_ENV is typed read-only (Next augmentation) — stub it.
  afterEach(() => vi.unstubAllEnvs());

  it("forces NODE_ENV=test even when the daemon runs production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(checkEnv().NODE_ENV).toBe("test");
  });

  it("lets extraEnv (e.g. the e2e DATABASE_URL) win", () => {
    const env = checkEnv({ DATABASE_URL: "postgresql://e2e" });
    expect(env.DATABASE_URL).toBe("postgresql://e2e");
    expect(env.NODE_ENV).toBe("test");
  });

  it("preserves other inherited vars", () => {
    vi.stubEnv("FOREMAN_ENV_MARKER", "keep-me");
    expect(checkEnv().FOREMAN_ENV_MARKER).toBe("keep-me");
  });
});
