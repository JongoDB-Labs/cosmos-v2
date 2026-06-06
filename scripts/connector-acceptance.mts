// Docker-acceptance smoke for the connector registry (run INSIDE the build image,
// against the containerized Postgres). Proves, against the EXACT committed source:
//   1. executeTool routes a GitHub tool name → the GitHub connector executor
//      (graceful "not connected" {error} = it routed; nothing threw to the loop).
//   2. executeTool routes a Google tool name → the Google connector executor
//      (graceful "not connected" {error} = it routed).
//   3. A gov GitHub result is STILL structural-only: projectResult(github_issue)
//      keeps number/state/timestamps and DROPS the CUI title/body — the egress
//      contract is unchanged by the refactor.
//   4. The registry owns exactly the google ∪ github tool names; a native tool
//      (create_note) is NOT a connector tool (still dispatched by the native switch).
import { executeTool } from "@/lib/ai/tool-executor";
import { connectorToolNames } from "@/lib/ai/connectors/index";
import { projectResult } from "@/lib/ai/egress/projection";

const ctx = { orgId: "00000000-0000-0000-0000-0000000000ac", userId: "00000000-0000-0000-0000-0000000000ad" };
let failures = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
};

// 1. GitHub routing.
const gh = (await executeTool("github_list_issues", {}, ctx)) as Record<string, unknown>;
ok("github_list_issues routed to GitHub connector (graceful error, not a throw)",
   typeof gh === "object" && gh !== null && typeof gh.error === "string", gh);

// 2. Google routing.
const goog = (await executeTool("search_contacts", { query: "x" }, ctx)) as Record<string, unknown>;
ok("search_contacts routed to Google connector (graceful error, not a throw)",
   typeof goog === "object" && goog !== null && typeof goog.error === "string", goog);

// 3. Gov GitHub result is structural-only.
const issueResult = {
  success: true, count: 1,
  issues: [{
    number: 42, state: "open",
    title: "CUI//SP exfil path in sensor fusion", body: "secret repro steps",
    labels: ["bug"], createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z", closedAt: null,
  }],
};
const gov = projectResult(issueResult, "github_issue");
const govStr = JSON.stringify(gov);
ok("gov github issue: number+state survive", govStr.includes("42") && govStr.includes("open"));
ok("gov github issue: CUI title WITHHELD", !govStr.includes("CUI") && !govStr.includes("exfil"));
ok("gov github issue: body WITHHELD", !govStr.includes("secret repro"));
ok("gov github issue: labels dropped", !govStr.includes("bug"));
console.log("    gov modelView =", govStr);

// 4. Registry ownership boundary.
const names = connectorToolNames();
ok("registry owns github_list_issues", names.has("github_list_issues"));
ok("registry owns search_contacts (google)", names.has("search_contacts"));
ok("registry does NOT own native create_note", !names.has("create_note"));
ok("registry tool count == 11 google + 3 github = 14", names.size === 14, names.size);

console.log(failures === 0 ? "\nALL CONNECTOR-ACCEPTANCE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
