// SECURITY: executeTool hands connector dispatch what it needs to decide: the
// tools the model was offered and the caller's own auth. A connector write that
// succeeded is audit-logged; the Nango proxy only when it wrote.
import { describe, it, expect, vi, beforeEach } from "vitest";

const executeConnectorTool = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const logAudit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./connectors", async (importOriginal) => ({ ...(await importOriginal<object>()), executeConnectorTool }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { executeTool } from "./tool-executor";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const auth = { userId: "u", orgId: "o", orgRole: "MEMBER", permissions: RolePermissions.MEMBER, basePermissions: RolePermissions.MEMBER, abacRules: [] } as AuthContext;
const ctx = (name: string) => ({ orgId: "o", userId: "u", auth, offered: new Set([name]), tenantClass: "commercial" as const });

beforeEach(() => {
  executeConnectorTool.mockClear();
  logAudit.mockClear();
});

describe("executeTool → connector dispatch", () => {
  it("passes the offered set and the caller's auth through", async () => {
    const c = ctx("github_list_issues");
    await executeTool("github_list_issues", { repo: "a/b" }, c);
    expect(executeConnectorTool).toHaveBeenCalledWith(
      "github_list_issues", { repo: "a/b" }, expect.objectContaining({ orgId: "o", userId: "u", offered: c.offered, auth }),
    );
  });

  it("audits a successful connector write (slack_post_message, jira_create_issue)", async () => {
    await executeTool("slack_post_message", { channel: "c1", text: "hi" }, ctx("slack_post_message"));
    await executeTool("jira_create_issue", { project: "P", summary: "s" }, ctx("jira_create_issue"));
    expect((logAudit.mock.calls as unknown as [{ action: string }][]).map((c) => c[0].action)).toEqual([
      "assistant.slack_message.posted", "assistant.jira_issue.created",
    ]);
  });

  it("audits the Nango proxy only when it wrote", async () => {
    await executeTool("nango_proxy_request", { method: "GET", endpoint: "/x" }, ctx("nango_proxy_request"));
    expect(logAudit).not.toHaveBeenCalled();
    await executeTool("nango_proxy_request", { method: "POST", endpoint: "/x" }, ctx("nango_proxy_request"));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "assistant.nango_request.sent" }));
  });

  it("doesn't audit a refused call", async () => {
    executeConnectorTool.mockResolvedValueOnce({ error: "You don't have permission to use slack_post_message." } as never);
    await executeTool("slack_post_message", { channel: "c1", text: "hi" }, ctx("slack_post_message"));
    expect(logAudit).not.toHaveBeenCalled();
  });
});
