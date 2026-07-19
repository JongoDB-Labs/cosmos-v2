import { describe, it, expect, beforeEach } from "vitest";
import { applyGithubAuthEnv } from "./github-auth.mjs";

describe("applyGithubAuthEnv", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    env = {} as NodeJS.ProcessEnv;
  });

  it("no-op (returns false, sets nothing) when there is no token", () => {
    expect(applyGithubAuthEnv(null, env)).toBe(false);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
  });

  it("sets GH_TOKEN + the git credential env from the PAT", () => {
    expect(applyGithubAuthEnv("github_pat_abc", env)).toBe(true);
    expect(env.GH_TOKEN).toBe("github_pat_abc");
    expect(env.GITHUB_TOKEN).toBe("github_pat_abc");
    expect(env.FOREMAN_GH_PAT).toBe("github_pat_abc");
    expect(env.GIT_ASKPASS).toContain("askpass");
    // credential.helper reset to "" so the inherited host helper cannot win over askpass
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
  });
});
