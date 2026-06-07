// @vitest-environment node
//
// Jira executor — locks the connector contract:
//   - resolves the org-SHARED sealed credential via getOrgCredential(orgId,'jira')
//     ({ email, apiToken }) + the non-secret baseUrl/defaultProjectKey from config;
//   - "not connected" / incomplete bundle → graceful { error }, never a throw;
//   - API error (HTTP 4xx/5xx) → graceful, TOKEN-FREE { error };
//   - success → a shallow shape (summary/description INCLUDED — the egress gate, not
//     the executor, decides what the model sees);
//   - the Basic credential is sent to the API but NEVER appears in any returned value.
// Uses an INJECTED fetch (ctx.fetchImpl) so no network is touched.
//
// Plus a PROJECTION CONTRACT assertion: a gov jira_issue is projected to structural-
// only (key/status/priority/issueType/timestamps), with summary/description withheld.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getOrgCredential, prisma } = vi.hoisted(() => ({
  getOrgCredential: vi.fn(),
  prisma: { integration: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/integrations/credentials", () => ({ getOrgCredential }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  jiraSearchIssues,
  jiraGetIssue,
  jiraListProjects,
  jiraCreateIssue,
  JIRA_TOOL_NAMES,
  executeJiraTool,
} from "./jira";
import { projectStructural } from "../egress/projection";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000bb";
const EMAIL = "bot@acme.com";
const TOKEN = "JIRATESTTOK";
// base64("bot@acme.com:JIRATESTTOK")
const EXPECTED_BASIC = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;

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
  // Default: org has a connected Jira credential + configured baseUrl/default project.
  getOrgCredential.mockResolvedValue({ email: EMAIL, apiToken: TOKEN });
  prisma.integration.findFirst.mockResolvedValue({
    config: { baseUrl: "https://acme.atlassian.net/", defaultProjectKey: "ABC" },
  });
});

describe("not connected (no / incomplete sealed org credential)", () => {
  it("jira_search_issues returns a graceful error, never throws", async () => {
    getOrgCredential.mockResolvedValue(null);
    const fetchImpl = mockFetch(200, { issues: [] });
    const res = (await jiraSearchIssues({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("Jira is not connected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a bundle missing apiToken as not connected", async () => {
    getOrgCredential.mockResolvedValue({ email: EMAIL });
    const res = (await jiraGetIssue({ issueKey: "ABC-1" }, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, {}) })) as {
      error?: string;
    };
    expect(res.error).toContain("Jira is not connected");
  });

  it("errors gracefully when no baseUrl is configured", async () => {
    prisma.integration.findFirst.mockResolvedValue({ config: {} });
    const fetchImpl = mockFetch(200, { issues: [] });
    const res = (await jiraSearchIssues({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("base URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("jiraSearchIssues (success)", () => {
  it("composes JQL from projectKey default + Basic auth, returns a shallow shape", async () => {
    const fetchImpl = mockFetch(200, {
      issues: [
        {
          key: "ABC-1",
          fields: {
            summary: "CUI//SP exfil path",
            description: "secret repro",
            status: { name: "In Progress" },
            priority: { name: "High" },
            issuetype: { name: "Bug" },
            assignee: { accountId: "acc-123", displayName: "Jane Doe" },
            created: "c",
            updated: "u",
            resolutiondate: null,
          },
        },
      ],
    });
    const res = (await jiraSearchIssues({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      success: boolean;
      count: number;
      issues: Array<Record<string, unknown>>;
    };

    const [url, init] = fetchImpl.mock.calls[0];
    // baseUrl trailing slash stripped; default project key composed into JQL.
    expect(url).toContain("https://acme.atlassian.net/rest/api/3/search?jql=");
    expect(decodeURIComponent(url)).toContain('project = "ABC" ORDER BY updated DESC');
    expect(url).toContain("maxResults=20");
    expect(init.headers.Authorization).toBe(EXPECTED_BASIC);
    expect(init.method).toBe("GET");

    expect(res.count).toBe(1);
    expect(res.issues[0]).toMatchObject({
      key: "ABC-1",
      status: "In Progress",
      priority: "High",
      issueType: "Bug",
      assigneeAccountId: "acc-123",
    });
    // The token never appears in the returned value.
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("uses a raw jql when provided (overriding the simple filters) + clamps limit", async () => {
    const fetchImpl = mockFetch(200, { issues: [] });
    await jiraSearchIssues(
      { jql: "assignee = currentUser()", projectKey: "ZZZ", limit: 999 },
      { orgId: ORG, userId: USER, fetchImpl },
    );
    const url = fetchImpl.mock.calls[0][0];
    expect(decodeURIComponent(url)).toContain("assignee = currentUser()");
    expect(decodeURIComponent(url)).not.toContain("ZZZ");
    expect(url).toContain("maxResults=50");
  });
});

describe("jiraGetIssue", () => {
  it("requires an issueKey", async () => {
    const res = (await jiraGetIssue({}, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, {}) })) as {
      error?: string;
    };
    expect(res.error).toContain("issueKey");
  });

  it("returns the single issue shape including summary (egress gate withholds it later)", async () => {
    const fetchImpl = mockFetch(200, {
      key: "ABC-42",
      fields: {
        summary: "Title",
        description: "Body text",
        status: { name: "Done" },
        priority: { name: "Low" },
        issuetype: { name: "Task" },
        created: "c",
        updated: "u",
        resolutiondate: "z",
      },
    });
    const res = (await jiraGetIssue({ issueKey: "ABC-42" }, { orgId: ORG, userId: USER, fetchImpl })) as {
      issue: Record<string, unknown>;
    };
    expect(fetchImpl.mock.calls[0][0]).toContain("/rest/api/3/issue/ABC-42");
    expect(res.issue).toMatchObject({
      key: "ABC-42",
      summary: "Title",
      description: "Body text",
      status: "Done",
      issueType: "Task",
      resolutiondate: "z",
    });
  });
});

describe("jiraListProjects", () => {
  it("hits the project search endpoint and returns id/key/projectTypeKey", async () => {
    const fetchImpl = mockFetch(200, {
      values: [{ id: "10000", key: "ABC", name: "Acme", projectTypeKey: "software" }],
    });
    const res = (await jiraListProjects({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      count: number;
      projects: Array<Record<string, unknown>>;
    };
    expect(fetchImpl.mock.calls[0][0]).toContain("/rest/api/3/project/search");
    expect(res.count).toBe(1);
    expect(res.projects[0]).toMatchObject({ id: "10000", key: "ABC", projectTypeKey: "software" });
  });
});

describe("jiraCreateIssue (the one write)", () => {
  it("POSTs the issue with an ADF description and returns the created key only", async () => {
    const fetchImpl = mockFetch(201, { id: "10010", key: "ABC-100" });
    const res = (await jiraCreateIssue(
      { summary: "New task", issueType: "Task", description: "details" },
      { orgId: ORG, userId: USER, fetchImpl },
    )) as { success: boolean; issue: Record<string, unknown> };

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/rest/api/3/issue");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(EXPECTED_BASIC);
    const sent = JSON.parse(init.body as string);
    expect(sent.fields.project.key).toBe("ABC"); // default project key
    expect(sent.fields.summary).toBe("New task");
    expect(sent.fields.issuetype.name).toBe("Task");
    expect(sent.fields.description.type).toBe("doc");

    // The write returns ONLY the created key.
    expect(res.issue).toEqual({ key: "ABC-100" });
  });

  it("requires summary + issueType", async () => {
    const r1 = (await jiraCreateIssue({ issueType: "Task" }, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, {}) })) as { error?: string };
    expect(r1.error).toContain("summary");
    const r2 = (await jiraCreateIssue({ summary: "x" }, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, {}) })) as { error?: string };
    expect(r2.error).toContain("issueType");
  });
});

describe("API error handling (graceful, token-free)", () => {
  it("a 401 (bad credential) becomes a clean error with no token leak", async () => {
    const fetchImpl = mockFetch(401, { errorMessages: ["Client must be authenticated"] });
    const res = (await jiraSearchIssues({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("HTTP 401");
    expect(res.error).toContain("authenticated");
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("a thrown fetch (network failure) is caught → graceful error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = (await jiraListProjects({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("dispatch", () => {
  it("JIRA_TOOL_NAMES lists exactly the four tools", () => {
    expect([...JIRA_TOOL_NAMES].sort()).toEqual(
      ["jira_create_issue", "jira_get_issue", "jira_list_projects", "jira_search_issues"].sort(),
    );
  });

  it("executeJiraTool returns null for a non-jira tool", async () => {
    expect(await executeJiraTool("send_email", {}, { orgId: ORG, userId: USER })).toBeNull();
  });
});

describe("PROJECTION CONTRACT — a gov jira_issue is structural-only", () => {
  it("projects key/status/priority/issueType/timestamps; summary/description WITHHELD", () => {
    const issue = {
      key: "ABC-1",
      summary: "CUI//SP exfil path",
      description: "secret repro",
      status: "In Progress",
      priority: "High",
      issueType: "Bug",
      assigneeAccountId: "acc-123",
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-02T00:00:00Z",
      resolutiondate: null,
    };
    const mv = projectStructural(issue, "jira_issue") as Record<string, unknown>;
    expect(mv).toEqual({
      key: "ABC-1",
      status: "In Progress",
      priority: "High",
      issueType: "Bug",
      assigneeAccountId: "acc-123",
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-02T00:00:00Z",
      // resolutiondate is null → dropped by the projector
    });
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("secret");
  });

  it("a gov jira_project exposes id/key/projectTypeKey; name WITHHELD", () => {
    const project = { id: "10000", key: "ABC", name: "Acme Secret Program", projectTypeKey: "software" };
    const mv = projectStructural(project, "jira_project") as Record<string, unknown>;
    expect(mv).toEqual({ id: "10000", key: "ABC", projectTypeKey: "software" });
    expect(JSON.stringify(mv)).not.toContain("Secret");
  });
});
