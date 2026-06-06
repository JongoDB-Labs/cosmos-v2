import type { ToolDefinition } from "../tools";

const FRAMEWORKS = ["NIST_800_171", "CMMC_L2", "NIST_800_53", "FEDRAMP_MOD", "CUSTOM"];
const STATUSES = ["NOT_ASSESSED", "IN_PROGRESS", "IMPLEMENTED", "PARTIALLY_IMPLEMENTED", "NOT_APPLICABLE", "FAILED"];

export const complianceTools: ToolDefinition[] = [
  {
    name: "query_compliance_controls",
    description:
      "Run a compliance check: list the org's controls (NIST 800-171 / CMMC L2 etc.), optionally filtered by framework or status. Pass status='FAILED' to find controls that need remediation. Returns a per-status summary plus the matching controls.",
    input_schema: {
      type: "object",
      properties: {
        framework: { type: "string", enum: FRAMEWORKS, description: "Filter by framework" },
        status: { type: "string", enum: STATUSES, description: "Filter by status (e.g. FAILED to find gaps)" },
        limit: { type: "number", description: "Max controls returned (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "update_compliance_control",
    description:
      "Update a compliance control to drive remediation — set its status, append a POA&M note, set a due date, or attach evidence. Example: open remediation by setting a FAILED control to IN_PROGRESS with a note and a dueDate. Identify the control by its controlId (e.g. '3.11.2' or 'AC.L2-3.1.1') and optionally framework.",
    input_schema: {
      type: "object",
      properties: {
        controlId: { type: "string", description: "Control identifier, e.g. '3.11.2'" },
        framework: { type: "string", enum: FRAMEWORKS, description: "Disambiguate if the id exists in multiple frameworks" },
        status: { type: "string", enum: STATUSES },
        notes: { type: "string", description: "POA&M / remediation note" },
        dueDate: { type: "string", description: "Remediation due date (YYYY-MM-DD or ISO)" },
      },
      required: ["controlId"],
    },
  },
  {
    name: "list_org_members",
    description:
      "List the people in this organization (name, email, role) so you can assign work or notify the right person — e.g. find the ISSO / security lead (an ADMIN) to assign a remediation task to and email.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];
