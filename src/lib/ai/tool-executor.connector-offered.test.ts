// SECURITY: executeTool hands connector dispatch the set of tools the model was
// offered, which dispatch requires (it refuses a call without it).
import { describe, it, expect, vi } from "vitest";

const executeConnectorTool = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("./connectors", async (importOriginal) => ({ ...(await importOriginal<object>()), executeConnectorTool }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { executeTool } from "./tool-executor";

describe("executeTool → connector dispatch", () => {
  it("passes the offered set through", async () => {
    const offered = new Set(["github_list_issues"]);
    await executeTool("github_list_issues", { repo: "a/b" }, { orgId: "o", userId: "u", offered, tenantClass: "commercial" });
    expect(executeConnectorTool).toHaveBeenCalledWith(
      "github_list_issues", { repo: "a/b" }, expect.objectContaining({ orgId: "o", userId: "u", offered }),
    );
  });
});
