// @vitest-environment node
//
// GitHub executor — locks the connector contract:
//   - resolves the org-SHARED sealed PAT via getOrgCredential(orgId,'github');
//   - "not connected" → graceful { error }, never a throw;
//   - API error (HTTP 4xx/5xx) → graceful, TOKEN-FREE { error };
//   - success → a shallow shape (title/body/labels INCLUDED — the egress gate, not
//     the executor, decides what the model sees);
//   - the bearer token is sent to the API but NEVER appears in any returned value.
// Uses an INJECTED fetch (ctx.fetchImpl) so no network is touched.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getOrgCredential, prisma } = vi.hoisted(() => ({
  getOrgCredential: vi.fn(),
  prisma: { integration: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/integrations/credentials", () => ({ getOrgCredential }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  githubListIssues,
  githubGetIssue,
  githubListPullRequests,
  GITHUB_TOOL_NAMES,
  executeGitHubTool,
} from "./github";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000bb";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: org has a connected GitHub PAT + configured defaults.
  getOrgCredential.mockResolvedValue({ token: "GHTESTTOK" });
  prisma.integration.findFirst.mockResolvedValue({
    config: { defaultOwner: "acme", defaultRepo: "cosmos" },
  });
});

describe("not connected (no sealed org credential)", () => {
  it("github_list_issues returns a graceful error, never throws", async () => {
    getOrgCredential.mockResolvedValue(null);
    const fetchImpl = mockFetch(200, []);
    const res = (await githubListIssues({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("GitHub is not connected");
    expect(fetchImpl).not.toHaveBeenCalled(); // never reaches the API without a token
  });

  it("treats a present-but-tokenless bundle as not connected", async () => {
    getOrgCredential.mockResolvedValue({});
    const res = (await githubGetIssue({ number: 1 }, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, {}) })) as {
      error?: string;
    };
    expect(res.error).toContain("GitHub is not connected");
  });
});

describe("githubListIssues (success)", () => {
  it("calls the GitHub REST API with the bearer token + version header, defaults owner/repo, drops PRs", async () => {
    const fetchImpl = mockFetch(200, [
      { number: 1, state: "open", title: "Bug A", labels: [{ name: "bug" }], created_at: "t1", updated_at: "t2", closed_at: null },
      // a PR leaks into /issues — must be filtered out (has `pull_request`).
      { number: 2, state: "open", title: "PR B", pull_request: { url: "x" }, labels: [], created_at: "t3", updated_at: "t4" },
    ]);
    const res = (await githubListIssues({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      success: boolean;
      count: number;
      issues: Array<Record<string, unknown>>;
    };

    // URL uses the configured defaults + default state=open.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/cosmos/issues?state=open&per_page=20");
    expect(init.headers.Authorization).toBe("Bearer GHTESTTOK");
    expect(init.headers["Accept"]).toBe("application/vnd.github+json");
    expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");

    // PR filtered out → only the real issue remains; labels normalized to names.
    expect(res.count).toBe(1);
    expect(res.issues).toEqual([
      { number: 1, state: "open", title: "Bug A", labels: ["bug"], createdAt: "t1", updatedAt: "t2", closedAt: null },
    ]);
    // The token never appears in the returned value.
    expect(JSON.stringify(res)).not.toContain("GHTESTTOK");
  });

  it("explicit owner/repo/state/limit override the integration defaults (limit clamped to 50)", async () => {
    const fetchImpl = mockFetch(200, []);
    await githubListIssues(
      { owner: "o2", repo: "r2", state: "all", limit: 999 },
      { orgId: ORG, userId: USER, fetchImpl },
    );
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/o2/r2/issues?state=all&per_page=50",
    );
  });

  it("errors when neither args nor integration defaults supply owner/repo", async () => {
    prisma.integration.findFirst.mockResolvedValue({ config: {} });
    const fetchImpl = mockFetch(200, []);
    const res = (await githubListIssues({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("owner and repo are required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("githubGetIssue", () => {
  it("requires a positive issue number", async () => {
    const res = (await githubGetIssue({}, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, {}) })) as {
      error?: string;
    };
    expect(res.error).toContain("number");
  });

  it("returns the single issue shape including body (egress gate withholds it later)", async () => {
    const fetchImpl = mockFetch(200, {
      number: 42,
      state: "closed",
      title: "Title",
      body: "Body text",
      labels: ["a", { name: "b" }],
      created_at: "c",
      updated_at: "u",
      closed_at: "z",
    });
    const res = (await githubGetIssue({ number: 42 }, { orgId: ORG, userId: USER, fetchImpl })) as {
      issue: Record<string, unknown>;
    };
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.github.com/repos/acme/cosmos/issues/42");
    expect(res.issue).toEqual({
      number: 42,
      state: "closed",
      title: "Title",
      body: "Body text",
      labels: ["a", "b"],
      createdAt: "c",
      updatedAt: "u",
      closedAt: "z",
    });
  });
});

describe("githubListPullRequests", () => {
  it("hits the /pulls endpoint and returns number/state/draft/timestamps", async () => {
    const fetchImpl = mockFetch(200, [
      { number: 7, state: "open", title: "PR", draft: true, created_at: "c", updated_at: "u", closed_at: null, merged_at: null },
    ]);
    const res = (await githubListPullRequests({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      count: number;
      pullRequests: Array<Record<string, unknown>>;
    };
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/acme/cosmos/pulls?state=open&per_page=20",
    );
    expect(res.count).toBe(1);
    expect(res.pullRequests[0]).toMatchObject({ number: 7, state: "open", draft: true });
  });
});

describe("API error handling (graceful, token-free)", () => {
  it("a 401 (bad PAT) becomes a clean error message with no token leak", async () => {
    const fetchImpl = mockFetch(401, { message: "Bad credentials" });
    const res = (await githubListIssues({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("HTTP 401");
    expect(res.error).toContain("Bad credentials");
    expect(JSON.stringify(res)).not.toContain("GHTESTTOK");
  });

  it("a 404 repo error surfaces gracefully", async () => {
    const fetchImpl = mockFetch(404, { message: "Not Found" });
    const res = (await githubGetIssue({ number: 1 }, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("HTTP 404");
  });

  it("a thrown fetch (network failure) is caught → graceful error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = (await githubListPullRequests({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("dispatch", () => {
  it("GITHUB_TOOL_NAMES lists exactly the three read tools", () => {
    expect([...GITHUB_TOOL_NAMES].sort()).toEqual(
      ["github_get_issue", "github_list_issues", "github_list_pull_requests"].sort(),
    );
  });

  it("executeGitHubTool returns null for a non-github tool", async () => {
    expect(await executeGitHubTool("send_email", {}, { orgId: ORG, userId: USER })).toBeNull();
  });
});
