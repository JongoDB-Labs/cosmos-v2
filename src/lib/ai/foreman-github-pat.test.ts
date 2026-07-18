import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getOrgCredential = vi.fn();
const setOrgCredential = vi.fn();
const deleteOrgCredential = vi.fn();
vi.mock("@/lib/integrations/credentials", () => ({
  getOrgCredential: (...a: unknown[]) => getOrgCredential(...a),
  setOrgCredential: (...a: unknown[]) => setOrgCredential(...a),
  deleteOrgCredential: (...a: unknown[]) => deleteOrgCredential(...a),
}));

import { getForemanGithubToken, validateGithubPat, getForemanGithubStatus } from "./foreman-github-pat";

describe("foreman-github-pat", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    getOrgCredential.mockReset();
    setOrgCredential.mockReset();
    deleteOrgCredential.mockReset();
    delete process.env.GITHUB_ANALYSIS_TOKEN;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("getForemanGithubToken prefers the org PAT", async () => {
    getOrgCredential.mockResolvedValue({ token: "org-pat" });
    expect(await getForemanGithubToken("o1")).toBe("org-pat");
  });
  it("getForemanGithubToken falls back to GITHUB_ANALYSIS_TOKEN env", async () => {
    getOrgCredential.mockResolvedValue(null);
    process.env.GITHUB_ANALYSIS_TOKEN = "deploy-tok";
    expect(await getForemanGithubToken("o1")).toBe("deploy-tok");
  });
  it("getForemanGithubToken returns null when neither is set", async () => {
    getOrgCredential.mockResolvedValue(null);
    expect(await getForemanGithubToken("o1")).toBeNull();
  });

  it("validateGithubPat returns null when GitHub rejects the token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    expect(await validateGithubPat("bad")).toBeNull();
  });
  it("validateGithubPat proves liveness via rate_limit and reads the login", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: "octocat" }) }) as unknown as typeof fetch;
    expect(await validateGithubPat("good")).toEqual({ login: "octocat" });
  });
  it("validateGithubPat still succeeds (generic login) when /user is forbidden for a repo-only PAT", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false }) as unknown as typeof fetch;
    expect(await validateGithubPat("repo-only")).toEqual({ login: "connected" });
  });

  it("status: org source when a PAT is stored", async () => {
    getOrgCredential.mockResolvedValue({ token: "t" });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: "me" }) }) as unknown as typeof fetch;
    expect(await getForemanGithubStatus("o1")).toEqual({ connected: true, login: "me", source: "org" });
  });
  it("status: deployment source when only the env token is set", async () => {
    getOrgCredential.mockResolvedValue(null);
    process.env.GITHUB_ANALYSIS_TOKEN = "x";
    expect(await getForemanGithubStatus("o1")).toEqual({ connected: true, login: null, source: "deployment" });
  });
  it("status: not connected when neither is present", async () => {
    getOrgCredential.mockResolvedValue(null);
    expect(await getForemanGithubStatus("o1")).toEqual({ connected: false });
  });
});
